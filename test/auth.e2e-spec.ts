import { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Actors, TEST_PASSWORD, TestApp, bearer, createApplication, createTestApp, createUser, seedActors } from './helpers';
import { UserRole } from '../src/users/user.entity';

describe('Authentication (e2e)', () => {
  let t: TestApp;
  let actors: Actors;

  beforeAll(async () => {
    t = await createTestApp();
    actors = await seedActors(t);
  });
  afterAll(() => t?.app.close());

  it('GET /api/health is public', async () => {
    await t.http().get('/api/health').expect(200).expect({ status: 'ok', service: 'merchant-backend' });
  });

  it('generates the OpenAPI document with bearer auth and the main routes', () => {
    const doc = SwaggerModule.createDocument(t.app, new DocumentBuilder().addBearerAuth().build());
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/auth/login',
        '/api/applications',
        '/api/applications/{id}',
        '/api/applications/{id}/submit',
        '/api/applications/{id}/assign-reviewer',
        '/api/applications/{id}/decision',
      ]),
    );
    expect(doc.paths['/api/applications']?.get?.security).toEqual([{ bearer: [] }]);
  });

  describe('POST /api/auth/login', () => {
    it('issues a bearer token and never returns the password hash', async () => {
      const res = await t.http().post('/api/auth/login').send({ email: 'sales1@example.test', password: TEST_PASSWORD }).expect(200);
      expect(res.body).toMatchObject({ tokenType: 'Bearer', user: { email: 'sales1@example.test', role: 'SALES' } });
      expect(typeof res.body.accessToken).toBe('string');
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|password_hash|\$2[aby]\$/);
    });

    it('is case-insensitive on email', async () => {
      await t.http().post('/api/auth/login').send({ email: 'SALES1@Example.Test', password: TEST_PASSWORD }).expect(200);
    });

    it('returns the same 401 for a wrong password and an unknown email', async () => {
      const wrongPassword = await t.http().post('/api/auth/login').send({ email: 'sales1@example.test', password: 'definitely-wrong-1' }).expect(401);
      const unknownEmail = await t.http().post('/api/auth/login').send({ email: 'nobody@example.test', password: 'definitely-wrong-1' }).expect(401);
      expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
    });

    it('rejects malformed bodies with the standard error shape', async () => {
      const res = await t.http().post('/api/auth/login').send({ email: 'not-an-email', password: 'x' }).expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request', path: '/api/auth/login' });
      expect(Array.isArray(res.body.message)).toBe(true);
    });

    it('does not authenticate deactivated users', async () => {
      await createUser(t.dataSource, 'inactive@example.test', UserRole.SALES, false);
      await t.http().post('/api/auth/login').send({ email: 'inactive@example.test', password: TEST_PASSWORD }).expect(401);
    });
  });

  describe('JWT route protection', () => {
    it.each([
      ['GET', '/api/applications'],
      ['POST', '/api/applications'],
      ['GET', '/api/applications/3f2c0e3a-3b0a-4a76-9d7a-0d4a8f3c9f11'],
      ['GET', '/api/auth/me'],
    ])('%s %s requires a token', async (method, url) => {
      await (t.http() as any)[method.toLowerCase()](url).expect(401);
    });

    it('rejects garbage tokens and tokens signed with another secret', async () => {
      await t.http().get('/api/auth/me').set(bearer('not.a.jwt')).expect(401);
      const forged = new JwtService({ secret: 'some-other-secret-that-is-long-enough-123' }).sign({ sub: actors.admin.id });
      await t.http().get('/api/auth/me').set(bearer(forged)).expect(401);
    });

    it('rejects expired tokens', async () => {
      const expired = await t.app.get(JwtService).signAsync({ sub: actors.admin.id }, { expiresIn: '-10s' });
      await t.http().get('/api/auth/me').set(bearer(expired)).expect(401);
    });

    it('rejects tokens with alg=none', async () => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: actors.admin.id })}.`;
      await t.http().get('/api/auth/me').set(bearer(none)).expect(401);
    });

    it('trusts the database, not the token: a deactivated user is locked out immediately', async () => {
      const victim = await createUser(t.dataSource, 'soon-gone@example.test', UserRole.SALES);
      const token = (await t.http().post('/api/auth/login').send({ email: victim.email, password: TEST_PASSWORD }).expect(200)).body.accessToken;
      await t.http().get('/api/auth/me').set(bearer(token)).expect(200);
      await t.dataSource.query('UPDATE users SET is_active = false WHERE id = $1', [victim.id]);
      await t.http().get('/api/auth/me').set(bearer(token)).expect(401);
    });

    it('a role change in the database applies to existing tokens (no stale role claim)', async () => {
      const user = await createUser(t.dataSource, 'demoted@example.test', UserRole.ADMIN);
      const token = (await t.http().post('/api/auth/login').send({ email: user.email, password: TEST_PASSWORD }).expect(200)).body.accessToken;
      await t.dataSource.query(`UPDATE users SET role = 'SALES' WHERE id = $1`, [user.id]);
      const me = await t.http().get('/api/auth/me').set(bearer(token)).expect(200);
      expect(me.body.role).toBe('SALES');
    });
  });

  describe('role-based access (route level)', () => {
    it('SALES and ADMIN can create; REVIEWER cannot', async () => {
      await createApplication(t, actors.sales1.token);
      await createApplication(t, actors.admin.token);
      await t.http().post('/api/applications').set(bearer(actors.reviewer1.token)).send({}).expect(403);
    });

    it('only ADMIN can assign reviewers', async () => {
      const app = await createApplication(t, actors.sales1.token);
      const url = `/api/applications/${app.id}/assign-reviewer`;
      await t.http().post(url).set(bearer(actors.sales1.token)).send({ reviewerId: actors.reviewer1.id }).expect(403);
      await t.http().post(url).set(bearer(actors.reviewer1.token)).send({ reviewerId: actors.reviewer1.id }).expect(403);
    });

    it('SALES cannot approve (decision endpoint is reviewer-only)', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await t.http().post(`/api/applications/${app.id}/decision`).set(bearer(actors.sales1.token)).send({ decision: 'APPROVED' }).expect(403);
    });
  });
});
