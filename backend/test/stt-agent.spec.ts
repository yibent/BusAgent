import { describe, expect, it, vi } from 'vitest';
import { SttAgent } from '../src/modules/stt/stt-agent.js';
import type { SttConnection, SttHandlers } from '../src/modules/stt/stt-types.js';
import { HostConfig } from '../src/config/host-config.js';
import { RuntimeState } from '../src/app/runtime-state.service.js';
import { SpeechGate } from '../src/modules/conversation/speech-gate.js';
import type { EventBus } from '../src/bus/event-bus.service.js';
import type { AppSnapshot } from '../src/app/startup-snapshot.js';

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
            config: { language: 'zh', emit_uncommitted: true },
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
      finalize: vi.fn(),
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
      (_opts, nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      },
    );

    const started = agent.startSession({});
    expect(started.streamId).toMatch(/^stream_/);
    handlers?.onPartial({ text: '帮我找到绿色咖啡杯', isFinal: true, speechFinal: true });
    await vi.waitFor(() => {
      expect(published.some((e) => e.event_type === 'intent.created')).toBe(true);
    });

    const deltas = published.filter((e) => e.event_type === 'transcript.delta');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((e) => e.payload.committed === true)).toBe(true);
    expect(published.some((e) => e.event_type === 'transcript.final')).toBe(true);
    const intent = published.find((e) => e.event_type === 'intent.created');
    expect(intent?.payload.text).toBe('帮我找到绿色咖啡杯');
  });

  it('drops transcripts while the assistant is speaking', async () => {
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
      (_opts, nextHandlers) => {
        handlers = nextHandlers;
        return {
          sendAudio: vi.fn(),
          finalize: vi.fn(),
          done: vi.fn(),
          close: vi.fn(),
        };
      },
    );

    agent.startSession({ correlationId: 'echo-1' });
    gate.beginSpeaking('echo-1');
    gate.extendPlayback('echo-1', 10_000);
    handlers?.onPartial({ text: '回声内容', isFinal: true, speechFinal: true });
    await Promise.resolve();
    expect(published).toEqual([]);
  });
});
