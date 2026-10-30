import {
  BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import { ApplicationStatus as S, MerchantApplication, RiskStatus as R } from './merchant-application.entity';
import { AuditAction } from '../audit/audit-log.entity';
import { RequestUser } from '../common/request-user';
import { UserRole } from '../users/user.entity';

const sales: RequestUser = { id: 'sales-1', role: UserRole.SALES, email: 's@example.test' };
const otherSales: RequestUser = { id: 'sales-2', role: UserRole.SALES, email: 's2@example.test' };
const admin: RequestUser = { id: 'admin-1', role: UserRole.ADMIN, email: 'a@example.test' };
const reviewer: RequestUser = { id: 'rev-1', role: UserRole.REVIEWER, email: 'r@example.test' };
const otherReviewer: RequestUser = { id: 'rev-2', role: UserRole.REVIEWER, email: 'r2@example.test' };

function setup(app?: Partial<MerchantApplication>) {
  const stored = app
    ? ({
        id: 'app-1', status: S.DRAFT, riskStatus: R.NOT_STARTED, riskResult: null, submissionVersion: 0,
        submittedAt: null, createdById: sales.id, assignedReviewerId: null, ...app,
      } as MerchantApplication)
    : null;
  const repo = {
    findOne: jest.fn().mockResolvedValue(stored),
    save: jest.fn(async (entity) => entity),
    create: jest.fn((entity) => ({ id: 'new-id', status: S.DRAFT, ...entity })),
  };
  const em = { getRepository: jest.fn(() => repo) };
  const dataSource = { transaction: jest.fn((cb) => cb(em)) };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined), listForResource: jest.fn() };
  const users = { findActiveReviewer: jest.fn() };
  const config = { get: jest.fn((_key: string, fallback?: unknown) => fallback) };
  const service = new ApplicationsService(
    repo as never, dataSource as never, queue as never, audit as never, users as never, config as never,
  );
  return { service, stored, repo, dataSource, queue, audit, users };
}

