import { randomBytes } from 'crypto';

// Test-only configuration. Secrets are generated per run, so nothing sensitive is committed.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('hex');

// Infrastructure defaults match docker-compose.yml. The database name is forced to a dedicated
// test database so `npm run test:e2e` can never truncate development data.
process.env.DATABASE_HOST ??= 'localhost';
process.env.DATABASE_PORT ??= '5432';
process.env.DATABASE_USER ??= 'merchant';
process.env.DATABASE_PASSWORD ??= 'merchant_local_password';
process.env.DATABASE_NAME = process.env.TEST_DATABASE_NAME ?? 'merchant_backend_test';
process.env.REDIS_HOST ??= 'localhost';
process.env.REDIS_PORT ??= '6379';
// Separate BullMQ namespace: a dev server on the same Redis must not consume the tests' jobs (or vice versa).
process.env.QUEUE_PREFIX = 'bull-test';

// Fast retries so the failure path completes in milliseconds.
process.env.RISK_JOB_ATTEMPTS = '3';
process.env.RISK_BACKOFF_MS = '50';
