import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Clock } from '../../common/clock.js';
import { deliveryId } from '../../common/ids.js';
import type { AppSnapshot } from '../../app/startup-snapshot.js';
import { RegistryService } from '../../registry/registry.service.js';
import { LeaseManager } from '../../leases/lease-manager.service.js';
import { RuntimeState } from '../../app/runtime-state.service.js';
import { AgentAdapterFactory } from '../../adapters/agent-adapter-factory.js';
import { EventsRepository } from '../../persistence/repositories/events.repository.js';
import {
  DeliveriesRepository,
  type RecoverableDelivery,
} from '../../persistence/repositories/deliveries.repository.js';
import { DeadLettersRepository } from '../../persistence/repositories/dead-letters.repository.js';
import { fromMysqlDatetime } from '../../persistence/db/mysql-datetime.js';
import { TaskService } from '../tasks/task.service.js';
import { PhysicalActionState } from '../physical/physical-action-state.service.js';
import {
  QueueManager,
  type DeliveryJob,
} from '../queue/queue-manager.service.js';
import { eventKindOf } from '../event-kind.js';
import { resolveRetry } from './retry-policy.js';

const FALLBACK_RETRY = { max_attempts: 1, backoff_ms: 0, dead_letter: true };

/**
 * In-process delivery worker (spec §10): hydrates the event from MySQL, re-checks
 * task/lease state, delivers through the target adapter, honours retry limits
 * and dead-letters exhausted deliveries. MySQL is the source of truth; the
 * in-process queue is reconstructed on startup from delivery rows.
 */
@Injectable()
export class DeliveryService implements OnModuleDestroy {
  private readonly logger = new Logger(DeliveryService.name);
  private initialized = false;

  constructor(
    private readonly clock: Clock,
    private readonly queueManager: QueueManager,
    private readonly adapterFactory: AgentAdapterFactory,
    private readonly registry: RegistryService,
    private readonly leases: LeaseManager,
    private readonly runtime: RuntimeState,
    private readonly eventsRepo: EventsRepository,
    private readonly deliveriesRepo: DeliveriesRepository,
    private readonly deadLettersRepo: DeadLettersRepository,
    private readonly taskService: TaskService,
    private readonly physicalState: PhysicalActionState,
  ) {}

