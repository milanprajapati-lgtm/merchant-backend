import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum AuditAction {
  APPLICATION_CREATED = 'APPLICATION_CREATED',
  APPLICATION_UPDATED = 'APPLICATION_UPDATED',
  APPLICATION_SUBMITTED = 'APPLICATION_SUBMITTED',
  REVIEWER_ASSIGNED = 'REVIEWER_ASSIGNED',
  APPLICATION_DECIDED = 'APPLICATION_DECIDED',
  RISK_ENQUEUE_FAILED = 'RISK_ENQUEUE_FAILED',
  RISK_REVIEW_COMPLETED = 'RISK_REVIEW_COMPLETED',
  RISK_REVIEW_FAILED = 'RISK_REVIEW_FAILED',
}

@Entity('audit_logs')
@Index('idx_audit_resource', ['resourceType', 'resourceId', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** NULL means the action was performed by the system (e.g. the risk worker), not a user. */
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ name: 'action', length: 100 })
  action: string;

  @Column({ name: 'resource_type', default: 'MERCHANT_APPLICATION' })
  resourceType: string;

  @Column({ name: 'resource_id', type: 'uuid' })
  resourceId: string;

  // Only safe metadata belongs here. AuditService redacts known-sensitive keys before insert.
  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
