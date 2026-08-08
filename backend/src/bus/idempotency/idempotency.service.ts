import { Injectable } from '@nestjs/common';
import {
  IdempotencyRepository,
  type IdempotencyKind,
} from '../../persistence/repositories/idempotency.repository.js';
import { Clock } from '../../common/clock.js';

/**
 * Idempotency guard (spec §14): an `idempotency_key` may produce at most one
 * event, so duplicate publishes do not cause duplicate business side effects.
 */
@Injectable()
export class IdempotencyService {
  constructor(
    private readonly repo: IdempotencyRepository,
    private readonly clock: Clock,
  ) {}

  async existingEventId(key: string): Promise<string | null> {
    return this.repo.findEventIdByKey(key);
  }

  async record(key: string, eventId: string, kind: IdempotencyKind): Promise<void> {
    await this.repo.insertIfAbsent(key, eventId, kind, this.clock.now());
  }
}
