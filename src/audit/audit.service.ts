import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AuditAction, AuditLog } from './audit-log.entity';
import { redactMetadata } from './redact';

@Injectable()
export class AuditService {
  constructor(@InjectRepository(AuditLog) private readonly logs: Repository<AuditLog>) {}

  /**
   * Pass `manager` to write the audit row inside the caller's transaction so a state change
   * and its audit record commit (or roll back) together.
   */
  record(
    actorId: string | null,
    action: AuditAction,
    resourceId: string,
    metadata: Record<string, unknown> = {},
    manager?: EntityManager,
  ) {
    const repo = manager ? manager.getRepository(AuditLog) : this.logs;
    return repo.save(
      repo.create({
        actorId,
        action,
        resourceId,
        resourceType: 'MERCHANT_APPLICATION',
        metadata: redactMetadata(metadata),
      }),
    );
  }

  listForResource(resourceId: string, limit = 100) {
    return this.logs.find({
      where: { resourceId },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: limit,
    });
  }
}
