import {
  Actors, TestApp, applicationInReview, assignReviewer, bearer, createApplication, createTestApp,
  decide, resetApplications, runRiskJob, seedActors, submitApplication, validPayload,
} from './helpers';

describe('Application lifecycle (e2e)', () => {
  let t: TestApp;
  let actors: Actors;

  beforeAll(async () => {
    t = await createTestApp();
    actors = await seedActors(t);
  });
  beforeEach(async () => {
    await resetApplications(t.dataSource);
    t.queue.jobs = [];
    t.queue.failNextAdd = false;
  });
  afterAll(() => t?.app.close());

  const get = (token: string, id: string) => t.http().get(`/api/applications/${id}`).set(bearer(token));

  describe('create / validate', () => {
    it('creates a DRAFT with risk NOT_STARTED and no reviewer', async () => {
      const app = await createApplication(t, actors.sales1.token);
      expect(app).toMatchObject({
        status: 'DRAFT', riskStatus: 'NOT_STARTED', assignedReviewerId: null, submissionVersion: 0,
        businessName: 'Acme Coffee', ownerName: 'Jane Doe', contactEmail: 'jane.doe@example.test',
      });
      expect(app.createdAt).toBeDefined();
      expect(app.updatedAt).toBeDefined();
    });

    it.each([
      ['businessName too short', { businessName: 'A' }],
      ['invalid business type', { businessType: 'WIZARD' }],
      ['invalid email', { contactEmail: 'nope' }],
      ['negative volume', { requestedMonthlyVolume: '-5' }],
      ['zero volume', { requestedMonthlyVolume: '0.00' }],
      ['exponent notation', { requestedMonthlyVolume: '1e9' }],
      ['too many decimals', { requestedAverageTransaction: '1.234' }],
      ['numeric (not string) amount', { requestedMonthlyVolume: 25000 }],
    ])('rejects %s', async (_name, over) => {
      await t.http().post('/api/applications').set(bearer(actors.sales1.token)).send(validPayload(over)).expect(400);
    });
  });

  describe('state machine', () => {
    it('submit -> SUBMITTED / risk PENDING and enqueues exactly one deduplicated job with retry policy', async () => {
      const app = await createApplication(t, actors.sales1.token);
      const res = await submitApplication(t, actors.sales1.token, app.id).expect(202);
      expect(res.body).toMatchObject({ status: 'SUBMITTED', riskStatus: 'PENDING', submissionVersion: 1 });
      expect(t.queue.jobs).toHaveLength(1);
      expect(t.queue.last).toMatchObject({
        name: 'check-application',
        data: { applicationId: app.id, submissionVersion: 1 },
        opts: { jobId: `risk-${app.id}-1`, attempts: 3, backoff: { type: 'exponential', delay: 50 } },
      });
      // No PII in the queue payload.
      expect(JSON.stringify(t.queue.last)).not.toMatch(/jane|example\.test/i);
    });

    it('cannot edit or re-submit once submitted (409)', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await submitApplication(t, actors.sales1.token, app.id).expect(202);
      await t.http().patch(`/api/applications/${app.id}`).set(bearer(actors.sales1.token)).send({ businessName: 'Changed' }).expect(409);
      await submitApplication(t, actors.sales1.token, app.id).expect(409);
      expect(t.queue.jobs).toHaveLength(1);
    });

    it('concurrent submits: exactly one wins and exactly one job is enqueued', async () => {
      const app = await createApplication(t, actors.sales1.token);
      const results = await Promise.all([1, 2, 3, 4].map(() => submitApplication(t, actors.sales1.token, app.id)));
      expect(results.map((r) => r.status).sort()).toEqual([202, 409, 409, 409]);
      expect(t.queue.jobs).toHaveLength(1);
    });

    it('cannot assign a reviewer before submission', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await assignReviewer(t, actors.admin.token, app.id, actors.reviewer1.id).expect(409);
    });

    it('assigning moves SUBMITTED -> IN_REVIEW and can be changed (reassignment)', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await submitApplication(t, actors.sales1.token, app.id).expect(202);
      const first = await assignReviewer(t, actors.admin.token, app.id, actors.reviewer1.id).expect(200);
      expect(first.body).toMatchObject({ status: 'IN_REVIEW', assignedReviewerId: actors.reviewer1.id });
      const second = await assignReviewer(t, actors.admin.token, app.id, actors.reviewer2.id).expect(200);
      expect(second.body.assignedReviewerId).toBe(actors.reviewer2.id);
    });

    it('cannot decide before a reviewer is assigned (nobody is allowed to)', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await submitApplication(t, actors.sales1.token, app.id).expect(202);
      await decide(t, actors.reviewer1.token, app.id, 'REJECTED').expect(404);
    });

    it('cannot decide a DRAFT even by the assigned reviewer (invalid transition)', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await t.dataSource.query('UPDATE merchant_applications SET assigned_reviewer_id = $1 WHERE id = $2', [actors.reviewer1.id, app.id]);
      await decide(t, actors.reviewer1.token, app.id, 'REJECTED').expect(409);
    });

    it('cannot approve until the async risk check has produced CLEAR', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id, {}, false);
      const res = await decide(t, actors.reviewer1.token, id, 'APPROVED').expect(409);
      expect(res.body.message).toMatch(/PENDING/);
      await runRiskJob(t);
      await decide(t, actors.reviewer1.token, id, 'APPROVED').expect(200);
    });

    it('cannot approve a FLAGGED application, but can reject it', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id, { requestedMonthlyVolume: '900000.00' });
      expect((await get(actors.admin.token, id)).body.riskStatus).toBe('FLAGGED');
      await decide(t, actors.reviewer1.token, id, 'APPROVED').expect(409);
      const res = await decide(t, actors.reviewer1.token, id, 'REJECTED', 'volume too high').expect(200);
      expect(res.body.status).toBe('REJECTED');
    });

    it('APPROVED and REJECTED are terminal', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id);
      await decide(t, actors.reviewer1.token, id, 'APPROVED').expect(200);
      await decide(t, actors.reviewer1.token, id, 'REJECTED').expect(409);
      await t.http().patch(`/api/applications/${id}`).set(bearer(actors.sales1.token)).send({ businessName: 'Late edit' }).expect(409);
      await submitApplication(t, actors.sales1.token, id).expect(409);
      await assignReviewer(t, actors.admin.token, id, actors.reviewer2.id).expect(409);
    });

    it('concurrent decisions: exactly one is recorded', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id);
      const results = await Promise.all([
        decide(t, actors.reviewer1.token, id, 'APPROVED'),
        decide(t, actors.reviewer1.token, id, 'REJECTED'),
        decide(t, actors.reviewer1.token, id, 'NEEDS_INFORMATION'),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(2);
      const { body: trail } = await t.http().get(`/api/applications/${id}/audit`).set(bearer(actors.admin.token)).expect(200);
      expect(trail.filter((e: any) => e.action === 'APPLICATION_DECIDED')).toHaveLength(1);
    });

    it('rejects unknown decision values', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id);
      await decide(t, actors.reviewer1.token, id, 'IN_REVIEW').expect(400);
      await decide(t, actors.reviewer1.token, id, 'DRAFT').expect(400);
    });

    it('request-info -> sales edits and resubmits -> back to IN_REVIEW with a new job (version 2)', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id);
      await decide(t, actors.reviewer1.token, id, 'NEEDS_INFORMATION', 'need bank letter').expect(200);

      await t.http().patch(`/api/applications/${id}`).set(bearer(actors.sales1.token)).send({ businessName: 'Acme Coffee Co' }).expect(200);
      const res = await submitApplication(t, actors.sales1.token, id).expect(202);
      expect(res.body).toMatchObject({ status: 'IN_REVIEW', riskStatus: 'PENDING', submissionVersion: 2, assignedReviewerId: actors.reviewer1.id });
      expect(t.queue.last.opts.jobId).toBe(`risk-${id}-2`);
      expect(t.queue.jobs).toHaveLength(2);
    });
  });

  describe('enqueue failure compensation', () => {
    it('returns 503 and restores the previous state when Redis is unavailable', async () => {
      const app = await createApplication(t, actors.sales1.token);
      t.queue.failNextAdd = true;
      await submitApplication(t, actors.sales1.token, app.id).expect(503);

      const stored = (await get(actors.sales1.token, app.id).expect(200)).body;
      expect(stored).toMatchObject({ status: 'DRAFT', riskStatus: 'NOT_STARTED' });

      // The user can simply retry and it succeeds with a fresh job id.
      await submitApplication(t, actors.sales1.token, app.id).expect(202);
      expect(t.queue.last.opts.jobId).toBe(`risk-${app.id}-2`);
    });
  });

  describe('list / filter / paginate', () => {
    it('filters by status and paginates deterministically', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await createApplication(t, actors.sales1.token, { businessName: `Shop ${i}` })).id);
      await submitApplication(t, actors.sales1.token, ids[0]).expect(202);

      const drafts = await t.http().get('/api/applications?status=DRAFT').set(bearer(actors.sales1.token)).expect(200);
      expect(drafts.body.total).toBe(4);
      const submitted = await t.http().get('/api/applications?status=SUBMITTED').set(bearer(actors.sales1.token)).expect(200);
      expect(submitted.body.items.map((i: any) => i.id)).toEqual([ids[0]]);

      const page1 = await t.http().get('/api/applications?limit=2&page=1').set(bearer(actors.sales1.token)).expect(200);
      const page2 = await t.http().get('/api/applications?limit=2&page=2').set(bearer(actors.sales1.token)).expect(200);
      const page3 = await t.http().get('/api/applications?limit=2&page=3').set(bearer(actors.sales1.token)).expect(200);
      expect(page1.body).toMatchObject({ total: 5, totalPages: 3, page: 1, limit: 2 });
      const seen = [...page1.body.items, ...page2.body.items, ...page3.body.items].map((i: any) => i.id);
      expect(new Set(seen).size).toBe(5);
      expect(page3.body.items).toHaveLength(1);
    });

    it('filters by risk status', async () => {
      await applicationInReview(t, actors, actors.reviewer1.id, { requestedMonthlyVolume: '900000.00' });
      await applicationInReview(t, actors, actors.reviewer1.id);
      const flagged = await t.http().get('/api/applications?riskStatus=FLAGGED').set(bearer(actors.admin.token)).expect(200);
      expect(flagged.body.total).toBe(1);
    });
  });

  describe('audit trail and sensitive data', () => {
    it('records creation, submission, assignment and decision without leaking PII or secrets', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id);
      await decide(t, actors.reviewer1.token, id, 'APPROVED', 'all good').expect(200);

      const { body: trail } = await t.http().get(`/api/applications/${id}/audit`).set(bearer(actors.admin.token)).expect(200);
      const actions = trail.map((e: any) => e.action);
      expect(actions).toEqual(expect.arrayContaining([
        'APPLICATION_CREATED', 'APPLICATION_SUBMITTED', 'REVIEWER_ASSIGNED', 'RISK_REVIEW_COMPLETED', 'APPLICATION_DECIDED',
      ]));
      const decided = trail.find((e: any) => e.action === 'APPLICATION_DECIDED');
      expect(decided).toMatchObject({ actorId: actors.reviewer1.id, metadata: { decision: 'APPROVED', fromStatus: 'IN_REVIEW' } });
      const risk = trail.find((e: any) => e.action === 'RISK_REVIEW_COMPLETED');
      expect(risk.actorId).toBeNull(); // performed by the system worker

      const serialized = JSON.stringify(trail);
      expect(serialized).not.toMatch(/jane|doe|jane\.doe@example\.test/i);
      expect(serialized).not.toMatch(/password|eyJ|\$2[aby]\$/i);
    });

    it('audit stores changed field names, not values, on update', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await t.http().patch(`/api/applications/${app.id}`).set(bearer(actors.sales1.token)).send({ ownerName: 'Secret Person', contactEmail: 'secret@example.test' }).expect(200);
      const rows = await t.dataSource.query(`SELECT metadata FROM audit_logs WHERE action = 'APPLICATION_UPDATED'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({ changedFields: ['ownerName', 'contactEmail'] });
    });

    it('owner identity and contact fields are encrypted at rest but served in clear to authorised callers', async () => {
      const app = await createApplication(t, actors.sales1.token);
      const [row] = await t.dataSource.query('SELECT owner_name, contact_email FROM merchant_applications WHERE id = $1', [app.id]);
      expect(row.owner_name).toMatch(/^v1:/);
      expect(row.contact_email).toMatch(/^v1:/);
      expect(row.owner_name).not.toContain('Jane');
      expect(row.contact_email).not.toContain('example.test');
      expect((await get(actors.sales1.token, app.id)).body).toMatchObject({ ownerName: 'Jane Doe', contactEmail: 'jane.doe@example.test' });
    });

    it('only ADMIN and the assigned REVIEWER can read the audit trail', async () => {
      const id = await applicationInReview(t, actors, actors.reviewer1.id);
      await t.http().get(`/api/applications/${id}/audit`).set(bearer(actors.reviewer1.token)).expect(200);
      await t.http().get(`/api/applications/${id}/audit`).set(bearer(actors.admin.token)).expect(200);
      await t.http().get(`/api/applications/${id}/audit`).set(bearer(actors.sales1.token)).expect(403);
      await t.http().get(`/api/applications/${id}/audit`).set(bearer(actors.reviewer2.token)).expect(404);
    });
  });

  describe('error handling', () => {
    it('uses one error shape and never leaks internals', async () => {
      const res = await get(actors.admin.token, '3f2c0e3a-3b0a-4a76-9d7a-0d4a8f3c9f11').expect(404);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'message', 'path', 'statusCode', 'timestamp']);
      expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules|QueryFailed/i);
    });
  });
});
