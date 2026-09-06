import { executionSpan } from '../observability/execution-span.js';
import { Injectable } from '@nestjs/common';
import { Logger } from '../common/logger.js';
import { BusAgentError } from '../common/errors.js';
import { Clock } from '../common/clock.js';
import { newCorrelationId, newEventId, newTraceId } from '../common/ids.js';
import { HostConfig } from '../config/host-config.js';
import { BusEventSchema, type BusEvent } from '../protocol/envelope.js';
import type { TraceInfo } from '../protocol/trace.js';
import type { AgentPublishInput, HostEventInput } from '../protocol/ingress.js';
import { RegistryService } from '../registry/registry.service.js';
import { LeaseManager } from '../leases/lease-manager.service.js';
import { RuntimeState } from '../app/runtime-state.service.js';
import { Router } from './routing/router.service.js';
import { DeliveryScheduler } from './delivery/delivery-scheduler.service.js';
import { EventsRepository } from '../persistence/repositories/events.repository.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import { TaskService } from './tasks/task.service.js';
import { PhysicalActionState } from './physical/physical-action-state.service.js';
import { AuditService } from '../observability/audit.service.js';
import { hasExecutionCredential, isPhysicalEventType } from './event-kind.js';
import { ConversationHub } from '../modules/conversation/conversation-hub.js';

interface BuildEventInput {
  appId: string;
  eventType: string;
  sourceAgentId: string;
  correlationId?: string;
  causationId?: string;
  taskId?: string;
  taskVersion?: number;
  priority?: number;
  deadline?: string;
  idempotencyKey?: string;
  payload: unknown;
}

/**
 * Unified event ingress (spec §8): every agent — in-process or HTTP — publishes
 * through this path. The host generates the eventId, receive time and trace,
 * persists the full JSON body to MySQL, applies idempotency/task-version gates
 * and routes the event to the App's allowed targets.
 */
@Injectable()
export class EventBus {
  private readonly logger = new Logger('EventBus');

  constructor(
    private readonly clock: Clock,
    private readonly config: HostConfig,
    private readonly registry: RegistryService,
    private readonly leases: LeaseManager,
    private readonly runtime: RuntimeState,
    private readonly router: Router,
    private readonly scheduler: DeliveryScheduler,
    private readonly eventsRepo: EventsRepository,
    private readonly idempotency: IdempotencyService,
    private readonly taskService: TaskService,
    private readonly physicalState: PhysicalActionState,
    private readonly audit: AuditService,
    private readonly conversationHub: ConversationHub,
  ) {}

