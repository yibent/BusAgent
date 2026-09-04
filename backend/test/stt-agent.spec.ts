import { afterEach, describe, expect, it, vi } from 'vitest';
import { SttAgent } from '../src/modules/stt/stt-agent.js';
import type { SttConnection, SttHandlers } from '../src/modules/stt/stt-types.js';
import { HostConfig } from '../src/config/host-config.js';
import { RuntimeState } from '../src/app/runtime-state.service.js';
import { SpeechGate } from '../src/modules/conversation/speech-gate.js';
import { ConversationHub } from '../src/modules/conversation/conversation-hub.js';
import { ConversationInterruptions } from '../src/modules/conversation/conversation-interruptions.js';
import type { EventBus } from '../src/bus/event-bus.service.js';
import type { AppSnapshot } from '../src/app/startup-snapshot.js';

afterEach(() => {
  vi.useRealTimers();
});

function snapshot(): AppSnapshot {
  return {
    snapshotSha256: 'x',
    createdAt: '2026-08-08T00:00:00.000Z',
    appId: 'desktop-robot-assistant',
    appVersion: '2026.08',
    agentIds: ['robot.stt', 'robot.dialogue'],
    packageIds: ['robot-core-agents'],
    routes: [],
    agents: new Map([
      [
        'robot.stt',
        {
          agentId: 'robot.stt',
          packageId: 'robot-core-agents',
          required: true,
          runtimeConfig: {
            appId: 'desktop-robot-assistant',
            agentId: 'robot.stt',
            config: {
              language: 'zh',
              emit_uncommitted: true,
              utterance_settle_ms: 900,
            },
            adapter: 'in-process',
            registrationKey: 'SttAgent',
          },
          packageRetry: { max_attempts: 1, backoff_ms: 0, dead_letter: true },
        },
      ],
    ]),
  };
}

