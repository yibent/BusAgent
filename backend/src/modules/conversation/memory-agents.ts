import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../adapters/in-process/agent-classes.js';
import { ContextMemory } from './context-memory.js';
import { MEMORY_TYPES } from './context-format.js';

@Injectable()
export class MemoryAgent implements InProcessAgent, OnModuleInit {
  readonly registrationKey = 'MemoryAgentNode';
  constructor(private readonly memory: ContextMemory) {}
  onModuleInit() {
    if (!AgentClasses.has(this.registrationKey))
      AgentClasses.register(this.registrationKey, this);
  }
  async handle(context: InProcessEventContext) {
    if (!MEMORY_TYPES.includes(context.event.eventType)) return;
    const snapshot = await this.memory.materialize(context.event.correlationId);
    if (!snapshot) return;
    await context.publish({
      event_type: 'memory.updated',
      correlation_id: context.event.correlationId,
      causation_id: context.event.eventId,
      idempotency_key: `memory:${snapshot.version}`,
      payload: {
        memory_version: snapshot.version,
        source_cursor: snapshot.source_cursor,
        entries: snapshot.entries.length,
        older_history_available: snapshot.has_more,
      },
    });
  }
}

@Injectable()
export class ContextCompressionAgent implements InProcessAgent, OnModuleInit {
  readonly registrationKey = 'ContextCompressionAgentNode';
  constructor(private readonly memory: ContextMemory) {}
  onModuleInit() {
    if (!AgentClasses.has(this.registrationKey))
      AgentClasses.register(this.registrationKey, this);
  }
  async handle(context: InProcessEventContext) {
    if (context.event.eventType !== 'memory.updated') return;
    // Warm the actual planner / dialogue budgets, off the execution lane.
    // view() always checks current archive and queue state, even for a delayed event.
    const views = await Promise.all(
      [2000, 2400, 4200].map((budget) =>
        this.memory.view(context.event.correlationId, budget),
      ),
    );
    await context.publish({
      event_type: 'context.compacted',
      correlation_id: context.event.correlationId,
      causation_id: context.event.eventId,
      idempotency_key: `context:${context.event.eventId}`,
      payload: {
        method: 'extractive',
        model_calls: 0,
        views: views.map((view) => ({
          budget: view.budget_tokens,
          estimated_tokens: view.estimated_tokens,
          omitted: view.omitted,
          archive_available: true,
        })),
      },
    });
  }
}
