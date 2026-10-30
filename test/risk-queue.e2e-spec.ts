import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RISK_QUEUE, riskJobId } from '../src/risk/risk.constants';
import { RiskReconciler } from '../src/risk/risk.reconciler';
import { Actors, TestApp, bearer, createApplication, createTestApp, resetApplications, seedActors, submitApplication } from './helpers';

/**
 * End-to-end through the real BullMQ queue and worker. Requires Redis (`docker compose up -d`).
 */
describe('Risk review through BullMQ (e2e, needs Redis)', () => {
  let t: TestApp;
  let actors: Actors;

  beforeAll(async () => {
    t = await createTestApp({ realQueue: true });
    actors = await seedActors(t);
  });
  beforeEach(() => resetApplications(t.dataSource));
  afterAll(() => t?.app.close());

  async function waitForRisk(id: string, until: (status: string) => boolean, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { body } = await t.http().get(`/api/applications/${id}`).set(bearer(actors.admin.token));
      if (until(body.riskStatus)) return body;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for risk result, last status ${body.riskStatus}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('submit enqueues a job; the worker asynchronously moves risk PENDING -> CLEAR', async () => {
    const app = await createApplication(t, actors.sales1.token);
    const submitted = await submitApplication(t, actors.sales1.token, app.id).expect(202);
    expect(submitted.body.riskStatus).toBe('PENDING');

    const done = await waitForRisk(app.id, (s) => s !== 'PENDING');
    expect(done.riskStatus).toBe('CLEAR');
    expect(done.riskResult.provider).toBe('SIMULATED_KYB');
  });

  it('flags risky applications', async () => {
    const app = await createApplication(t, actors.sales1.token, { requestedMonthlyVolume: '900000.00' });
    await submitApplication(t, actors.sales1.token, app.id).expect(202);
    expect((await waitForRisk(app.id, (s) => s !== 'PENDING')).riskStatus).toBe('FLAGGED');
  });

  it('retries a failing provider with backoff, then lands on FAILED', async () => {
    const app = await createApplication(t, actors.sales1.token, { businessName: 'Slow Shop [timeout]' });
    await submitApplication(t, actors.sales1.token, app.id).expect(202);

    const done = await waitForRisk(app.id, (s) => s !== 'PENDING');
    expect(done.riskStatus).toBe('FAILED');
    expect(done.riskResult).toMatchObject({ outcome: 'ERROR', attempts: 3 }); // RISK_JOB_ATTEMPTS=3 in setup-env
  });

  describe('RiskReconciler against real Redis', () => {
    // Puts an application back into "PENDING for 30 minutes" in Postgres, as a lost enqueue / lost FAILED write would leave it.
    const strand = (id: string) =>
      t.dataSource.query(
        `UPDATE merchant_applications SET risk_status = 'PENDING', risk_result = NULL, submitted_at = now() - interval '30 minutes' WHERE id = $1`,
        [id],
      );

    it('re-enqueues an application whose job vanished, and the worker completes it', async () => {
      const app = await createApplication(t, actors.sales1.token);
      await submitApplication(t, actors.sales1.token, app.id).expect(202);
      await waitForRisk(app.id, (s) => s !== 'PENDING');

      const queue = t.app.get<Queue>(getQueueToken(RISK_QUEUE));
      await (await queue.getJob(riskJobId(app.id, 1)))!.remove(); // the job is gone from Redis
      await strand(app.id);

      await expect(t.app.get(RiskReconciler).reconcile(5 * 60_000)).resolves.toBe(1);
      const done = await waitForRisk(app.id, (s) => s !== 'PENDING');
      expect(done.riskStatus).toBe('CLEAR');
    });

    it('replaces a job parked in the failed set (FAILED write lost) and runs it again', async () => {
      const app = await createApplication(t, actors.sales1.token, { businessName: 'Slow Shop [timeout]' });
      await submitApplication(t, actors.sales1.token, app.id).expect(202);
      await waitForRisk(app.id, (s) => s === 'FAILED');

      const queue = t.app.get<Queue>(getQueueToken(RISK_QUEUE));
      expect(await (await queue.getJob(riskJobId(app.id, 1)))!.getState()).toBe('failed');
      await strand(app.id);

      await expect(t.app.get(RiskReconciler).reconcile(5 * 60_000)).resolves.toBe(1);
      expect((await waitForRisk(app.id, (s) => s !== 'PENDING')).riskStatus).toBe('FAILED'); // retried, failed again, persisted
    });
  });
});
