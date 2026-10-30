import { SimulatedKybProvider, TransientProviderError } from './risk-provider';

const input = (over: Partial<Parameters<SimulatedKybProvider['assess']>[0]> = {}) => ({
  applicationId: 'a1',
  businessName: 'Acme Coffee',
  legalBusinessName: 'Acme Coffee LLC',
  businessType: 'LLC',
  requestedMonthlyVolume: '25000.00',
  requestedAverageTransaction: '45.00',
  ...over,
});

describe('SimulatedKybProvider', () => {
  const provider = new SimulatedKybProvider();

  it('clears an ordinary application', async () => {
    await expect(provider.assess(input())).resolves.toMatchObject({ outcome: 'CLEAR', reasons: [], score: 0 });
  });

  it.each([
    ['WATCHLIST_MATCH', { legalBusinessName: 'Sanctioned Traders Ltd' }],
    ['HIGH_VOLUME', { requestedMonthlyVolume: '500000.01' }],
    ['HIGH_TICKET', { requestedAverageTransaction: '10000.01' }],
  ])('flags %s', async (reason, over) => {
    const result = await provider.assess(input(over));
    expect(result.outcome).toBe('FLAGGED');
    expect(result.reasons).toContain(reason);
  });

  it('is deterministic apart from the timestamp', async () => {
    const a = await provider.assess(input({ requestedMonthlyVolume: '900000.00' }));
    const b = await provider.assess(input({ requestedMonthlyVolume: '900000.00' }));
    expect({ ...a, checkedAt: '' }).toEqual({ ...b, checkedAt: '' });
  });

  it('simulates an outage for "[timeout]" business names', async () => {
    await expect(provider.assess(input({ businessName: 'Slow Shop [timeout]' }))).rejects.toBeInstanceOf(TransientProviderError);
  });
});
