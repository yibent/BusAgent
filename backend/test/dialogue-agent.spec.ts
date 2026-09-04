import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogueAgent } from '../src/modules/dialogue/dialogue-agent.js';
import { ConversationHub } from '../src/modules/conversation/conversation-hub.js';
import { ConversationInterruptions } from '../src/modules/conversation/conversation-interruptions.js';
import { HostConfig } from '../src/config/host-config.js';
import type { TtsAgent } from '../src/modules/tts/tts-agent.js';
import { makeEvent } from './helpers.js';
import type { InProcessEventContext } from '../src/adapters/in-process/agent-classes.js';

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function context(
  agent: DialogueAgent,
  hub: ConversationHub,
  published: unknown[],
): InProcessEventContext {
  const conversationId = 'corr_chat';
  hub.subscribe(conversationId, (message) => {
    published.push(message);
  });
  return {
    event: makeEvent({
      eventType: 'intent.created',
      correlationId: conversationId,
      payload: { text: '你好' },
    }),
    agentConfig: {
      appId: 'desktop-robot-assistant',
      agentId: 'robot.dialogue',
      config: {},
      adapter: 'in-process',
      registrationKey: agent.registrationKey,
    },
    publish: (input) => {
      published.push({ published: input.event_type, payload: input.payload });
      return Promise.resolve();
    },
  };
}

describe('DialogueAgent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams a reply onto the conversation hub', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          body: sseBody([
            'data: {"choices":[{"delta":{"content":"你好"}}]}\n',
            'data: {"choices":[{"delta":{"content":"呀"}}]}\ndata: [DONE]\n',
          ]),
        }),
      ),
    );
    const hub = new ConversationHub();
    const tts = {
      startTurn: vi.fn(),
      append: vi.fn(),
      finishTurn: vi.fn(() => Promise.resolve()),
      cancel: vi.fn(),
      interrupt: vi.fn(),
    };
    const agent = new DialogueAgent(
      HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test-key' }),
      hub,
      tts as unknown as TtsAgent,
      new ConversationInterruptions(hub),
    );
    const published: unknown[] = [];
    await agent.handle(context(agent, hub, published));
    expect(tts.startTurn).toHaveBeenCalledWith('corr_chat', 1);
    expect(tts.append).toHaveBeenCalledWith('corr_chat', 1, '你好');
    expect(tts.finishTurn).toHaveBeenCalledWith('corr_chat', 1);
    expect(published).toEqual([
      { type: 'reply.start', turn: 1 },
      { type: 'reply.delta', text: '你好', turn: 1 },
      { type: 'reply.delta', text: '呀', turn: 1 },
      { type: 'reply.final', text: '你好呀', turn: 1 },
      { published: 'reply.created', payload: { text: '你好呀' } },
    ]);
  });

  it('skips non-intent events', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const hub = new ConversationHub();
    const agent = new DialogueAgent(
      HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test-key' }),
      hub,
      {
        startTurn: vi.fn(),
        append: vi.fn(),
        finishTurn: vi.fn(() => Promise.resolve()),
        cancel: vi.fn(),
        interrupt: vi.fn(),
      } as unknown as TtsAgent,
      new ConversationInterruptions(hub),
    );
    await agent.handle({
      event: makeEvent({ eventType: 'transcript.delta', payload: { text: 'x' } }),
      agentConfig: {
        appId: 'app',
        agentId: 'robot.dialogue',
        config: {},
        adapter: 'in-process',
        registrationKey: agent.registrationKey,
      },
      publish: () => Promise.resolve(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels TTS when a human interruption is reported', () => {
    const hub = new ConversationHub();
    const interruptions = new ConversationInterruptions(hub);
    const tts = {
      startTurn: vi.fn(),
      append: vi.fn(),
      finishTurn: vi.fn(() => Promise.resolve()),
      cancel: vi.fn(),
      interrupt: vi.fn(),
    };
    const agent = new DialogueAgent(
      HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test-key' }),
      hub,
      tts as unknown as TtsAgent,
      interruptions,
    );
    agent.onModuleInit();

    interruptions.interrupt('corr_chat');

    expect(tts.interrupt).toHaveBeenCalledWith('corr_chat');
    agent.onModuleDestroy();
  });
});
