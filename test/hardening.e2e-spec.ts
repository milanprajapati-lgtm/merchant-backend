import { RiskReconciler } from '../src/risk/risk.reconciler';
import { UserRole } from '../src/users/user.entity';
import {
  Actors, TEST_PASSWORD, TestApp, applicationInReview, bearer, createApplication, createTestApp,
  createUser, resetApplications, runRiskJob, seedActors, submitApplication,
} from './helpers';

/** Regression tests for issues found in code review. */
describe('Review hardening (e2e)', () => {
  let t: TestApp;
  let actors: Actors;

  beforeAll(async () => {
    t = await createTestApp();
    actors = await seedActors(t);
  });
  beforeEach(async () => {
    await resetApplications(t.dataSource);
    t.queue.jobs = [];
    t.queue.failedJobIds.clear();
  });
  afterAll(() => t?.app.close());

  const patch = (token: string, id: string, body: Record<string, unknown>) =>
    t.http().patch(`/api/applications/${id}`).set(bearer(token)).send(body);
  const get = (token: string, id: string) => t.http().get(`/api/applications/${id}`).set(bearer(token));

  describe('PATCH never turns a client mistake into a 500', () => {
    it.each(['businessName', 'legalBusinessName', 'businessType', 'ownerName', 'contactEmail', 'requestedMonthlyVolume'])(
      'rejects %s: null with 400 and leaves the application unchanged',
      async (field) => {
        const app = await createApplication(t, actors.sales1.token);
        const res = await patch(actors.sales1.token, app.id, { [field]: null }).expect(400);
        expect(res.body.message).toContain(field);
        const stored = (await get(actors.sales1.token, app.id).expect(200)).body;
        expect(stored[field]).toBe(app[field]);
      },
    );

    it('still accepts a normal partial update and an empty body', async () => {
      const app = await createApplication(t, actors.sales1.token);
      const updated = (await patch(actors.sales1.token, app.id, { businessName: 'Renamed Cafe' }).expect(200)).body;
      expect(updated.businessName).toBe('Renamed Cafe');
      await patch(actors.sales1.token, app.id, {}).expect(200);
    });
  });

  describe('detailed risk result is not exposed to SALES', () => {
    it('SALES sees riskStatus but riskResult is null; ADMIN and the assigned REVIEWER see the detail', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id, { legalBusinessName: 'Sanctioned Traders LLC' });

      const asSales = (await get(actors.sales1.token, id).expect(200)).body;
      expect(asSales.riskStatus).toBe('FLAGGED');
      expect(asSales.riskResult).toBeNull();
      expect(JSON.stringify(asSales)).not.toContain('WATCHLIST_MATCH');

      for (const token of [actors.admin.token, actors.reviewer1.token]) {
        const body = (await get(token, id).expect(200)).body;
        expect(body.riskResult.reasons).toContain('WATCHLIST_MATCH');
      }
    });

    it('is hidden on every SALES response shape: create, update, submit and list', async () => {
      const created = await createApplication(t, actors.sales1.token);
      expect(created.riskResult).toBeNull();
      expect((await patch(actors.sales1.token, created.id, { businessName: 'Another Name' }).expect(200)).body.riskResult).toBeNull();
      expect((await submitApplication(t, actors.sales1.token, created.id).expect(202)).body.riskResult).toBeNull();
      await runRiskJob(t);

      const list = (await t.http().get('/api/applications').set(bearer(actors.sales1.token)).expect(200)).body;
      expect(list.items).toHaveLength(1);
      expect(list.items[0].riskStatus).toBe('CLEAR');
      expect(list.items[0].riskResult).toBeNull();
    });
  });

  describe('login is case-insensitive and deterministic', () => {
    it('accepts an upper-cased email', async () => {
      await t.http().post('/api/auth/login').send({ email: 'SALES1@Example.Test', password: TEST_PASSWORD }).expect(200);
    });

    it('stores emails lowercased so two accounts cannot differ only by case', async () => {
      const user = await createUser(t.dataSource, 'Mixed.Case@Example.Test', UserRole.SALES);
      expect(user.email).toBe('mixed.case@example.test');
      await expect(createUser(t.dataSource, 'MIXED.CASE@example.test', UserRole.SALES)).rejects.toThrow(/duplicate key|unique/i);
    });
  });

  describe('RiskReconciler heals applications stuck in PENDING', () => {
    const ageSubmission = (id: string, minutes: number) =>
      t.dataSource.query(`UPDATE merchant_applications SET submitted_at = now() - ($2 || ' minutes')::interval WHERE id = $1`, [id, minutes]);

    it('re-enqueues the same job when the enqueue was lost after the DB commit', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await submitApplication(t, actors.sales1.token, app.id).expect(202);
      const original = t.queue.last;
      t.queue.jobs = []; // simulate: the process died after commit, so the job never reached Redis
      await ageSubmission(app.id, 30);

      await expect(t.app.get(RiskReconciler).reconcile(5 * 60_000)).resolves.toBe(1);
      expect(t.queue.last.opts.jobId).toBe(original.opts.jobId);

      // the recovered job completes the application through the normal idempotent worker
      await runRiskJob(t);
      expect((await get(actors.admin.token, app.id).expect(200)).body.riskStatus).toBe('CLEAR');
    });

    it('does not touch recent submissions or applications whose job is alive', async () => {
      const fresh = await createApplication(t, actors.sales1.token);
      await submitApplication(t, actors.sales1.token, fresh.id).expect(202);
      const alive = await createApplication(t, actors.sales1.token);
      await submitApplication(t, actors.sales1.token, alive.id).expect(202);
      await ageSubmission(alive.id, 30);
      const before = t.queue.jobs.length;

      await expect(t.app.get(RiskReconciler).reconcile(5 * 60_000)).resolves.toBe(0);
      expect(t.queue.jobs).toHaveLength(before);
    });

    it('replaces a dead job parked in the failed set', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await submitApplication(t, actors.sales1.token, app.id).expect(202);
      t.queue.failedJobIds.add(t.queue.last.opts.jobId);
      await ageSubmission(app.id, 30);

      await expect(t.app.get(RiskReconciler).reconcile(5 * 60_000)).resolves.toBe(1);
      expect(t.queue.jobs).toHaveLength(1);
      expect(t.queue.failedJobIds.size).toBe(0);
    });

    it('ignores applications that already have a final risk result', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await submitApplication(t, actors.sales1.token, app.id).expect(202);
      await runRiskJob(t);
      await ageSubmission(app.id, 30);
      t.queue.jobs = [];
      await expect(t.app.get(RiskReconciler).reconcile(5 * 60_000)).resolves.toBe(0);
    });
  });
});
