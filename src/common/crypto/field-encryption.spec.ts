import { randomBytes } from 'crypto';
import { decryptField, encryptedColumn, encryptField } from './field-encryption';

describe('field encryption (AES-256-GCM)', () => {
  const original = process.env.FIELD_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  });
  afterAll(() => {
    process.env.FIELD_ENCRYPTION_KEY = original;
  });

  it('round-trips unicode text', () => {
    const plain = 'Jane Döe <jane@example.test> 日本語';
    expect(decryptField(encryptField(plain))).toBe(plain);
  });

  it('never stores plaintext and uses a fresh IV each time', () => {
    const a = encryptField('same');
    const b = encryptField('same');
    expect(a).not.toContain('same');
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toEqual(b);
  });

  it('detects tampering (GCM auth tag)', () => {
    const [v, iv, tag, ct] = encryptField('secret').split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 0xff;
    expect(() => decryptField([v, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });

  it('fails to decrypt under a different key', () => {
    const payload = encryptField('secret');
    process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    expect(() => decryptField(payload)).toThrow();
  });

  it('refuses to run with a missing or malformed key', () => {
    process.env.FIELD_ENCRYPTION_KEY = 'short';
    expect(() => encryptField('x')).toThrow(/FIELD_ENCRYPTION_KEY/);
  });

  it('transformer passes null/undefined through', () => {
    expect(encryptedColumn.to(null)).toBeNull();
    expect(encryptedColumn.from(undefined)).toBeUndefined();
    expect(encryptedColumn.from(encryptedColumn.to('v'))).toBe('v');
  });
});
