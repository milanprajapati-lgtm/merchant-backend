import { Job } from 'bullmq';
import { RiskProcessor } from './risk.processor';
import { RiskProvider, TransientProviderError } from './risk-provider';
import { RiskJobData } from './risk.constants';
import { ApplicationStatus as S, MerchantApplication, RiskStatus as R } from '../applications/merchant-application.entity';
import { AuditAction } from '../audit/audit-log.entity';

const baseApp = (over: Partial<MerchantApplication> = {}) =>
  ({
    id: 'app-1', submissionVersion: 1, riskStatus: R.PENDING, status: S.SUBMITTED, riskResult: null,
    businessName: 'Acme', legalBusinessName: 'Acme LLC', businessType: 'LLC',
    requestedMonthlyVolume: '100.00', requestedAverageTransaction: '10.00', ...over,
  }) as MerchantApplication;

const job = (over: Record<string, unknown> = {}) =>
  ({ id: 'risk-app-1-1', name: 'check-application', data: { applicationId: 'app-1', submissionVersion: 1 }, attemptsMade: 1, opts: { attempts: 3 }, ...over }) as unknown as Job<RiskJobData>;

function setup(app: MerchantApplication | null, provider?: Partial<RiskProvider>) {
  const repo = { findOne: jest.fn().mockResolvedValue(app), save: jest.fn(async (e) => e) };
  const dataSource = { getRepository: jest.fn(() => repo), transaction: jest.fn((cb) => cb({ getRepository: () => repo })) };
  const risk: RiskProvider = {
    assess: jest.fn().mockResolvedValue({ provider: 'X', outcome: 'CLEAR', score: 0, reasons: [], checkedAt: 'now' }),
    ...provider,
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const processor = new RiskProcessor(dataSource as never, risk, audit as never);
  return { processor, repo, risk, audit, dataSource };
}

describe('RiskProcessor', () => {
  it('persists a CLEAR result, audits it as a system action and does not touch the workflow status', async () => {
    const application = baseApp();
    const { processor, audit } = setup(application);
    await expect(processor.process(job())).resolves.toEqual({ applied: true });
    expect(application).toMatchObject({ riskStatus: R.CLEAR, status: S.SUBMITTED });
    expect(application.riskResult).toMatchObject({ outcome: 'CLEAR' });
    expect(audit.record).toHaveBeenCalledWith(null, AuditAction.RISK_REVIEW_COMPLETED, 'app-1', expect.any(Object), expect.anything());
  });

  it('records FLAGGED outcomes', async () => {
    const application = baseApp();
    const { processor } = setup(application, {
      assess: jest.fn().mockResolvedValue({ provider: 'X', outcome: 'FLAGGED', score: 40, reasons: ['HIGH_VOLUME'], checkedAt: 'now' }),
    });
    await processor.process(job());
    expect(application.riskStatus).toBe(R.FLAGGED);
  });

  it('is idempotent: a redelivered job for an already-processed application is a no-op', async () => {
    const { processor, risk, audit, repo } = setup(baseApp({ riskStatus: R.CLEAR }));
    await expect(processor.process(job())).resolves.toEqual({ applied: false, reason: 'stale' });
    expect(risk.assess).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('ignores a job made stale by a newer submission', async () => {
    const { processor, risk } = setup(baseApp({ submissionVersion: 2 }));
    await expect(processor.process(job())).resolves.toEqual({ applied: false, reason: 'stale' });
    expect(risk.assess).not.toHaveBeenCalled();
  });

  it('skips when the application no longer exists', async () => {
    const { processor } = setup(null);
    await expect(processor.process(job())).resolves.toEqual({ applied: false, reason: 'stale' });
  });

  it('re-checks under the lock: a result that lost a race is discarded', async () => {
    const application = baseApp();
    const { processor, repo, audit } = setup(application);
    // First read (unlocked) sees PENDING; by the time we lock, another worker already finished.
    repo.findOne.mockResolvedValueOnce(baseApp()).mockResolvedValueOnce(baseApp({ riskStatus: R.CLEAR }));
    await expect(processor.process(job())).resolves.toEqual({ applied: false, reason: 'stale' });
    expect(repo.save).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lets provider errors propagate so BullMQ retries with backoff', async () => {
    const { processor, repo } = setup(baseApp(), { assess: jest.fn().mockRejectedValue(new TransientProviderError()) });
    await expect(processor.process(job())).rejects.toBeInstanceOf(TransientProviderError);
    expect(repo.save).not.toHaveBeenCalled();
  });

  describe('onFailed', () => {
    it('does nothing while retries remain', async () => {
      const application = baseApp();
      const { processor, dataSource } = setup(application);
      await processor.onFailed(job({ attemptsMade: 2 }), new TransientProviderError());
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(application.riskStatus).toBe(R.PENDING);
    });

    it('marks the application FAILED once attempts are exhausted', async () => {
      const application = baseApp();
      const { processor, audit } = setup(application);
      await processor.onFailed(job({ attemptsMade: 3 }), new TransientProviderError());
      expect(application.riskStatus).toBe(R.FAILED);
      expect(application.riskResult).toMatchObject({ outcome: 'ERROR', error: 'TransientProviderError', attempts: 3 });
      expect(audit.record).toHaveBeenCalledWith(null, AuditAction.RISK_REVIEW_FAILED, 'app-1', expect.any(Object), expect.anything());
    });

    it('does not clobber a newer submission when a stale job finally fails', async () => {
      const application = baseApp({ submissionVersion: 2 });
      const { processor, audit } = setup(application);
      await processor.onFailed(job({ attemptsMade: 3 }), new Error('boom'));
      expect(application.riskStatus).toBe(R.PENDING);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});

describe('RiskProcessor.onFailed resilience', () => {
  it('does not throw (no unhandled rejection) when persisting FAILED itself fails', async () => {
    const { processor, dataSource } = setup(baseApp());
    dataSource.transaction.mockRejectedValueOnce(new Error('database is down'));
    await expect(processor.onFailed(job({ attemptsMade: 3 }), new TransientProviderError())).resolves.toBeUndefined();
  });
});