describe('ApplicationsService', () => {
  describe('create', () => {
    it('takes createdById from the authenticated user, never from the payload', async () => {
      const { service, repo, audit } = setup();
      const dto = { businessName: 'A', createdById: 'attacker' } as never;
      const saved = await service.create(dto, sales);
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ createdById: sales.id }));
      expect(saved.createdById).toBe(sales.id);
      expect(audit.record).toHaveBeenCalledWith(sales.id, AuditAction.APPLICATION_CREATED, 'new-id', expect.any(Object), expect.anything());
    });

    it('rejects reviewers (defence in depth behind @Roles)', async () => {
      await expect(setup().service.create({} as never, reviewer)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('object-level access', () => {
    it('hides another sales user application behind a 404 on update, submit and read', async () => {
      const { service } = setup({});
      await expect(service.update('app-1', { businessName: 'x' }, otherSales)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.submit('app-1', otherSales)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getById('app-1', otherSales)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects edits to a non-editable application with a conflict', async () => {
      const { service } = setup({ status: S.IN_REVIEW });
      await expect(service.update('app-1', { businessName: 'x' }, sales)).rejects.toBeInstanceOf(ConflictException);
    });

    it('audits changed field names only, never values', async () => {
      const { service, audit } = setup({ businessName: 'Old' });
      await service.update('app-1', { businessName: 'New' }, sales);
      const metadata = audit.record.mock.calls[0][3];
      expect(metadata).toEqual({ changedFields: ['businessName'] });
    });
  });

  describe('submit', () => {
    it('moves to SUBMITTED/PENDING, bumps the version and enqueues a deduplicated job', async () => {
      const { service, queue } = setup({});
      const saved = await service.submit('app-1', sales);
      expect(saved).toMatchObject({ status: S.SUBMITTED, riskStatus: R.PENDING, submissionVersion: 1 });
      expect(queue.add).toHaveBeenCalledWith(
        'check-application',
        { applicationId: 'app-1', submissionVersion: 1 },
        expect.objectContaining({ jobId: 'risk-app-1-1', attempts: 4, backoff: { type: 'exponential', delay: 1000 } }),
      );
    });

    it('rolls the submission back and returns 503 when the job cannot be enqueued', async () => {
      const { service, queue, stored, audit } = setup({});
      queue.add.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(service.submit('app-1', sales)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(stored).toMatchObject({ status: S.DRAFT, riskStatus: R.NOT_STARTED });
      expect(stored!.submissionVersion).toBe(1); // stays monotonic so a retry gets a new job id
      expect(audit.record).toHaveBeenCalledWith(sales.id, AuditAction.RISK_ENQUEUE_FAILED, 'app-1', expect.any(Object), expect.anything());
    });

    it('resubmitting with an assigned reviewer returns straight to IN_REVIEW', async () => {
      const { service } = setup({ status: S.NEEDS_INFORMATION, assignedReviewerId: reviewer.id, submissionVersion: 1 });
      const saved = await service.submit('app-1', sales);
      expect(saved).toMatchObject({ status: S.IN_REVIEW, submissionVersion: 2, riskStatus: R.PENDING });
    });
  });

  describe('assignReviewer', () => {
    it('is ADMIN only', async () => {
      await expect(setup({}).service.assignReviewer('app-1', reviewer.id, sales)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects ids that are not active reviewers, before touching the application', async () => {
      const { service, users, dataSource } = setup({ status: S.SUBMITTED });
      users.findActiveReviewer.mockResolvedValue(null);
      await expect(service.assignReviewer('app-1', 'some-sales-user', admin)).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('moves SUBMITTED to IN_REVIEW and records the previous reviewer', async () => {
      const { service, users, audit } = setup({ status: S.SUBMITTED });
      users.findActiveReviewer.mockResolvedValue({ id: reviewer.id });
      const saved = await service.assignReviewer('app-1', reviewer.id, admin);
      expect(saved).toMatchObject({ status: S.IN_REVIEW, assignedReviewerId: reviewer.id });
      expect(audit.record.mock.calls[0][3]).toEqual({ reviewerId: reviewer.id, previousReviewerId: null });
    });

    it('cannot assign to a DRAFT', async () => {
      const { service, users } = setup({ status: S.DRAFT });
      users.findActiveReviewer.mockResolvedValue({ id: reviewer.id });
      await expect(service.assignReviewer('app-1', reviewer.id, admin)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('decide', () => {
    const inReview = { status: S.IN_REVIEW, riskStatus: R.CLEAR, assignedReviewerId: reviewer.id };

    it('lets the assigned reviewer approve a CLEAR application and stamps the decision', async () => {
      const { service, audit } = setup(inReview);
      const saved = await service.decide('app-1', S.APPROVED, reviewer, 'looks good');
      expect(saved).toMatchObject({ status: S.APPROVED, decidedById: reviewer.id });
      expect(saved.decidedAt).toBeInstanceOf(Date);
      expect(audit.record.mock.calls[0][3]).toMatchObject({ decision: S.APPROVED, note: 'looks good' });
    });

    it('treats a different reviewer as not found (no existence leak)', async () => {
      await expect(setup(inReview).service.decide('app-1', S.APPROVED, otherReviewer)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('forbids ADMIN and SALES from recording decisions', async () => {
      const { service } = setup(inReview);
      await expect(service.decide('app-1', S.APPROVED, admin)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.decide('app-1', S.APPROVED, sales)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses to approve while risk is not CLEAR', async () => {
      const { service } = setup({ ...inReview, riskStatus: R.PENDING });
      await expect(service.decide('app-1', S.APPROVED, reviewer)).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a second decision once terminal', async () => {
      const { service } = setup({ ...inReview, status: S.APPROVED });
      await expect(service.decide('app-1', S.REJECTED, reviewer)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('list scoping', () => {
    it('applies an ownership predicate for SALES and an assignment predicate for REVIEWER', async () => {
      const qb = {
        andWhere: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(), take: jest.fn().mockReturnThis(), getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      const { service, repo } = setup();
      (repo as unknown as { createQueryBuilder: jest.Mock }).createQueryBuilder = jest.fn(() => qb);
      // The service reads `this.applications`, which is the same fake repo.
      await service.list({ page: 1, limit: 20 }, sales);
      expect(qb.andWhere).toHaveBeenCalledWith('application.createdById = :actorId', { actorId: sales.id });
      qb.andWhere.mockClear();
      await service.list({ page: 1, limit: 20 }, reviewer);
      expect(qb.andWhere).toHaveBeenCalledWith('application.assignedReviewerId = :actorId', { actorId: reviewer.id });
    });
  });
});
