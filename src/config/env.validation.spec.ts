import 'reflect-metadata';
import { validateEnv } from './env.validation';

const valid = {
  JWT_SECRET: 'x'.repeat(40),
  FIELD_ENCRYPTION_KEY: 'a'.repeat(64),
  DATABASE_HOST: 'localhost',
  DATABASE_USER: 'u',
  DATABASE_PASSWORD: 'p',
  DATABASE_NAME: 'd',
  REDIS_HOST: 'localhost',
};

describe('validateEnv', () => {
  it('accepts a complete config and applies defaults / numeric coercion', () => {
    const env = validateEnv({ ...valid, PORT: '4000' });
    expect(env.PORT).toBe(4000);
    expect(env.DATABASE_PORT).toBe(5432);
    expect(env.RISK_JOB_ATTEMPTS).toBe(4);
  });

  it('rejects a short JWT secret and a malformed encryption key', () => {
    expect(() => validateEnv({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => validateEnv({ ...valid, FIELD_ENCRYPTION_KEY: 'nothex' })).toThrow(/FIELD_ENCRYPTION_KEY/);
  });

  it('reports missing required variables without echoing secret values', () => {
    let message = '';
    try {
      validateEnv({ ...valid, DATABASE_HOST: undefined, JWT_SECRET: 'super-secret-but-short' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('DATABASE_HOST');
    expect(message).not.toContain('super-secret-but-short');
  });
});
