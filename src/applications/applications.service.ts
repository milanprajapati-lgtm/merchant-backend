import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ApplicationStatus, MerchantApplication, RiskStatus } from './merchant-application.entity';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { ListApplicationsDto } from './dto/list-applications.dto';
import { ApplicationPolicy } from './application.policy';
import {
  Decision, assertAssignable, assertDecidable, assertEditable, assertSubmittable, statusAfterSubmit,
} from './application-lifecycle';
import { AuditAction } from '../audit/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { RequestUser } from '../common/request-user';
import { RISK_JOB, RISK_QUEUE, RiskJobData, riskJobId, riskJobOptions } from '../risk/risk.constants';
import { UserRole } from '../users/user.entity';
import { UsersService } from '../users/users.service';

export type { RequestUser };

@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);

  constructor(
    @InjectRepository(MerchantApplication) private readonly applications: Repository<MerchantApplication>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue(RISK_QUEUE) private readonly riskQueue: Queue<RiskJobData>,
    private readonly audit: AuditService,
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

  async create(dto: CreateApplicationDto, actor: RequestUser) {
    if (actor.role !== UserRole.SALES && actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only SALES or ADMIN can create applications');
    }
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(MerchantApplication);
      // dto is allow-listed by the ValidationPipe, so status / createdById / reviewer can't be client-supplied.
      const saved = await repo.save(repo.create({ ...dto, createdById: actor.id }));
      await this.audit.record(actor.id, AuditAction.APPLICATION_CREATED, saved.id, { status: saved.status, businessType: saved.businessType }, em);
      return saved;
    });
  }

  async list(query: ListApplicationsDto, actor: RequestUser) {
    const qb = this.applications.createQueryBuilder('application');
    // Scope is applied in SQL so rows the caller may not see are never loaded.
    if (actor.role === UserRole.SALES) qb.andWhere('application.createdById = :actorId', { actorId: actor.id });
    else if (actor.role === UserRole.REVIEWER) qb.andWhere('application.assignedReviewerId = :actorId', { actorId: actor.id });
    else if (actor.role !== UserRole.ADMIN) qb.andWhere('1 = 0');
    if (query.status) qb.andWhere('application.status = :status', { status: query.status });
    if (query.riskStatus) qb.andWhere('application.riskStatus = :riskStatus', { riskStatus: query.riskStatus });
    qb.orderBy('application.createdAt', 'DESC')
      .addOrderBy('application.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);
    const [items, total] = await qb.getManyAndCount();
    return { items, page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) };
  }

  async getById(id: string, actor: RequestUser) {
    const application = await this.applications.findOne({ where: { id } });
    // 404 (not 403) so a caller can't probe which ids exist.
    if (!application || !ApplicationPolicy.canView(application, actor)) throw new NotFoundException('Application not found');
    return application;
  }

  async getAuditTrail(id: string, actor: RequestUser) {
    await this.getById(id, actor);
    return this.audit.listForResource(id);
  }

  update(id: string, dto: UpdateApplicationDto, actor: RequestUser) {
    return this.mutate(id, actor, async (app, em) => {
      if (!ApplicationPolicy.canEdit(app, actor)) throw new ForbiddenException('You may not edit this application');
      assertEditable(app);
      const changedFields = (Object.keys(dto) as (keyof UpdateApplicationDto)[]).filter(
        (field) => dto[field] !== undefined && dto[field] !== app[field],
      );
      if (changedFields.length === 0) return app;
      Object.assign(app, dto);
      const saved = await em.getRepository(MerchantApplication).save(app);
      // Field names only - never the values, which include PII.
      await this.audit.record(actor.id, AuditAction.APPLICATION_UPDATED, saved.id, { changedFields }, em);
      return saved;
    });
  }

  async submit(id: string, actor: RequestUser) {
    const { saved, previous } = await this.mutate(id, actor, async (app, em) => {
      if (!ApplicationPolicy.canEdit(app, actor)) throw new ForbiddenException('You may not submit this application');
      assertSubmittable(app);
      const previous = {
        status: app.status,
        riskStatus: app.riskStatus,
        riskResult: app.riskResult,
        submittedAt: app.submittedAt,
      };
      app.status = statusAfterSubmit(app);
      app.riskStatus = RiskStatus.PENDING;
      app.riskResult = null;
      app.submissionVersion += 1;
      app.submittedAt = new Date();
      const saved = await em.getRepository(MerchantApplication).save(app);
      await this.audit.record(
        actor.id, AuditAction.APPLICATION_SUBMITTED, saved.id,
        { fromStatus: previous.status, toStatus: saved.status, submissionVersion: saved.submissionVersion }, em,
      );
      return { saved, previous };
    });

    // Enqueue after commit so the worker can never see an uncommitted row. If Redis is down we
    // compensate rather than leave a PENDING application with no job (a transactional outbox is
    // the production-grade answer - see docs/adr/001).
    try {
      await this.riskQueue.add(
        RISK_JOB,
        { applicationId: saved.id, submissionVersion: saved.submissionVersion },
        riskJobOptions(
          this.config.get<number>('RISK_JOB_ATTEMPTS', 4),
          this.config.get<number>('RISK_BACKOFF_MS', 1000),
          riskJobId(saved.id, saved.submissionVersion),
        ),
      );
    } catch (err) {
      this.logger.error(`Failed to enqueue risk job for application ${saved.id}`, err instanceof Error ? err.stack : undefined);
      await this.revertSubmission(saved, previous, actor);
      throw new ServiceUnavailableException('Risk review could not be scheduled; the submission was rolled back. Please retry.');
    }
    return saved;
  }

  async assignReviewer(id: string, reviewerId: string, actor: RequestUser) {
    if (actor.role !== UserRole.ADMIN) throw new ForbiddenException('Only ADMIN can assign reviewers');
    const reviewer = await this.users.findActiveReviewer(reviewerId);
    if (!reviewer) throw new BadRequestException('reviewerId must refer to an active user with the REVIEWER role');

    return this.mutate(id, actor, async (app, em) => {
      assertAssignable(app);
      const previousReviewerId = app.assignedReviewerId;
      app.assignedReviewerId = reviewer.id;
      app.status = ApplicationStatus.IN_REVIEW;
      const saved = await em.getRepository(MerchantApplication).save(app);
      await this.audit.record(actor.id, AuditAction.REVIEWER_ASSIGNED, saved.id, { reviewerId: reviewer.id, previousReviewerId }, em);
      return saved;
    });
  }

  decide(id: string, decision: Decision, actor: RequestUser, note?: string) {
    return this.mutate(id, actor, async (app, em) => {
      // Checked under the row lock, so a concurrent reassignment cannot let a former reviewer slip through.
      if (!ApplicationPolicy.canDecide(app, actor)) {
        throw new ForbiddenException('Only the assigned reviewer can record a decision');
      }
      assertDecidable(app, decision);
      const fromStatus = app.status;
      app.status = decision;
      app.decidedAt = new Date();
      app.decidedById = actor.id;
      const saved = await em.getRepository(MerchantApplication).save(app);
      await this.audit.record(
        actor.id, AuditAction.APPLICATION_DECIDED, saved.id,
        { decision, fromStatus, riskStatus: saved.riskStatus, note }, em,
      );
      return saved;
    });
  }

  /**
   * Loads the row `FOR UPDATE` inside a transaction and applies the view policy before running
   * `fn`. Locking serialises concurrent submit/assign/decide calls on one application, so state
   * transitions are checked against the latest committed state, not a stale read.
   */
  private mutate<T>(id: string, actor: RequestUser, fn: (app: MerchantApplication, em: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (em) => {
      const app = await em.getRepository(MerchantApplication).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!app || !ApplicationPolicy.canView(app, actor)) throw new NotFoundException('Application not found');
      return fn(app, em);
    });
  }

  private async revertSubmission(
    saved: MerchantApplication,
    previous: Pick<MerchantApplication, 'status' | 'riskStatus' | 'riskResult' | 'submittedAt'>,
    actor: RequestUser,
  ) {
    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(MerchantApplication);
      const app = await repo.findOne({ where: { id: saved.id }, lock: { mode: 'pessimistic_write' } });
      // submissionVersion is deliberately not decremented: it stays monotonic so job ids are never reused.
      if (!app || app.submissionVersion !== saved.submissionVersion || app.riskStatus !== RiskStatus.PENDING) return;
      Object.assign(app, previous);
      await repo.save(app);
      await this.audit.record(actor.id, AuditAction.RISK_ENQUEUE_FAILED, app.id, { restoredStatus: previous.status }, em);
    });
  }
}
