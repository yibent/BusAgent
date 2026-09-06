import { describe, expect, it } from 'vitest';
import {
  traceExecution,
  executionSpan,
  trackBackground,
  markExecutionLoop,
} from '../src/observability/execution-span.js';
import { ConversationHub } from '../src/modules/conversation/conversation-hub.js';
import type { BusEvent } from '../src/protocol/envelope.js';
const event = {
  eventId: 'input',
  eventType: 'intent.created',
  correlationId: 'session',
  sourceAgentId: 'system.input',
  appId: 'robot',
  payload: {},
  priority: 0,
  createdAt: new Date().toISOString(),
} as BusEvent;
describe('execution timeline telemetry', () => {
  it('keeps overlapping asynchronous calls separate and reports the actual terminal state', async () => {
    const hub = new ConversationHub();
    const messages: Record<string, unknown>[] = [];
    hub.subscribe('session', (message) => messages.push(message));
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let aId: string | undefined, bId: string | undefined;
    const a = traceExecution(hub, event, 'a', async () => {
      aId = executionSpan.getStore()?.id;
      await gate;
      expect(executionSpan.getStore()?.id).toBe(aId);
      return 'a-result';
    });
    const b = traceExecution(hub, event, 'b', async () => {
      bId = executionSpan.getStore()?.id;
      throw new Error('model unavailable');
    });
    await expect(b).rejects.toThrow('model unavailable');
    finish();
    expect(await a).toBe('a-result');
    expect(aId).not.toBe(bId);
    expect(messages.map((m) => m.event_type)).toEqual([
      'node.started',
      'node.started',
      'node.failed',
      'node.completed',
    ]);
    expect(executionSpan.getStore()).toBeUndefined();
    expect(messages.every((m) => m.causation_id === 'input')).toBe(true);
  });
});

it('keeps detached work timed without holding the delivery acknowledgement', async () => {
  const hub = new ConversationHub();
  const messages: Record<string, unknown>[] = [];
  hub.subscribe('session', (m) => messages.push(m));
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let background!: Promise<void>;
  await traceExecution(hub, event, 'instruction', () => {
    background = trackBackground(async () => {
      markExecutionLoop('slow', 'qwen');
      await gate;
    });
  });
  expect(messages.map((m) => m.event_type)).toEqual(['node.started', 'node.updated']);
  finish();
  await background;
  expect(messages.at(-1)?.event_type).toBe('node.completed');
  expect((messages.at(-1)?.payload as Record<string, unknown>).loop).toBe('slow');
});
