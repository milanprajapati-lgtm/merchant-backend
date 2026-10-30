import {
  Actors, TestApp, applicationInReview, assignReviewer, bearer, createApplication, createTestApp,
  decide, resetApplications, seedActors, submitApplication,
} from './helpers';

/**
 * Object-level authorization. These are the tests that must never regress: every case
 * tries to reach or change an application that belongs to somebody else.
 */
describe('Object-level authorization (e2e)', () => {
  let t: TestApp;
  let actors: Actors;
  const missingId = '3f2c0e3a-3b0a-4a76-9d7a-0d4a8f3c9f11';

  beforeAll(async () => {
    t = await createTestApp();
    actors = await seedActors(t);
  });
  beforeEach(async () => {
    await resetApplications(t.dataSource);
    t.queue.jobs = [];
  });
  afterAll(() => t?.app.close());

  describe('SALES isolation', () => {
    it('sales2 cannot READ sales1 application by id (404, indistinguishable from a missing id)', async () => {
      const app = await createApplication(t, actors.sales1.token);
      const foreign = await t.http().get(`/api/applications/${app.id}`).set(bearer(actors.sales2.token)).expect(404);
      const missing = await t.http().get(`/api/applications/${missingId}`).set(bearer(actors.sales2.token)).expect(404);
      expect(foreign.body.message).toBe(missing.body.message);
      expect(JSON.stringify(foreign.body)).not.toContain('Acme');
    });

    it('sales2 cannot UPDATE sales1 application by id, and nothing changes', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await t.http().patch(`/api/applications/${app.id}`).set(bearer(actors.sales2.token)).send({ businessName: 'Hijacked' }).expect(404);
      const stored = await t.http().get(`/api/applications/${app.id}`).set(bearer(actors.sales1.token)).expect(200);
      expect(stored.body.businessName).toBe('Acme Coffee');
    });

    it('sales2 cannot SUBMIT sales1 application, and no risk job is enqueued', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await submitApplication(t, actors.sales2.token, app.id).expect(404);
      expect(t.queue.jobs).toHaveLength(0);
      const stored = await t.http().get(`/api/applications/${app.id}`).set(bearer(actors.sales1.token)).expect(200);
      expect(stored.body.status).toBe('DRAFT');
    });

    it('sales2 list never includes sales1 applications', async () => {
      await createApplication(t, actors.sales1.token);
      const own = await createApplication(t, actors.sales2.token);
      const res = await t.http().get('/api/applications').set(bearer(actors.sales2.token)).expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items.map((i: any) => i.id)).toEqual([own.id]);
    });

    it('a status filter cannot be used to widen the scope', async () => {
      await createApplication(t, actors.sales1.token);
      const res = await t.http().get('/api/applications?status=DRAFT').set(bearer(actors.sales2.token)).expect(200);
      expect(res.body.total).toBe(0);
    });

    it('sales users cannot read the audit trail at all', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await t.http().get(`/api/applications/${app.id}/audit`).set(bearer(actors.sales1.token)).expect(403);
    });

    it('the owner can read and edit their own application', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await t.http().get(`/api/applications/${app.id}`).set(bearer(actors.sales1.token)).expect(200);
      const res = await t.http().patch(`/api/applications/${app.id}`).set(bearer(actors.sales1.token)).send({ businessName: 'Renamed' }).expect(200);
      expect(res.body.businessName).toBe('Renamed');
    });

    it('ADMIN can read and edit any application', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await t.http().get(`/api/applications/${app.id}`).set(bearer(actors.admin.token)).expect(200);
      await t.http().patch(`/api/applications/${app.id}`).set(bearer(actors.admin.token)).send({ businessName: 'By admin' }).expect(200);
    });
  });

  describe('mass assignment', () => {
    it.each([
      ['createdById', 'someone-else'],
      ['status', 'APPROVED'],
      ['riskStatus', 'CLEAR'],
      ['assignedReviewerId', '3f2c0e3a-3b0a-4a76-9d7a-0d4a8f3c9f11'],
      ['submissionVersion', 99],
      ['id', '3f2c0e3a-3b0a-4a76-9d7a-0d4a8f3c9f11'],
    ])('rejects client-supplied %s on create', async (field, value) => {
      await t.http().post('/api/applications').set(bearer(actors.sales1.token))
        .send({ businessName: 'X Shop', legalBusinessName: 'X Shop LLC', businessType: 'LLC', ownerName: 'Jo Doe', contactEmail: 'jo@example.test', requestedMonthlyVolume: '10.00', requestedAverageTransaction: '5.00', [field]: value })
        .expect(400);
    });

    it('rejects client-supplied workflow fields on update', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await t.http().patch(`/api/applications/${app.id}`).set(bearer(actors.sales1.token)).send({ status: 'APPROVED' }).expect(400);
      await t.http().patch(`/api/applications/${app.id}`).set(bearer(actors.sales1.token)).send({ createdById: actors.sales2.id }).expect(400);
    });

    it('always records the authenticated user as creator', async () => {
      const app = await createApplication(t, actors.sales1.token);
      expect(app.createdById).toBe(actors.sales1.id);
    });
  });

  describe('REVIEWER scoping', () => {
    it('an unassigned reviewer cannot read, list or decide another reviewer\'s application', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id);
      await t.http().get(`/api/applications/${id}`).set(bearer(actors.reviewer2.token)).expect(404);
      await t.http().get(`/api/applications/${id}/audit`).set(bearer(actors.reviewer2.token)).expect(404);
      const list = await t.http().get('/api/applications').set(bearer(actors.reviewer2.token)).expect(200);
      expect(list.body.total).toBe(0);
      await decide(t, actors.reviewer2.token, id, 'APPROVED').expect(404);
      await decide(t, actors.reviewer2.token, id, 'REJECTED').expect(404);

      const after = await t.http().get(`/api/applications/${id}`).set(bearer(actors.admin.token)).expect(200);
      expect(after.body.status).toBe('IN_REVIEW');
      expect(after.body.decidedById).toBeNull();
    });

    it('only the assigned reviewer can decide', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id);
      const res = await decide(t, actors.reviewer1.token, id, 'APPROVED', 'ok').expect(200);
      expect(res.body).toMatchObject({ status: 'APPROVED', decidedById: actors.reviewer1.id });
    });

    it('a reviewer who is reassigned away immediately loses access', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id);
      await assignReviewer(t, actors.admin.token, id, actors.reviewer2.id).expect(200);
      await decide(t, actors.reviewer1.token, id, 'APPROVED').expect(404);
      await t.http().get(`/api/applications/${id}`).set(bearer(actors.reviewer1.token)).expect(404);
      await decide(t, actors.reviewer2.token, id, 'APPROVED').expect(200);
    });

    it('a reviewer cannot edit, submit or assign', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id);
      await t.http().patch(`/api/applications/${id}`).set(bearer(actors.reviewer1.token)).send({ businessName: 'x1' }).expect(403);
      await submitApplication(t, actors.reviewer1.token, id).expect(403);
      await assignReviewer(t, actors.reviewer1.token, id, actors.reviewer1.id).expect(403);
    });

    it('ADMIN cannot record a decision, even with full operational access (ADR-001)', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id);
      await decide(t, actors.admin.token, id, 'APPROVED').expect(403);
      await decide(t, actors.admin.token, id, 'REJECTED').expect(403);
    });

    it('the owning SALES user cannot approve their own application', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id);
      await decide(t, actors.sales1.token, id, 'APPROVED').expect(403);
    });

    it('reviewer list only shows applications assigned to that reviewer', async () => {
      const mine = await applicationInReview(t, actors, actors.reviewer1.id);
      await applicationInReview(t, actors, actors.reviewer2.id);
      const res = await t.http().get('/api/applications').set(bearer(actors.reviewer1.token)).expect(200);
      expect(res.body.items.map((i: any) => i.id)).toEqual([mine]);
    });
  });

  describe('reviewer assignment integrity', () => {
    it('cannot assign a user who is not a REVIEWER (sales, admin) or does not exist', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await submitApplication(t, actors.sales1.token, app.id).expect(202);
      await assignReviewer(t, actors.admin.token, app.id, actors.sales2.id).expect(400);
      await assignReviewer(t, actors.admin.token, app.id, actors.admin.id).expect(400);
      await assignReviewer(t, actors.admin.token, app.id, missingId).expect(400);
      const stored = await t.http().get(`/api/applications/${app.id}`).set(bearer(actors.admin.token)).expect(200);
      expect(stored.body.assignedReviewerId).toBeNull();
    });

    it('cannot assign a deactivated reviewer', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await submitApplication(t, actors.sales1.token, app.id).expect(202);
      await t.dataSource.query('UPDATE users SET is_active = false WHERE id = $1', [actors.reviewer2.id]);
      await assignReviewer(t, actors.admin.token, app.id, actors.reviewer2.id).expect(400);
      await t.dataSource.query('UPDATE users SET is_active = true WHERE id = $1', [actors.reviewer2.id]);
    });
  });

  describe('input hardening', () => {
    it('non-uuid ids are rejected before reaching the database', async () => {
      await t.http().get('/api/applications/not-a-uuid').set(bearer(actors.admin.token)).expect(400);
      await t.http().get("/api/applications/1' OR '1'='1").set(bearer(actors.admin.token)).expect(400);
    });

    it('filters are validated, not interpolated', async () => {
      await t.http().get("/api/applications?status=DRAFT' OR 1=1 --").set(bearer(actors.admin.token)).expect(400);
      await t.http().get('/api/applications?limit=1000').set(bearer(actors.admin.token)).expect(400);
      await t.http().get('/api/applications?page=0').set(bearer(actors.admin.token)).expect(400);
    });
  });
});
