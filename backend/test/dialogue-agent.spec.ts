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
      eventType: 'conversation.requested',
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
    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    const body = JSON.parse(request?.body as string) as {
      max_tokens: number;
      enable_thinking: boolean;
      messages: Array<{ content: string }>;
    };
    expect(body.max_tokens).toBe(192);
    expect(body.enable_thinking).toBe(false);
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.messages[0]?.content).toContain('默认只说一句');
    expect(published).toEqual([
      { type: 'reply.start', turn: 1 },
      { type: 'reply.delta', text: '你好', turn: 1 },
      { type: 'reply.delta', text: '呀', turn: 1 },
      { type: 'reply.final', text: '你好呀', turn: 1 },
      { published: 'reply.created', payload: { text: '你好呀' } },
    ]);
  });

  it.each([true, false])(
    'forwards chunks before completion and handles interruption=%s',
    async (interrupt) => {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve({ ok: true, body: stream })),
      );
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
        HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test' }),
        hub,
        tts as unknown as TtsAgent,
        interruptions,
      );
      agent.onModuleInit();
      const published: unknown[] = [];
      const handling = agent.handle(context(agent, hub, published));
      const send = (text: string) =>
        streamController.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`,
          ),
        );
      send('这是一段说明');
      await vi.waitFor(() =>
        expect(tts.append).toHaveBeenCalledWith('corr_chat', 1, '这是一段说明'),
      );
      expect(published).toContainEqual({
        type: 'reply.delta',
        text: '这是一段说明',
        turn: 1,
      });
      expect(tts.finishTurn).not.toHaveBeenCalled();
      if (interrupt) interruptions.interrupt('corr_chat');
      send('，后半句。');
      streamController.close();
      await handling;
      if (interrupt) {
        expect(tts.append).toHaveBeenCalledTimes(1);
        expect(tts.finishTurn).not.toHaveBeenCalled();
        expect(tts.interrupt).toHaveBeenCalledWith('corr_chat');
      } else {
        expect(tts.append).toHaveBeenCalledWith('corr_chat', 1, '，后半句。');
        expect(published).toContainEqual({
          type: 'reply.final',
          text: '这是一段说明，后半句。',
          turn: 1,
        });
      }
      agent.onModuleDestroy();
    },
  );

  it.each([
    ['execution.started', {}, '正在执行。'],
    ['execution.progress', { message: '正在验证目标是否抬起。' }, '正在验证目标是否抬起。'],
    ['execution.completed', {}, '已完成。'],
    ['execution.unknown', {}, '结果未知，控制端未确认。'],
    [
      'execution.failed',
      { message: 'NO_IK：姿态不可达；未执行运动' },
      '未完成：NO_IK：姿态不可达；未执行运动',
    ],
    [
      'clarification.requested',
      { question: '顺时针还是逆时针？' },
      '顺时针还是逆时针？',
    ],
    ['observation.ready', { message: '未检测到黄色螺栓。' }, '未检测到黄色螺栓。'],
    [
      'execution.completed',
      { message: '动作完成，实测关节已到位' },
      '动作完成，实测关节已到位',
    ],
  ])(
    'keeps %s concise without losing factual details',
    async (eventType, payload, expected) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const hub = new ConversationHub();
      const tts = {
        startTurn: vi.fn(),
        append: vi.fn(),
        finishTurn: vi.fn(() => Promise.resolve()),
        cancel: vi.fn(),
        interrupt: vi.fn(),
      };
      const agent = new DialogueAgent(
        HostConfig.fromEnv({}),
        hub,
        tts as unknown as TtsAgent,
        new ConversationInterruptions(hub),
      );
      const published: unknown[] = [];
      const ctx = context(agent, hub, published);
      ctx.event = makeEvent({ eventType, correlationId: 'corr_chat', payload });
      await agent.handle(ctx);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(published).toContainEqual({
        type: 'reply.final',
        text: expected,
        turn: 1,
      });
      expect(tts.append).toHaveBeenCalledWith('corr_chat', 1, expected);
    },
  );

  it.each(['transcript.delta', 'intent.created'])(
    'does not turn %s into unverified action claims',
    async (eventType) => {
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
        event: makeEvent({ eventType, payload: { text: '绕Z轴旋转90度' } }),
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
    },
  );

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
