import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { type Job, type JobsOptions, Worker } from 'bullmq';
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
import { QueueManager } from '../queue/queue-manager.service.js';
import { RedisConnection } from '../queue/redis-connection.service.js';
import { eventKindOf } from '../event-kind.js';
import { resolveRetry } from './retry-policy.js';

export interface DeliveryJobData {
  eventId: string;
  agentId: string;
  appId: string;
}

const FALLBACK_RETRY = { max_attempts: 1, backoff_ms: 0, dead_letter: true };
const STILL_SCHEDULED = new Set([
  'waiting',
  'delayed',
  'prioritized',
  'active',
  'paused',
  'waiting-children',
]);

/**
 * BullMQ delivery worker (spec §10): hydrates the event from MySQL, re-checks
 * task/lease state, delivers through the target adapter, honours retry limits
 * and dead-letters exhausted deliveries. Redis is not the source of truth.
 */
@Injectable()
export class DeliveryService implements OnModuleDestroy {
  private readonly workers: Worker[] = [];
  private readonly logger = new Logger(DeliveryService.name);
  private initialized = false;

  constructor(
    private readonly clock: Clock,
    private readonly queueManager: QueueManager,
    private readonly redis: RedisConnection,
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

  /** One worker per queue (app_id + agent_id); concurrency from the Package. */
  init(snapshot: AppSnapshot): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    for (const agentId of snapshot.agentIds) {
      const queue = this.queueManager.ensure(snapshot.appId, agentId);
      const installed = this.registry.get(agentId);
      const concurrency = installed?.concurrency.limit ?? 4;
      const worker = new Worker<DeliveryJobData>(
        queue.name,
        async (job) => this.process(job),
        { connection: this.redis.client, concurrency },
      );
      worker.on('error', (error) =>
        this.logger.error(`BullMQ worker error on ${queue.name}`, error.stack),
      );
      worker.on('failed', (job, error) => {
        if (!job) {
          return;
        }
        void this.onWorkerFailed(job, error);
      });
      this.workers.push(worker);
    }
  }

  /**
   * Re-queues deliveries that still owe a BullMQ job after a restart (spec
   * §14). Only deliveries for agents still in the current App snapshot are
   * recovered; a removed agent has no worker and its jobs would sit forever.
   * Re-added jobs keep the remaining attempt budget and the effective backoff,
   * so a delivery that was mid-backoff does not fire immediately.
   */
  async recoverFromMysql(): Promise<void> {
    const snapshot = this.runtime.current;
    const pending = await this.deliveriesRepo.findRecoverable(this.clock.now());
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
      const queue = this.queueManager.ensure(delivery.appId, delivery.agentId);
      const existing = await queue.getJob(delivery.id).catch(() => null);
      if (existing) {
        const state = await existing.getState().catch(() => 'unknown');
        if (STILL_SCHEDULED.has(state) || state === 'completed') {
          continue;
        }
        if (state === 'failed') {
          await existing.remove().catch(() => undefined);
        }
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
      const remaining = Math.max(1, delivery.maxAttempts - delivery.attempts);
      const jobOptions: JobsOptions = {
        jobId: delivery.id,
        attempts: remaining,
        priority: event.priority,
        removeOnComplete: true,
        removeOnFail: false,
      };
      if (remaining > 1) {
        const delayMs = this.remainingBackoffMs(delivery, effective.backoffMs);
        if (delayMs > 0) {
          jobOptions.backoff = { type: 'fixed', delay: delayMs };
        }
      }
      await queue.add(
        'deliver',
        { eventId: delivery.eventId, agentId: delivery.agentId, appId: delivery.appId },
        jobOptions,
      );
    }
  }

  /**
   * Remaining delay for a recovered retrying delivery: honour the recorded
   * `next_attempt_at` when it is still in the future, else the policy backoff.
   */
  private remainingBackoffMs(delivery: RecoverableDelivery, policyMs: number): number {
    if (delivery.nextAttemptAt) {
      const remaining =
        new Date(fromMysqlDatetime(delivery.nextAttemptAt)).getTime() -
        this.clock.nowMs();
      if (remaining > 0) {
        return remaining;
      }
    }
    return policyMs;
  }

  private async process(job: Job<DeliveryJobData>): Promise<string> {
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
      return 'skipped';
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
        return 'skipped';
      }
    }

    // Physical action that ended `unknown` must not auto-replay (spec §11).
    if (kind === 'physical' && (await this.physicalState.isPaused(eventId, agentId))) {
      return 'paused';
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
    return 'delivered';
  }

  private async onWorkerFailed(job: Job<DeliveryJobData>, error: Error): Promise<void> {
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
      // BullMQ increments job.attemptsMade inside moveToFailed before emitting
      // 'failed', so it already counts the attempt that just failed. The total
      // budget to compare against is the job's own `attempts` — after recovery
      // that is the remaining budget, not the full policy maximum.
      const attemptsMade = job.attemptsMade;
      const totalAttempts = job.opts.attempts ?? 1;
      const id = deliveryId(eventId, agentId);
      const now = this.clock.now();

      if (attemptsMade >= totalAttempts) {
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
    await Promise.allSettled(this.workers.map((worker) => worker.close()));
    await this.queueManager.closeAll();
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }
}
