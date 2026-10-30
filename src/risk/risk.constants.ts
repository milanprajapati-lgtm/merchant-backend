import { JobsOptions } from 'bullmq';

export const RISK_QUEUE = 'risk-review';
export const RISK_JOB = 'check-application';

/** Job payloads carry identifiers only - no PII ever sits in Redis. */
export interface RiskJobData {
  applicationId: string;
  submissionVersion: number;
}

/** BullMQ forbids ':' in custom job ids. One job per (application, submission version) = enqueue-side dedupe. */
export const riskJobId = (applicationId: string, submissionVersion: number) =>
  `risk-${applicationId}-${submissionVersion}`;

export function riskJobOptions(attempts: number, backoffMs: number, jobId: string): JobsOptions {
  return {
    jobId,
    attempts,
    backoff: { type: 'exponential', delay: backoffMs },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  };
}
