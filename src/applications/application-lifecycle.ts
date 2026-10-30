import { ConflictException } from '@nestjs/common';
import { ApplicationStatus, MerchantApplication, RiskStatus } from './merchant-application.entity';

/**
 * Pure state-machine rules. No I/O, so they are cheap to unit test exhaustively.
 *
 *   DRAFT ──submit──▶ SUBMITTED ──assign──▶ IN_REVIEW ──┬─approve──▶ APPROVED   (terminal, needs risk CLEAR)
 *     ▲                                        ▲   │     ├─reject───▶ REJECTED   (terminal)
 *     │                                        │   │     └─request info─▶ NEEDS_INFORMATION
 *     └──── NEEDS_INFORMATION ──resubmit───────┘───┘                        │
 *                  ▲───────────────────────────────────────────────────────┘
 *
 * Resubmitting an application that already has a reviewer goes straight back to IN_REVIEW.
 */
export type Decision = ApplicationStatus.APPROVED | ApplicationStatus.REJECTED | ApplicationStatus.NEEDS_INFORMATION;
export const DECISIONS: Decision[] = [
  ApplicationStatus.APPROVED,
  ApplicationStatus.REJECTED,
  ApplicationStatus.NEEDS_INFORMATION,
];

const EDITABLE: ApplicationStatus[] = [ApplicationStatus.DRAFT, ApplicationStatus.NEEDS_INFORMATION];
const ASSIGNABLE: ApplicationStatus[] = [ApplicationStatus.SUBMITTED, ApplicationStatus.IN_REVIEW];

export function isEditable(status: ApplicationStatus): boolean {
  return EDITABLE.includes(status);
}

export function assertEditable(app: Pick<MerchantApplication, 'status'>): void {
  if (!isEditable(app.status)) {
    throw new ConflictException(`Application in status ${app.status} can no longer be edited`);
  }
}

export function assertSubmittable(app: Pick<MerchantApplication, 'status'>): void {
  if (!isEditable(app.status)) {
    throw new ConflictException(`Application in status ${app.status} cannot be submitted`);
  }
}

export function assertAssignable(app: Pick<MerchantApplication, 'status'>): void {
  if (!ASSIGNABLE.includes(app.status)) {
    throw new ConflictException(`A reviewer can only be assigned to a submitted application (current status ${app.status})`);
  }
}

export function assertDecidable(app: Pick<MerchantApplication, 'status' | 'riskStatus'>, decision: Decision): void {
  if (app.status !== ApplicationStatus.IN_REVIEW) {
    throw new ConflictException(`Application in status ${app.status} cannot be decided`);
  }
  if (decision === ApplicationStatus.APPROVED && app.riskStatus !== RiskStatus.CLEAR) {
    throw new ConflictException(`Cannot approve while risk status is ${app.riskStatus}; approval requires CLEAR`);
  }
}

/** Status a submission lands in: straight back to review when a reviewer is already assigned. */
export function statusAfterSubmit(app: Pick<MerchantApplication, 'assignedReviewerId'>): ApplicationStatus {
  return app.assignedReviewerId ? ApplicationStatus.IN_REVIEW : ApplicationStatus.SUBMITTED;
}
