import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { Job } from 'bullmq';
import { Client } from 'pg';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuditService } from '../src/audit/audit.service';
import { RISK_JOB, RISK_QUEUE, RiskJobData } from '../src/risk/risk.constants';
import { RiskProcessor } from '../src/risk/risk.processor';
import { SimulatedKybProvider } from '../src/risk/risk-provider';
import { User, UserRole } from '../src/users/user.entity';

/** Generated per run; never a real credential. */
export const TEST_PASSWORD = `Pw-${randomBytes(12).toString('hex')}`;

export interface RecordedJob {
  name: string;
  data: RiskJobData;
  opts: Record<string, any>;
}

/** In-memory stand-in for the BullMQ queue so DB-backed API tests don't need Redis. */
export class FakeQueue {
  jobs: RecordedJob[] = [];
  failNextAdd = false;

  async add(name: string, data: RiskJobData, opts: Record<string, any>) {
    if (this.failNextAdd) {
      this.failNextAdd = false;
      throw new Error('simulated redis outage');
    }
    this.jobs.push({ name, data, opts });
    return { id: opts.jobId };
  }

  /** Job ids to report as parked in the BullMQ "failed" set (retries exhausted, FAILED write lost). */
  failedJobIds = new Set<string>();

  async getJob(jobId: string) {
    const job = this.jobs.find((j) => j.opts.jobId === jobId);
    if (!job) return undefined;
    return {
      getState: async () => (this.failedJobIds.has(jobId) ? 'failed' : 'waiting'),
      remove: async () => {
        this.jobs = this.jobs.filter((j) => j !== job);
        this.failedJobIds.delete(jobId);
      },
    };
  }

  get last() {
    return this.jobs[this.jobs.length - 1];
  }
}

async function ensureTestDatabase() {
  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: 'postgres',
  });
  await client.connect();
  try {
    const name = process.env.DATABASE_NAME!;
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await client.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await client.end();
  }
}

export interface TestApp {
  app: INestApplication;
  dataSource: DataSource;
  queue: FakeQueue;
  http: () => ReturnType<typeof request>;
}

/**
 * Boots the real AppModule (same pipes/filters/guards as production) against a real Postgres.
 * With `realQueue: false` (default) the BullMQ queue and worker are replaced so no Redis is needed.
 */
export async function createTestApp(options: { realQueue?: boolean } = {}): Promise<TestApp> {
  await ensureTestDatabase();
  const queue = new FakeQueue();
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (!options.realQueue) {
    builder = builder.overrideProvider(getQueueToken(RISK_QUEUE)).useValue(queue).overrideProvider(RiskProcessor).useValue({});
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const dataSource = app.get(DataSource);
  await dataSource.runMigrations();
  return { app, dataSource, queue, http: () => request(app.getHttpServer()) };
}

export async function resetAll(dataSource: DataSource) {
  await dataSource.query('TRUNCATE TABLE audit_logs, merchant_applications, users RESTART IDENTITY CASCADE');
}

export async function resetApplications(dataSource: DataSource) {
  await dataSource.query('TRUNCATE TABLE audit_logs, merchant_applications RESTART IDENTITY CASCADE');
}

export async function createUser(dataSource: DataSource, email: string, role: UserRole, isActive = true) {
  const repo = dataSource.getRepository(User);
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4); // low cost: test speed only
  return repo.save(repo.create({ email, role, passwordHash, isActive }));
}

export async function login(t: TestApp, email: string): Promise<string> {
  const res = await t.http().post('/api/auth/login').send({ email, password: TEST_PASSWORD }).expect(200);
  return res.body.accessToken;
}

export const validPayload = (over: Record<string, unknown> = {}) => ({
  businessName: 'Acme Coffee',
  legalBusinessName: 'Acme Coffee Roasters LLC',
  businessType: 'LLC',
  ownerName: 'Jane Doe',
  contactEmail: 'jane.doe@example.test',
  requestedMonthlyVolume: '25000.00',
  requestedAverageTransaction: '45.00',
  ...over,
});

/** Runs the worker logic for a recorded job directly against the database (what BullMQ would do). */
export async function runRiskJob(t: TestApp, job: RecordedJob = t.queue.last) {
  const processor = new RiskProcessor(t.dataSource, new SimulatedKybProvider(), t.app.get(AuditService));
  const fake = { id: `risk-${job.data.applicationId}-${job.data.submissionVersion}`, name: RISK_JOB, data: job.data } as Job<RiskJobData>;
  return processor.process(fake);
}

export interface Actors {
  admin: { id: string; token: string };
  reviewer1: { id: string; token: string };
  reviewer2: { id: string; token: string };
  sales1: { id: string; token: string };
  sales2: { id: string; token: string };
}

export async function seedActors(t: TestApp): Promise<Actors> {
  await resetAll(t.dataSource);
  const make = async (email: string, role: UserRole) => {
    const user = await createUser(t.dataSource, email, role);
    return { id: user.id, token: await login(t, email) };
  };
  return {
    admin: await make('admin@example.test', UserRole.ADMIN),
    reviewer1: await make('reviewer1@example.test', UserRole.REVIEWER),
    reviewer2: await make('reviewer2@example.test', UserRole.REVIEWER),
    sales1: await make('sales1@example.test', UserRole.SALES),
    sales2: await make('sales2@example.test', UserRole.SALES),
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// ---- thin API wrappers used by the specs --------------------------------------------------

export async function createApplication(t: TestApp, token: string, over: Record<string, unknown> = {}) {
  const res = await t.http().post('/api/applications').set(bearer(token)).send(validPayload(over)).expect(201);
  return res.body as { id: string; [key: string]: any };
}

export const submitApplication = (t: TestApp, token: string, id: string) =>
  t.http().post(`/api/applications/${id}/submit`).set(bearer(token));

export const assignReviewer = (t: TestApp, token: string, id: string, reviewerId: string) =>
  t.http().post(`/api/applications/${id}/assign-reviewer`).set(bearer(token)).send({ reviewerId });

export const decide = (t: TestApp, token: string, id: string, decision: string, note?: string) =>
  t.http().post(`/api/applications/${id}/decision`).set(bearer(token)).send({ decision, note });

/** create -> submit -> assign -> (optionally) run the risk worker. Returns the application id. */
export async function applicationInReview(t: TestApp, actors: Actors, reviewerId: string, over: Record<string, unknown> = {}, runRisk = true) {
  const app = await createApplication(t, actors.sales1.token, over);
  await submitApplication(t, actors.sales1.token, app.id).expect(202);
  await assignReviewer(t, actors.admin.token, app.id, reviewerId).expect(200);
  if (runRisk) await runRiskJob(t);
  return app.id;
}
