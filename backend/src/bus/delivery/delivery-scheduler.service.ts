import { Injectable } from '@nestjs/common';
import { type JobsOptions } from 'bullmq';
import { Clock } from '../../common/clock.js';
import { deliveryId } from '../../common/ids.js';
import { QueueManager } from '../queue/queue-manager.service.js';
import { RuntimeState } from '../../app/runtime-state.service.js';
import { DeliveriesRepository } from '../../persistence/repositories/deliveries.repository.js';
import { resolveRetry } from './retry-policy.js';
import type { BusEvent } from '../../protocol/envelope.js';
import type { DeliveryTarget } from '../routing/router.service.js';

/**
 * Persists a delivery record and enqueues the BullMQ job for every resolved
 * target. Kept separate from the delivery worker so the event bus never depends
 * on the adapters (avoids a circular module graph).
 */
@Injectable()
export class DeliveryScheduler {
  constructor(
    private readonly clock: Clock,
    private readonly queueManager: QueueManager,
    private readonly runtime: RuntimeState,
    private readonly deliveriesRepo: DeliveriesRepository,
  ) {}

  async enqueueAll(event: BusEvent, targets: DeliveryTarget[]): Promise<void> {
    for (const target of targets) {
      const queue = this.queueManager.ensure(target.appId, target.agentId);
      const entry = this.runtime.current.agents.get(target.agentId);
      const effective = resolveRetry(
        target.packageRetry,
        entry?.retryOverride,
        target.eventKind,
      );
      const id = deliveryId(event.eventId, target.agentId);
      const now = this.clock.now();

      await this.deliveriesRepo.create({
        id,
        eventId: event.eventId,
        appId: target.appId,
        agentId: target.agentId,
        queueName: queue.name,
        maxAttempts: effective.maxAttempts,
        createdAt: now,
      });

      const jobOptions: JobsOptions = {
        jobId: id,
        attempts: effective.maxAttempts,
        priority: event.priority,
        removeOnComplete: true,
        removeOnFail: false,
      };
      if (effective.maxAttempts > 1) {
        jobOptions.backoff = { type: 'fixed', delay: effective.backoffMs };
      }
      await queue.add(
        'deliver',
        { eventId: event.eventId, agentId: target.agentId, appId: target.appId },
        jobOptions,
      );
    }
  }
}