  /** One queue per app_id + agent_id; concurrency from the Package. */
  init(snapshot: AppSnapshot): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    for (const agentId of snapshot.agentIds) {
      const installed = this.registry.get(agentId);
      const concurrency = installed?.concurrency.limit ?? 4;
      const queue = this.queueManager.ensure(snapshot.appId, agentId, concurrency);
      queue.setProcessor(
        async (job) => this.process(job),
        async (job, error) => this.onFailed(job, error),
      );
    }
  }

  /**
   * Re-queues deliveries that still owe a job after a restart (spec §14).
   * Only deliveries for agents still in the current App snapshot are recovered;
   * a removed agent has no worker and its jobs would sit forever. Delayed
   * retries honour `next_attempt_at` when it is still in the future.
   */
  async recoverFromMysql(): Promise<void> {
    const snapshot = this.runtime.current;
    const pending = await this.deliveriesRepo.findRecoverable();
    for (const delivery of pending) {
      if (delivery.appId !== snapshot.appId || !snapshot.agents.has(delivery.agentId)) {
        await this.deliveriesRepo.recordAttempt(delivery.id, {
          status: 'dead',
          attempts: delivery.attempts,
          lastError: 'agent no longer in the app snapshot; delivery not recovered',
          updatedAt: this.clock.now(),
        });
        continue;
      }
      if (delivery.attempts >= delivery.maxAttempts) {
        await this.deliveriesRepo.recordAttempt(delivery.id, {
          status: 'dead',
          attempts: delivery.attempts,
          lastError: 'max attempts already exhausted; delivery not recovered',
          updatedAt: this.clock.now(),
        });
        continue;
      }
      const queue = this.queueManager.ensure(delivery.appId, delivery.agentId);
      if (queue.has(delivery.id)) {
        continue;
      }
      const event = await this.eventsRepo.findById(delivery.eventId);
      if (!event) {
        continue;
      }
      const entry = snapshot.agents.get(delivery.agentId);
      const kind = eventKindOf(event, this.registry);
      const effective = resolveRetry(
        entry?.packageRetry ?? FALLBACK_RETRY,
        entry?.retryOverride,
        kind,
      );
      queue.enqueue(
        {
          id: delivery.id,
          data: {
            eventId: delivery.eventId,
            agentId: delivery.agentId,
            appId: delivery.appId,
          },
          attemptsMade: delivery.attempts,
          maxAttempts: delivery.maxAttempts,
          priority: event.priority,
          backoffMs: effective.backoffMs,
        },
        this.enqueueDelayMs(delivery, effective.backoffMs),
      );
    }
  }

  /**
   * Delay before a recovered job runs: honour a future `next_attempt_at`,
   * otherwise run immediately for a never-attempted row, else the policy backoff.
   */
  private enqueueDelayMs(delivery: RecoverableDelivery, policyMs: number): number {
    if (delivery.nextAttemptAt) {
      const remaining =
        new Date(fromMysqlDatetime(delivery.nextAttemptAt)).getTime() -
        this.clock.nowMs();
      if (remaining > 0) {
        return remaining;
      }
    }
    if (delivery.attempts === 0) {
      return 0;
    }
    return policyMs;
  }

  private async process(job: DeliveryJob): Promise<void> {
    const { eventId, agentId } = job.data;
    const event = await this.eventsRepo.findById(eventId);
    if (!event) {
      throw new Error(`Delivery references missing event ${eventId}`);
    }
    const snapshot = this.runtime.current;
    const entry = snapshot.agents.get(agentId);
    const installed = this.registry.get(agentId);
    if (!entry || !installed) {
      throw new Error(`No runtime entry for agent ${agentId}`);
    }

    const kind = eventKindOf(event, this.registry);

    // Re-check the lease before each attempt: an event routed while the lease
    // was active must not reach an agent whose lease has since expired (spec
    // §14). Marked `skipped` so it is not retried into a dead agent.
    if (!this.leases.isActive(agentId)) {
      await this.deliveriesRepo.recordAttempt(deliveryId(eventId, agentId), {
        status: 'skipped',
        attempts: job.attemptsMade + 1,
        updatedAt: this.clock.now(),
      });
      return;
    }

    // Re-check task state before each delivery attempt (spec §10).
    if (
      kind === 'task' &&
      event.taskId !== undefined &&
      event.taskVersion !== undefined
    ) {
      const verdict = await this.taskService.checkVersion(
        event.taskId,
        event.taskVersion,
      );
      if (verdict === 'stale' || verdict === 'cancelled') {
        await this.deliveriesRepo.recordAttempt(deliveryId(eventId, agentId), {
          status: verdict === 'cancelled' ? 'cancelled' : 'skipped',
          attempts: job.attemptsMade + 1,
          updatedAt: this.clock.now(),
        });
        return;
      }
    }

    // Physical action that ended `unknown` must not auto-replay (spec §11).
    if (kind === 'physical' && (await this.physicalState.isPaused(eventId, agentId))) {
      return;
    }

    const adapter = this.adapterFactory.forAgent(installed);
    const ack = await adapter.deliver(event, entry.runtimeConfig);
    if (!ack.ok) {
      throw new Error(`Delivery rejected: ${ack.reason}`);
    }

    await this.deliveriesRepo.recordAttempt(deliveryId(eventId, agentId), {
      status: 'delivered',
      attempts: job.attemptsMade + 1,
      deliveredAt: this.clock.now(),
      updatedAt: this.clock.now(),
    });
  }

  private async onFailed(job: DeliveryJob, error: Error): Promise<void> {
    try {
      const { eventId, agentId } = job.data;
      const event = await this.eventsRepo.findById(eventId);
      if (!event) {
        return;
      }
      const entry = this.runtime.current.agents.get(agentId);
      const kind = eventKindOf(event, this.registry);
      const effective = resolveRetry(
        entry?.packageRetry ?? FALLBACK_RETRY,
        entry?.retryOverride,
        kind,
      );
      const attemptsMade = job.attemptsMade;
      const id = deliveryId(eventId, agentId);
      const now = this.clock.now();

      if (attemptsMade >= job.maxAttempts) {
        if (kind === 'physical') {
          await this.deadLettersRepo.insert({
            eventId,
            appId: event.appId,
            agentId,
            reason: 'physical action could not be confirmed; manual recovery required',
            detail: { error: error.message, attemptsMade },
          });
          await this.physicalState.markUnknown(eventId, agentId);
        } else if (effective.deadLetter) {
          await this.deadLettersRepo.insert({
            eventId,
            appId: event.appId,
            agentId,
            reason: error.message,
            detail: { attemptsMade, maxAttempts: effective.maxAttempts },
          });
        }
        await this.deliveriesRepo.recordAttempt(id, {
          status: kind === 'physical' ? 'unknown' : 'dead',
          attempts: attemptsMade,
          lastError: error.message,
          updatedAt: now,
        });
      } else {
        await this.deliveriesRepo.recordAttempt(id, {
          status: 'retrying',
          attempts: attemptsMade,
          lastError: error.message,
          nextAttemptAt: new Date(
            this.clock.nowMs() + effective.backoffMs,
          ).toISOString(),
          updatedAt: now,
        });
      }
    } catch (recordingError) {
      this.logger.error(
        'Failed to record delivery failure',
        (recordingError as Error).message,
      );
    }
  }

  async shutdown(): Promise<void> {
    await this.queueManager.closeAll();
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }
}
