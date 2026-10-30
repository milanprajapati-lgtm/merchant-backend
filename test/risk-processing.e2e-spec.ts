import { Job } from 'bullmq';
import { AuditService } from '../src/audit/audit.service';
import { RiskProcessor } from '../src/risk/risk.processor';
import { RISK_JOB, RiskJobData } from '../src/risk/risk.constants';
import { SimulatedKybProvider, TransientProviderError } from '../src/risk/risk-provider';
import {
  Actors, TestApp, applicationInReview, bearer, createApplication, createTestApp, resetApplications,
  runRiskJob, seedActors, submitApplication,
} from './helpers';

/**
 * Worker logic against a real Postgres (the queue transport itself is covered by
 * risk-queue.e2e-spec.ts, which needs Redis).
 */
describe('Risk processing (e2e, no Redis)', () => {
  let t: TestApp;
  let actors: Actors;

  beforeAll(async () => {
    t = await createTestApp();
    actors = await seedActors(t);
  });
  beforeEach(async () => {
    await resetApplications(t.dataSource);
    t.queue.jobs = [];
  });
  afterAll(() => t?.app.close());

  const getApp = async (id: string) => (await t.http().get(`/api/applications/${id}`).set(bearer(actors.admin.token)).expect(200)).body;
  const auditActions = async (id: string) =>
    (await t.dataSource.query('SELECT action, actor_id FROM audit_logs WHERE resource_id = $1 ORDER BY created_at', [id])) as { action: string; actor_id: string | null }[];

  const fakeJob = (data: RiskJobData, attemptsMade = 1, attempts = 3) =>
    ({ id: `risk-${data.applicationId}-${data.submissionVersion}`, name: RISK_JOB, data, attemptsMade, opts: { attempts } }) as unknown as Job<RiskJobData>;
  const processor = (provider = new SimulatedKybProvider()) => new RiskProcessor(t.dataSource, provider, t.app.get(AuditService));

  it('persists CLEAR and the provider result for an ordinary application', async () => {
    const app = await createApplication(t, actors.sales1.token);
    await submitApplication(t, actors.sales1.token, app.id).expect(202);
    expect(await runRiskJob(t)).toEqual({ applied: true });

    const stored = await getApp(app.id);
    expect(stored.riskStatus).toBe('CLEAR');
    expect(stored.status).toBe('SUBMITTED'); // risk result never moves the workflow state by itself
    expect(stored.riskResult).toMatchObject({ provider: 'SIMULATED_KYB', outcome: 'CLEAR', reasons: [] });
  });

  it('persists FLAGGED with reasons', async () => {
    const app = await createApplication(t, actors.sales1.token, { legalBusinessName: 'Sanctioned Traders LLC', requestedMonthlyVolume: '750000.00' });
    await submitApplication(t, actors.sales1.token, app.id).expect(202);
    await runRiskJob(t);
    const stored = await getApp(app.id);
    expect(stored.riskStatus).toBe('FLAGGED');
    expect(stored.riskResult.reasons).toEqual(expect.arrayContaining(['WATCHLIST_MATCH', 'HIGH_VOLUME']));
  });

  it('is idempotent: delivering the same job repeatedly applies once and audits once', async () => {
    const app = await createApplication(t, actors.sales1.token);
    await submitApplication(t, actors.sales1.token, app.id).expect(202);
    const job = t.queue.last;

    const results = await Promise.all([runRiskJob(t, job), runRiskJob(t, job), runRiskJob(t, job)]);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    await runRiskJob(t, job);

    const actions = (await auditActions(app.id)).map((a) => a.action);
    expect(actions.filter((a) => a === 'RISK_REVIEW_COMPLETED')).toHaveLength(1);
    expect((await getApp(app.id)).riskStatus).toBe('CLEAR');
  });

  it('system-authored audit rows have a null actor', async () => {
    const app = await createApplication(t, actors.sales1.token);
    await submitApplication(t, actors.sales1.token, app.id).expect(202);
    await runRiskJob(t);
    const row = (await auditActions(app.id)).find((a) => a.action === 'RISK_REVIEW_COMPLETED');
    expect(row?.actor_id).toBeNull();
  });

  it('a stale job from an earlier submission cannot overwrite the newer result', async () => {
    const id = await applicationInReview(t, actors, actors.reviewer1.id, {}, false);
    const firstJob = t.queue.last; // version 1
    await runRiskJob(t, firstJob);

    // Reviewer asks for more info; sales resubmits with a flaggable volume -> version 2, risk PENDING again.
    await t.http().post(`/api/applications/${id}/decision`).set(bearer(actors.reviewer1.token)).send({ decision: 'NEEDS_INFORMATION' }).expect(200);
    await t.http().patch(`/api/applications/${id}`).set(bearer(actors.sales1.token)).send({ requestedMonthlyVolume: '900000.00' }).expect(200);
    await submitApplication(t, actors.sales1.token, id).expect(202);
    expect((await getApp(id)).riskStatus).toBe('PENDING');

    // Late redelivery of the version-1 job must be ignored.
    expect(await runRiskJob(t, firstJob)).toEqual({ applied: false, reason: 'stale' });
    expect((await getApp(id)).riskStatus).toBe('PENDING');

    // The current job applies normally.
    await runRiskJob(t, t.queue.last);
    expect((await getApp(id)).riskStatus).toBe('FLAGGED');
  });

  it('provider outages bubble up for BullMQ to retry and leave the application PENDING', async () => {
    const app = await createApplication(t, actors.sales1.token, { businessName: 'Slow Shop [timeout]' });
    await submitApplication(t, actors.sales1.token, app.id).expect(202);
    await expect(runRiskJob(t)).rejects.toBeInstanceOf(TransientProviderError);
    expect((await getApp(app.id)).riskStatus).toBe('PENDING');
  });

  it('exhausted retries mark the application FAILED (never stuck PENDING) and audit it', async () => {
    const app = await createApplication(t, actors.sales1.token, { businessName: 'Slow Shop [timeout]' });
    await submitApplication(t, actors.sales1.token, app.id).expect(202);
    const data = t.queue.last.data;

    await processor().onFailed(fakeJob(data, 1), new TransientProviderError());
    await processor().onFailed(fakeJob(data, 2), new TransientProviderError());
    expect((await getApp(app.id)).riskStatus).toBe('PENDING'); // still retrying

    await processor().onFailed(fakeJob(data, 3), new TransientProviderError());
    const stored = await getApp(app.id);
    expect(stored.riskStatus).toBe('FAILED');
    expect(stored.riskResult).toMatchObject({ outcome: 'ERROR', error: 'TransientProviderError', attempts: 3 });
    expect((await auditActions(app.id)).map((a) => a.action)).toContain('RISK_REVIEW_FAILED');
  });

  it('after FAILED the recovery path is request-info -> resubmit, which starts a fresh risk check', async () => {
    const id = await applicationInReview(t, actors, actors.reviewer1.id, { businessName: 'Slow Shop [timeout]' }, false);
    await processor().onFailed(fakeJob(t.queue.last.data, 3), new TransientProviderError());
    expect((await getApp(id)).riskStatus).toBe('FAILED');

    await t.http().post(`/api/applications/${id}/decision`).set(bearer(actors.reviewer1.token)).send({ decision: 'APPROVED' }).expect(409);
    await t.http().post(`/api/applications/${id}/decision`).set(bearer(actors.reviewer1.token)).send({ decision: 'NEEDS_INFORMATION' }).expect(200);
    await t.http().patch(`/api/applications/${id}`).set(bearer(actors.sales1.token)).send({ businessName: 'Fast Shop' }).expect(200);
    await submitApplication(t, actors.sales1.token, id).expect(202);
    await runRiskJob(t);
    expect((await getApp(id)).riskStatus).toBe('CLEAR');
  });
});
