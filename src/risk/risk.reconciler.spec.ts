import { RiskReconciler } from './risk.reconciler';

function setup(stuck: { id: string; submissionVersion: number }[], existing: Record<string, 'active' | 'failed'> = {}) {
  const find = jest.fn().mockResolvedValue(stuck);
  const dataSource = { getRepository: jest.fn(() => ({ find })) };
  const remove = jest.fn().mockResolvedValue(undefined);
  const queue = {
    getJob: jest.fn(async (id: string) => (existing[id] ? { getState: async () => existing[id], remove } : undefined)),
    add: jest.fn().mockResolvedValue({}),
  };
  const config = { get: jest.fn((_key: string, fallback: unknown) => fallback) };
  return { reconciler: new RiskReconciler(dataSource as never, queue as never, config as never), queue, remove, find };
}

describe('RiskReconciler', () => {
  it('re-enqueues a stuck application whose job is missing, with the same deterministic job id', async () => {
    const { reconciler, queue } = setup([{ id: 'app-1', submissionVersion: 2 }]);
    await expect(reconciler.reconcile()).resolves.toBe(1);
    expect(queue.add).toHaveBeenCalledWith(
      'check-application',
      { applicationId: 'app-1', submissionVersion: 2 },
      expect.objectContaining({ jobId: 'risk-app-1-2', attempts: 4 }),
    );
  });

  it('leaves applications alone when their job is still alive', async () => {
    const { reconciler, queue } = setup([{ id: 'app-1', submissionVersion: 1 }], { 'risk-app-1-1': 'active' });
    await expect(reconciler.reconcile()).resolves.toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('replaces a job parked in the failed set (its FAILED write was lost) with a fresh one', async () => {
    const { reconciler, queue, remove } = setup([{ id: 'app-1', submissionVersion: 1 }], { 'risk-app-1-1': 'failed' });
    await expect(reconciler.reconcile()).resolves.toBe(1);
    expect(remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('only looks at PENDING applications older than the stale threshold', async () => {
    const { reconciler, find } = setup([]);
    await reconciler.reconcile(60_000);
    const where = find.mock.calls[0][0].where;
    expect(where.riskStatus).toBe('PENDING');
    expect(where.submittedAt).toBeDefined();
  });
});