  async publishFromAgent(agentId: string, input: AgentPublishInput): Promise<BusEvent> {
    const agent = this.registry.get(agentId);
    if (!agent) {
      throw new BusAgentError(
        'AGENT_NOT_INSTALLED',
        `Unknown source agent_id: ${agentId}`,
      );
    }
    if (!agent.produces.includes(input.event_type)) {
      throw new BusAgentError(
        'AGENT_CONTRACT_VIOLATION',
        `Agent ${agentId} is not declared to produce ${input.event_type}`,
        { sourceAgentId: agentId, eventType: input.event_type },
      );
    }
    if (!this.leases.isActive(agentId)) {
      throw new BusAgentError(
        'SOURCE_NOT_REGISTERED',
        `Agent ${agentId} has no active lease; events are not accepted`,
        { sourceAgentId: agentId },
      );
    }
    const event = this.buildEvent({
      appId: this.runtime.current.appId,
      eventType: input.event_type,
      sourceAgentId: agentId,
      ...(input.correlation_id !== undefined
        ? { correlationId: input.correlation_id }
        : {}),
      ...(input.causation_id !== undefined ? { causationId: input.causation_id } : {}),
      ...(input.task_id !== undefined ? { taskId: input.task_id } : {}),
      ...(input.task_version !== undefined ? { taskVersion: input.task_version } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
      ...(input.idempotency_key !== undefined
        ? { idempotencyKey: input.idempotency_key }
        : {}),
      payload: input.payload,
    });
    await this.persistAndRoute(event, input.suggested_targets);
    return event;
  }

  /** Host-originated input (e.g. system / CLI), source is `system.input`. */
  async ingestHostEvent(input: HostEventInput): Promise<BusEvent> {
    const event = this.buildEvent({
      appId: input.app_id,
      eventType: input.event_type,
      sourceAgentId: 'system.input',
      ...(input.correlation_id !== undefined
        ? { correlationId: input.correlation_id }
        : {}),
      ...(input.causation_id !== undefined ? { causationId: input.causation_id } : {}),
      ...(input.task_id !== undefined ? { taskId: input.task_id } : {}),
      ...(input.task_version !== undefined ? { taskVersion: input.task_version } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
      ...(input.idempotency_key !== undefined
        ? { idempotencyKey: input.idempotency_key }
        : {}),
      payload: input.payload,
    });
    await this.persistAndRoute(event, input.suggested_targets);
    return event;
  }

  private buildEvent(input: BuildEventInput): BusEvent {
    const event: BusEvent = {
      eventId: newEventId(),
      eventType: input.eventType,
      appId: input.appId,
      sourceAgentId: input.sourceAgentId,
      correlationId: input.correlationId ?? newCorrelationId(),
      priority: input.priority ?? 0,
      createdAt: this.clock.now(),
      payload: input.payload ?? {},
      ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.taskVersion !== undefined ? { taskVersion: input.taskVersion } : {}),
      ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
      ...(input.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
    };
    return BusEventSchema.parse(event);
  }

  private async persistAndRoute(
    event: BusEvent,
    suggestedTargets?: string[],
  ): Promise<void> {
    const now = this.clock.now();

    // Physical side effects require an execution credential and an idempotency
    // key; the envelope is rejected outright otherwise (spec §10).
    if (isPhysicalEventType(event.eventType, this.registry)) {
      if (!event.idempotencyKey || !hasExecutionCredential(event.payload)) {
        throw new BusAgentError(
          'ENVELOPE_INVALID',
          `Physical side-effect event ${event.eventType} requires idempotency_key and an execution credential`,
        );
      }
    }

    let taskVerdict: 'stale' | 'cancelled' | null = null;
    let gateTaskId: string | undefined;
    let gateTaskVersion: number | undefined;
    if (event.taskId !== undefined && event.taskVersion !== undefined) {
      gateTaskId = event.taskId;
      gateTaskVersion = event.taskVersion;
      const verdict = await this.taskService.checkVersion(gateTaskId, gateTaskVersion);
      if (verdict === 'stale' || verdict === 'cancelled') {
        taskVerdict = verdict;
      } else {
        await this.taskService.ensureTask(gateTaskId, event.appId, gateTaskVersion);
      }
    }

    const isPhysical = isPhysicalEventType(event.eventType, this.registry);
    const status: 'ingested' | 'stale' | 'dropped' =
      taskVerdict === 'stale'
        ? 'stale'
        : taskVerdict === 'cancelled'
          ? 'dropped'
          : 'ingested';

    // The idempotency claim and the event row persist in one transaction, so
    // concurrent publishes carrying the same idempotency_key cannot both be
    // routed (spec §14): the unique key is the gate, not a check-then-insert.
    // A replay (key already claimed by an earlier event) is audited and dropped.
    const claim =
      event.idempotencyKey !== undefined
        ? {
            key: event.idempotencyKey,
            kind: isPhysical ? ('physical' as const) : ('publish' as const),
            nowIso: now,
          }
        : undefined;
    const result = await this.eventsRepo.insert(
      event,
      { receivedAt: now, trace: this.trace(now), status },
      claim,
    );

    if (result === 'replay') {
      const originalEventId =
        event.idempotencyKey !== undefined
          ? await this.idempotency.existingEventId(event.idempotencyKey)
          : null;
      this.logger.info(
        `idempotent replay event=${event.eventId} original=${originalEventId}`,
      );
      await this.audit.append('idempotent.replay', 'event', event.eventId, {
        idempotencyKey: event.idempotencyKey,
        originalEventId,
      });
      return;
    }

    if (taskVerdict !== null) {
      await this.audit.append(
        taskVerdict === 'stale' ? 'event.stale' : 'event.task-cancelled',
        'event',
        event.eventId,
        { taskId: gateTaskId, taskVersion: gateTaskVersion },
      );
      return;
    }

    this.conversationHub.publish(event.correlationId, {
      type: 'bus.event',
      event_id: event.eventId,
      event_type: event.eventType,
      source_agent_id: event.sourceAgentId,
      task_id: event.taskId,
      task_version: event.taskVersion,
      causation_id: event.causationId,
      correlation_id: event.correlationId,
      source_span_id: executionSpan.getStore()?.id,
      created_at: event.createdAt,
      payload: event.payload,
    });

    // A physical status `unknown` pauses the causating action (spec §11).
    if (event.eventType.endsWith('.unknown') && event.causationId) {
      await this.physicalState.markUnknown(event.causationId, event.sourceAgentId);
    }

    // Cancellation is an event (spec §9); the delivery worker re-checks state.
    if (event.eventType === 'task.cancelled' && event.taskId) {
      await this.taskService.cancelTask(event.taskId);
    }

    const targets = this.router.resolveTargets(event, suggestedTargets);
    if (targets.length === 0) {
      this.logger.info(
        `ingest ${event.eventType} id=${event.eventId} from=${event.sourceAgentId} status=${status} targets=[]`,
      );
      return;
    }
    await this.eventsRepo.markStatus(event.eventId, 'routed');
    this.logger.info(
      `ingest ${event.eventType} id=${event.eventId} from=${event.sourceAgentId} -> [${targets.map((t) => t.agentId).join(', ')}]`,
    );
    await this.scheduler.enqueueAll(event, targets);
  }

  private trace(now: string): TraceInfo {
    return { traceId: newTraceId(), hostId: this.config.hostId, receivedAt: now };
  }
}
