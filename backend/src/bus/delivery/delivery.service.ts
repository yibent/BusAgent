import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { type Job, Worker } from 'bullmq';
import { Clock } from '../../common/clock.js';
import { deliveryId } from '../../common/ids.js';
import type { AppSnapshot } from '../../app/startup-snapshot.js';
import { RegistryService } from '../../registry/registry.service.js';
import { RuntimeState } from '../../app/runtime-state.service.js';
import { AgentAdapterFactory } from '../../adapters/agent-adapter-factory.js';
import { EventsRepository } from '../../persistence/repositories/events.repository.js';
import { DeliveriesRepository } from '../../persistence/repositories/deliveries.repository.js';
import { DeadLettersRepository } from '../../persistence/repositories/dead-letters.repository.js';
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
    private readonly runtime: RuntimeState,
    private readonly eventsRepo: EventsRepository,
    private readonly deliveriesRepo: DeliveriesRepository,
    private readonly deadLettersRepo: DeadLettersRepository,
    private readonly taskService: TaskService,
    private readonly physicalState: PhysicalActionState,
  ) {}

  /** One worker per queue (app_id + agent_id). */
  init(snapshot: AppSnapshot): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    for (const agentId of snapshot.agentIds) {
      const queue = this.queueManager.ensure(snapshot.appId, agentId);
      const worker = new Worker<DeliveryJobData>(
        queue.name,
        async (job) => this.process(job),
        { connection: this.redis.client, concurrency: 4 },
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

  /** Re-queues deliveries that still owe a BullMQ job after a restart (spec §14). */
  async recoverFromMysql(): Promise<void> {
    const pending = await this.deliveriesRepo.findRecoverable(this.clock.now());
    for (const delivery of pending) {
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
      await queue.add(
        'deliver',
        { eventId: delivery.eventId, agentId: delivery.agentId, appId: delivery.appId },
        {
          jobId: delivery.id,
          attempts: delivery.maxAttempts,
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }
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
      const attemptsMade = job.attemptsMade + 1;
      const id = deliveryId(eventId, agentId);
      const now = this.clock.now();

      if (attemptsMade >= effective.maxAttempts) {
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
