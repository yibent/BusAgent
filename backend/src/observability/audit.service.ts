import { Injectable } from '@nestjs/common';
import { AuditRepository } from '../persistence/repositories/audit.repository.js';

@Injectable()
export class AuditService {
  constructor(private readonly repo: AuditRepository) {}

  async append(
    action: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> | null,
  ): Promise<void> {
    await this.repo.append(action, entityType, entityId, detail);
  }
}
