import { ConflictException } from '@nestjs/common';
import {
  assertAssignable, assertDecidable, assertEditable, assertSubmittable, isEditable, statusAfterSubmit,
} from './application-lifecycle';
import { ApplicationStatus as S, RiskStatus as R } from './merchant-application.entity';

describe('application lifecycle rules', () => {
  describe('editing / submitting', () => {
    it.each([S.DRAFT, S.NEEDS_INFORMATION])('allows editing and submitting from %s', (status) => {
      expect(isEditable(status)).toBe(true);
      expect(() => assertEditable({ status })).not.toThrow();
      expect(() => assertSubmittable({ status })).not.toThrow();
    });

    it.each([S.SUBMITTED, S.IN_REVIEW, S.APPROVED, S.REJECTED])('blocks editing and submitting from %s', (status) => {
      expect(() => assertEditable({ status })).toThrow(ConflictException);
      expect(() => assertSubmittable({ status })).toThrow(ConflictException);
    });

    it('returns to IN_REVIEW on resubmission when a reviewer is already assigned', () => {
      expect(statusAfterSubmit({ assignedReviewerId: 'r1' })).toBe(S.IN_REVIEW);
      expect(statusAfterSubmit({ assignedReviewerId: null })).toBe(S.SUBMITTED);
    });
  });

  describe('assigning a reviewer', () => {
    it.each([S.SUBMITTED, S.IN_REVIEW])('is allowed from %s', (status) => {
      expect(() => assertAssignable({ status })).not.toThrow();
    });

    it.each([S.DRAFT, S.NEEDS_INFORMATION, S.APPROVED, S.REJECTED])('is rejected from %s', (status) => {
      expect(() => assertAssignable({ status })).toThrow(ConflictException);
    });
  });

  describe('deciding', () => {
    it.each([S.DRAFT, S.SUBMITTED, S.NEEDS_INFORMATION, S.APPROVED, S.REJECTED])(
      'cannot decide from %s (only IN_REVIEW)',
      (status) => {
        expect(() => assertDecidable({ status, riskStatus: R.CLEAR }, S.REJECTED)).toThrow(ConflictException);
      },
    );

    it('approves only when the risk result is CLEAR', () => {
      expect(() => assertDecidable({ status: S.IN_REVIEW, riskStatus: R.CLEAR }, S.APPROVED)).not.toThrow();
      for (const risk of [R.NOT_STARTED, R.PENDING, R.FLAGGED, R.FAILED]) {
        expect(() => assertDecidable({ status: S.IN_REVIEW, riskStatus: risk }, S.APPROVED)).toThrow(ConflictException);
      }
    });

    it('allows reject / request-info regardless of risk status', () => {
      for (const risk of [R.PENDING, R.FLAGGED, R.FAILED, R.CLEAR]) {
        expect(() => assertDecidable({ status: S.IN_REVIEW, riskStatus: risk }, S.REJECTED)).not.toThrow();
        expect(() => assertDecidable({ status: S.IN_REVIEW, riskStatus: risk }, S.NEEDS_INFORMATION)).not.toThrow();
      }
    });
  });
});
