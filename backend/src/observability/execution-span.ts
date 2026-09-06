import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { BusEvent } from '../protocol/envelope.js';
import type { ConversationHub } from '../modules/conversation/conversation-hub.js';

interface SpanContext {
  id: string;
  track<T>(run: () => T | Promise<T>): Promise<T>;
  annotate(loop: 'fast' | 'slow', model?: string): void;
}
// UI telemetry never enters business routing, model input or persisted history.
export const executionSpan = new AsyncLocalStorage<SpanContext>();
export function trackBackground<T>(run: () => T | Promise<T>): Promise<T> {
  return executionSpan.getStore()?.track(run) ?? Promise.resolve().then(run);
}
export function markExecutionLoop(loop: 'fast' | 'slow', model?: string): void {
  executionSpan.getStore()?.annotate(loop, model);
}

/** Keep spans alive for detached work without holding the bus delivery lane. */
export async function traceExecution<T>(
  hub: ConversationHub,
  event: BusEvent,
  agentId: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const id = randomUUID();
  const started = Date.now();
  let pending = 1,
    failed = false,
    closed = false;
  let loop: 'fast' | 'slow' | undefined;
  const models = new Set<string>();
  const send = (state: 'started' | 'updated' | 'completed' | 'failed') => {
    hub.publish(event.correlationId, {
      type: 'bus.event',
      event_id: randomUUID(),
      event_type: `node.${state}`,
      source_agent_id: agentId,
      correlation_id: event.correlationId,
      causation_id: event.eventId,
      task_id: event.taskId,
      task_version: event.taskVersion,
      created_at: new Date().toISOString(),
      payload: {
        span_id: id,
        trigger_event_id: event.eventId,
        trigger_event_type: event.eventType,
        started_at_ms: started,
        loop,
        models: [...models],
      },
    });
  };
  const release = () => {
    pending -= 1;
    if (!pending) {
      closed = true;
      send(failed ? 'failed' : 'completed');
    }
  };
  const context: SpanContext = {
    id,
    annotate(nextLoop, model) {
      if (closed) return;
      loop = nextLoop;
      if (model) models.add(model);
      send('updated');
    },
    async track(work) {
      // A scheduled callback may wake after its original delivery finished.
      if (closed) return traceExecution(hub, event, agentId, work);
      pending += 1;
      try {
        return await work();
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        release();
      }
    },
  };
  send('started');
  return executionSpan.run(context, async () => {
    try {
      return await run();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      release();
    }
  });
}