describe('SttAgent', () => {
  it('publishes few-word committed deltas then a final intent', async () => {
    vi.useFakeTimers();
    const published: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
    const eventBus = {
      publishFromAgent: (
        _id: string,
        input: { event_type: string; payload: Record<string, unknown> },
      ) => {
        published.push({ event_type: input.event_type, payload: input.payload });
        return Promise.resolve({});
      },
    } as unknown as EventBus;

    let handlers: SttHandlers | undefined;
    const connection: SttConnection = {
      sendAudio: vi.fn(),
      done: vi.fn(),
      close: vi.fn(),
    };

    const runtime = new RuntimeState();
    runtime.set(snapshot());
    const agent = new SttAgent(
      eventBus,
      HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test-key' }),
      runtime,
      new SpeechGate(),
      new ConversationInterruptions(new ConversationHub()),
      (_opts, nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      },
    );

    const started = agent.startSession({});
    expect(started.streamId).toMatch(/^stream_/);
    handlers?.onPartial({ text: '帮我找到绿色咖啡杯', isFinal: true, speechFinal: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(published.some((e) => e.event_type === 'intent.created')).toBe(false);
    await vi.advanceTimersByTimeAsync(900);

    const deltas = published.filter((e) => e.event_type === 'transcript.delta');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((e) => e.payload.committed === true)).toBe(true);
    expect(published.some((e) => e.event_type === 'transcript.final')).toBe(true);
    const intent = published.find((e) => e.event_type === 'intent.created');
    expect(intent?.payload.text).toBe('帮我找到绿色咖啡杯');
  });

  it('merges speech separated by a brief pause before creating an intent', async () => {
    vi.useFakeTimers();
    const published: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
    const eventBus = {
      publishFromAgent: (
        _id: string,
        input: { event_type: string; payload: Record<string, unknown> },
      ) => {
        published.push({ event_type: input.event_type, payload: input.payload });
        return Promise.resolve({});
      },
    } as unknown as EventBus;

    let handlers: SttHandlers | undefined;
    const runtime = new RuntimeState();
    runtime.set(snapshot());
    const agent = new SttAgent(
      eventBus,
      HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test-key' }),
      runtime,
      new SpeechGate(),
      new ConversationInterruptions(new ConversationHub()),
      (_opts, nextHandlers) => {
        handlers = nextHandlers;
        return {
          sendAudio: vi.fn(),
          done: vi.fn(),
          close: vi.fn(),
        };
      },
    );

    agent.startSession({});
    handlers?.onPartial({ text: '帮我', isFinal: true, speechFinal: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(published.some((event) => event.event_type === 'intent.created')).toBe(false);

    handlers?.onPartial({ text: '找绿色', isFinal: false, speechFinal: false });
    handlers?.onPartial({ text: '找绿色咖啡杯', isFinal: true, speechFinal: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(899);
    expect(published.some((event) => event.event_type === 'intent.created')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const intents = published.filter((event) => event.event_type === 'intent.created');
    expect(intents).toHaveLength(1);
    expect(intents[0]?.payload.text).toBe('帮我找绿色咖啡杯');
  });

  it('drops transcript text that matches assistant playback echo', async () => {
    const published: Array<{ event_type: string }> = [];
    const eventBus = {
      publishFromAgent: (
        _id: string,
        input: { event_type: string },
      ) => {
        published.push({ event_type: input.event_type });
        return Promise.resolve({});
      },
    } as unknown as EventBus;
    let handlers: SttHandlers | undefined;
    const runtime = new RuntimeState();
    runtime.set(snapshot());
    const gate = new SpeechGate();
    const agent = new SttAgent(
      eventBus,
      HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test-key' }),
      runtime,
      gate,
      new ConversationInterruptions(new ConversationHub()),
      (_opts, nextHandlers) => {
        handlers = nextHandlers;
        return {
          sendAudio: vi.fn(),
          done: vi.fn(),
          close: vi.fn(),
        };
      },
    );

    agent.startSession({ correlationId: 'echo-1' });
    gate.startAssistantTurn('echo-1');
    gate.appendAssistantText('echo-1', '这是回声内容');
    gate.beginSpeaking('echo-1');
    gate.extendPlayback('echo-1', 10_000);
    handlers?.onPartial({ text: '回声内容', isFinal: true, speechFinal: true });
    await Promise.resolve();
    expect(published).toEqual([]);
  });

  it('interrupts assistant playback after several non-echo characters', async () => {
    const published: Array<{ event_type: string }> = [];
    const eventBus = {
      publishFromAgent: (_id: string, input: { event_type: string }) => {
        published.push({ event_type: input.event_type });
        return Promise.resolve({});
      },
    } as unknown as EventBus;
    const hub = new ConversationHub();
    const hubMessages: Array<Record<string, unknown>> = [];
    hub.subscribe('barge-1', (message) => hubMessages.push(message));
    const runtime = new RuntimeState();
    runtime.set(snapshot());
    const gate = new SpeechGate();
    const interruptions = new ConversationInterruptions(hub);
    const interruptListener = vi.fn();
    interruptions.subscribe(interruptListener);
    let handlers: SttHandlers | undefined;
    const agent = new SttAgent(
      eventBus,
      HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test-key' }),
      runtime,
      gate,
      interruptions,
      (_opts, nextHandlers) => {
        handlers = nextHandlers;
        return { sendAudio: vi.fn(), done: vi.fn(), close: vi.fn() };
      },
    );

    agent.startSession({ correlationId: 'barge-1' });
    gate.startAssistantTurn('barge-1');
    gate.appendAssistantText('barge-1', '我正在介绍今天的日程安排');
    gate.beginSpeaking('barge-1');
    gate.extendPlayback('barge-1', 10_000);
    handlers?.onPartial({ text: '等一下', isFinal: false, speechFinal: false });

    await vi.waitFor(() => expect(interruptListener).toHaveBeenCalledWith('barge-1'));
    expect(gate.isBlocked('barge-1')).toBe(false);
    expect(hubMessages).toContainEqual({ type: 'speech.interrupted' });
    expect(published.some((event) => event.event_type === 'transcript.delta')).toBe(true);
  });
});
