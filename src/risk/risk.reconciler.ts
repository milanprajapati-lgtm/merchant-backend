import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, LessThan } from 'typeorm';
import { MerchantApplication, RiskStatus } from '../applications/merchant-application.entity';
import { RISK_JOB, RISK_QUEUE, RiskJobData, riskJobId, riskJobOptions } from './risk.constants';

/**
 * Closes the dual-write gap between Postgres and Redis (ADR-001 decision 6).
 *
 * If the process dies after the submit transaction commits but before the job is enqueued, or the
 * worker could not persist FAILED, an application sits in PENDING with no live job. This sweeper
 * finds PENDING applications older than `RISK_RECONCILE_STALE_MS` and makes sure a job exists.
 * It is safe to run repeatedly: job ids are deterministic, and the worker is idempotent per
 * (application, submissionVersion), so a duplicate or late job is a no-op.
 */
@Injectable()
export class RiskReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RiskReconciler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue(RISK_QUEUE) private readonly queue: Queue<RiskJobData>,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    // Tests call reconcile() directly; a background timer would only add nondeterminism.
    if (this.config.get('NODE_ENV') === 'test') return;
    const intervalMs = this.config.get<number>('RISK_RECONCILE_INTERVAL_MS', 60_000);
    this.timer = setInterval(() => {
      this.reconcile().catch((err) => this.logger.error('Risk reconciliation run failed', err instanceof Error ? err.stack : String(err)));
    }, intervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Returns the number of jobs (re)enqueued. */
  async reconcile(staleMs = this.config.get<number>('RISK_RECONCILE_STALE_MS', 300_000), batchSize = 100): Promise<number> {
    const stuck = await this.dataSource.getRepository(MerchantApplication).find({
      where: { riskStatus: RiskStatus.PENDING, submittedAt: LessThan(new Date(Date.now() - staleMs)) },
      select: { id: true, submissionVersion: true },
      order: { submittedAt: 'ASC' },
      take: batchSize,
    });

    let enqueued = 0;
    for (const { id, submissionVersion } of stuck) {
      const jobId = riskJobId(id, submissionVersion);
      const existing = await this.queue.getJob(jobId);
      if (existing) {
        // Waiting / active / delayed: the pipeline is alive. Only a job parked in `failed` is dead.
        if ((await existing.getState()) !== 'failed') continue;
        await existing.remove();
      }
      await this.queue.add(
        RISK_JOB,
        { applicationId: id, submissionVersion },
        riskJobOptions(this.config.get<number>('RISK_JOB_ATTEMPTS', 4), this.config.get<number>('RISK_BACKOFF_MS', 1000), jobId),
      );
      this.logger.warn(`Re-enqueued risk job ${jobId} for an application stuck in PENDING`);
      enqueued += 1;
    }
    return enqueued;
  }
}
