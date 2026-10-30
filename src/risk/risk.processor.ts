import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { DataSource, EntityManager } from 'typeorm';
import { AuditAction } from '../audit/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { MerchantApplication, RiskStatus } from '../applications/merchant-application.entity';
import { RISK_JOB, RISK_QUEUE, RiskJobData } from './risk.constants';
import { RISK_PROVIDER, RiskProvider } from './risk-provider';

export type RiskJobResult = { applied: boolean; reason?: string };

@Processor(RISK_QUEUE, { concurrency: 5 })
export class RiskProcessor extends WorkerHost {
  private readonly logger = new Logger(RiskProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(RISK_PROVIDER) private readonly provider: RiskProvider,
    private readonly audit: AuditService,
  ) {
    super();
  }

  /**
   * Idempotent by construction: the result is only written while the row is still
   * `PENDING` for the same submission version, checked under a row lock. A duplicate
   * delivery, a retry after a crash between "write" and "ack", or a job made stale by a
   * resubmission therefore becomes a no-op instead of overwriting newer state.
   */
  async process(job: Job<RiskJobData>): Promise<RiskJobResult> {
    if (job.name !== RISK_JOB) return { applied: false, reason: 'unknown-job' };
    const { applicationId, submissionVersion } = job.data;

    const application = await this.dataSource.getRepository(MerchantApplication).findOne({ where: { id: applicationId } });
    if (!application || !this.isCurrent(application, submissionVersion)) {
      this.logger.log(`Skipping stale risk job ${job.id}`);
      return { applied: false, reason: 'stale' };
    }

    // The slow/unreliable call happens outside any DB transaction or lock. May throw -> BullMQ retries with backoff.
    const assessment = await this.provider.assess({
      applicationId,
      businessName: application.businessName,
      legalBusinessName: application.legalBusinessName,
      businessType: application.businessType,
      requestedMonthlyVolume: application.requestedMonthlyVolume,
      requestedAverageTransaction: application.requestedAverageTransaction,
    });

    return this.dataSource.transaction(async (em) => {
      const locked = await this.lock(em, applicationId);
      if (!locked || !this.isCurrent(locked, submissionVersion)) {
        return { applied: false, reason: 'stale' };
      }
      locked.riskStatus = assessment.outcome === 'CLEAR' ? RiskStatus.CLEAR : RiskStatus.FLAGGED;
      locked.riskResult = { ...assessment };
      await em.getRepository(MerchantApplication).save(locked);
      await this.audit.record(
        null,
        AuditAction.RISK_REVIEW_COMPLETED,
        applicationId,
        { outcome: assessment.outcome, reasons: assessment.reasons, submissionVersion, jobId: job.id },
        em,
      );
      return { applied: true };
    });
  }

  /**
   * Retries are exhausted: record FAILED so the application never sits in PENDING forever.
   * A reviewer can then request information, which leads to a resubmission and a fresh job.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<RiskJobData> | undefined, error: Error) {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      this.logger.warn(`Risk job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}), will retry: ${error.message}`);
      return;
    }
    this.logger.error(`Risk job ${job.id} exhausted ${maxAttempts} attempts: ${error.message}`);
    try {
      await this.markFailed(job, error);
    } catch (persistError) {
      // This runs as an event listener: a throw here would be an unhandled rejection. The application
      // stays PENDING and RiskReconciler picks it up later, so log loudly and carry on.
      this.logger.error(
        `Could not persist FAILED for risk job ${job.id}; RiskReconciler will retry it`,
        persistError instanceof Error ? persistError.stack : String(persistError),
      );
    }
  }

  private markFailed(job: Job<RiskJobData>, error: Error) {
    const { applicationId, submissionVersion } = job.data;
    return this.dataSource.transaction(async (em) => {
      const locked = await this.lock(em, applicationId);
      if (!locked || !this.isCurrent(locked, submissionVersion)) return;
      locked.riskStatus = RiskStatus.FAILED;
      locked.riskResult = { outcome: 'ERROR', error: error.name, attempts: job.attemptsMade, failedAt: new Date().toISOString() };
      await em.getRepository(MerchantApplication).save(locked);
      await this.audit.record(
        null,
        AuditAction.RISK_REVIEW_FAILED,
        applicationId,
        { error: error.name, attempts: job.attemptsMade, submissionVersion, jobId: job.id },
        em,
      );
    });
  }

  private isCurrent(app: MerchantApplication, submissionVersion: number) {
    return app.submissionVersion === submissionVersion && app.riskStatus === RiskStatus.PENDING;
  }

  private lock(em: EntityManager, id: string) {
    return em.getRepository(MerchantApplication).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  }
}
