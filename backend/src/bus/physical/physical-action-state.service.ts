import { Injectable } from '@nestjs/common';
import { deliveryId } from '../../common/ids.js';
import { DeliveriesRepository } from '../../persistence/repositories/deliveries.repository.js';
import { Clock } from '../../common/clock.js';

/**
 * Physical side-effect state (spec §11): once an action enters `unknown`, the
 * host pauses automatic replay and the action goes to manual recovery.
 */
@Injectable()
export class PhysicalActionState {
  constructor(
    private readonly repo: DeliveriesRepository,
    private readonly clock: Clock,
  ) {}

  async markUnknown(eventId: string, agentId: string): Promise<void> {
    await this.repo.recordAttempt(deliveryId(eventId, agentId), {
      status: 'unknown',
      attempts: 1,
      updatedAt: this.clock.now(),
    });
  }

  async isPaused(eventId: string, agentId: string): Promise<boolean> {
    return this.repo.hasUnknown(eventId, agentId);
  }
}
