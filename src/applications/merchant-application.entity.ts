import {
  Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne,
  PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';
import { encryptedColumn } from '../common/crypto/field-encryption';
import { User } from '../users/user.entity';

export enum ApplicationStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  IN_REVIEW = 'IN_REVIEW',
  NEEDS_INFORMATION = 'NEEDS_INFORMATION',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum RiskStatus {
  NOT_STARTED = 'NOT_STARTED',
  PENDING = 'PENDING',
  CLEAR = 'CLEAR',
  FLAGGED = 'FLAGGED',
  FAILED = 'FAILED',
}

export enum BusinessType {
  SOLE_PROPRIETORSHIP = 'SOLE_PROPRIETORSHIP',
  PARTNERSHIP = 'PARTNERSHIP',
  LLC = 'LLC',
  CORPORATION = 'CORPORATION',
  NON_PROFIT = 'NON_PROFIT',
}

@Entity('merchant_applications')
@Index('idx_applications_creator_status', ['createdById', 'status'])
@Index('idx_applications_reviewer_status', ['assignedReviewerId', 'status'])
@Index('idx_applications_status_created', ['status', 'createdAt'])
export class MerchantApplication {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'business_name' })
  businessName: string;

  @Column({ name: 'legal_business_name' })
  legalBusinessName: string;

  @Column({ name: 'business_type' })
  businessType: BusinessType;

  // PII: encrypted at rest (AES-256-GCM, see common/crypto/field-encryption.ts). Not filterable in SQL.
  @Column({ name: 'owner_name', type: 'text', transformer: encryptedColumn })
  ownerName: string;

  @Column({ name: 'contact_email', type: 'text', transformer: encryptedColumn })
  contactEmail: string;

  @Column({ name: 'requested_monthly_volume', type: 'numeric', precision: 14, scale: 2 })
  requestedMonthlyVolume: string;

  @Column({ name: 'requested_average_transaction', type: 'numeric', precision: 12, scale: 2 })
  requestedAverageTransaction: string;

  @Column({ type: 'enum', enum: ApplicationStatus, default: ApplicationStatus.DRAFT })
  status: ApplicationStatus;

  @Column({ name: 'risk_status', type: 'enum', enum: RiskStatus, default: RiskStatus.NOT_STARTED })
  riskStatus: RiskStatus;

  @Column({ name: 'risk_result', type: 'jsonb', nullable: true })
  riskResult: Record<string, unknown> | null;

  @Column({ name: 'created_by_id', type: 'uuid' })
  createdById: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User;

  @Column({ name: 'assigned_reviewer_id', type: 'uuid', nullable: true })
  assignedReviewerId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_reviewer_id' })
  assignedReviewer: User | null;

  /** Incremented on every (re)submission; part of the risk job id so stale jobs can be detected. */
  @Column({ name: 'submission_version', type: 'int', default: 0 })
  submissionVersion: number;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ name: 'decided_by_id', type: 'uuid', nullable: true })
  decidedById: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
