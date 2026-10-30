import { REDACTED, redactMetadata } from './redact';

describe('redactMetadata', () => {
  it('masks sensitive keys at any depth, case-insensitively', () => {
    const out = redactMetadata({
      decision: 'APPROVED',
      Password: 'hunter2',
      contactEmail: 'a@b.test',
      nested: { accessToken: 'abc', ownerName: 'Jane', ok: 1, deeper: [{ apiKey: 'k', fine: 'yes' }] },
    });
    expect(out).toEqual({
      decision: 'APPROVED',
      Password: REDACTED,
      contactEmail: REDACTED,
      nested: { accessToken: REDACTED, ownerName: REDACTED, ok: 1, deeper: [{ apiKey: REDACTED, fine: 'yes' }] },
    });
  });

  it('removes values that look like JWTs or bearer credentials even under harmless keys', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    const out = redactMetadata({ note: jwt, header: 'Bearer abc.def.ghi', plain: 'hello' });
    expect(out).toEqual({ note: REDACTED, header: REDACTED, plain: 'hello' });
  });

  it('truncates very long strings and caps nesting depth', () => {
    const out = redactMetadata({ note: 'x'.repeat(2000) });
    expect((out.note as string).length).toBeLessThan(600);

    let deep: Record<string, unknown> = { leaf: 'secret-ish' };
    for (let i = 0; i < 10; i++) deep = { child: deep };
    expect(JSON.stringify(redactMetadata(deep))).toContain(REDACTED);
  });

  it('does not mutate its input', () => {
    const input = { password: 'p', nested: { token: 't' } };
    redactMetadata(input);
    expect(input).toEqual({ password: 'p', nested: { token: 't' } });
  });
});
