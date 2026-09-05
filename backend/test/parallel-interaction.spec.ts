import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogueAgent } from '../src/modules/dialogue/dialogue-agent.js';
import { InstructionUnderstandingNode } from '../src/apps/desktop-robot/instruction-agent.js';
import {
  readInteractionSnapshot,
  summarizeCapabilities,
  summarizeMotion,
} from '../src/apps/desktop-robot/interaction-snapshot.js';
import { ConversationHub } from '../src/modules/conversation/conversation-hub.js';
import { ConversationInterruptions } from '../src/modules/conversation/conversation-interruptions.js';
import { HostConfig } from '../src/config/host-config.js';
import type { TtsAgent } from '../src/modules/tts/tts-agent.js';
import type { InProcessEventContext } from '../src/adapters/in-process/agent-classes.js';
import { makeEvent } from './helpers.js';

const snapshot = {
  capabilities: {
    skills: ['perceive', 'move_joint', 'home', 'gripper', 'hold'],
    unsupported: ['grasp', 'place'],
  },
  motion: {
    mode: 'moving',
    active_command_id: 'prior-command',
    simulation_playing: true,
    last_command: { state: 'running', skill: 'home' },
  },
  views: { largeImageData: 'must not reach prompt' },
};
function sse(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n`,
  );
}
function setup(text: string) {
  const host = HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test-key' });
  const hub = new ConversationHub();
  const tts = {
    startTurn: vi.fn(),
    append: vi.fn(),
    finishTurn: vi.fn(async () => {}),
    cancel: vi.fn(),
    interrupt: vi.fn(),
  };
  const dialogue = new DialogueAgent(
    host,
    hub,
    tts as unknown as TtsAgent,
    new ConversationInterruptions(hub),
  );
  const nlu = new InstructionUnderstandingNode(host);
  const messages: Array<Record<string, unknown>> = [];
  const events: Array<{ event_type: string; payload?: unknown }> = [];
  const id = `parallel-${Math.random()}`;
  hub.subscribe(id, (message) => messages.push(message));
  const ctx: InProcessEventContext = {
    event: makeEvent({
      eventId: id,
      eventType: 'intent.created',
      correlationId: id,
      payload: { text },
    }),
    agentConfig: {
      appId: 'desktop-robot-assistant',
      agentId: 'robot.dialogue',
      config: {
        parallel_interaction: true,
        model: 'qwen-flash',
        reasoning: 'none',
        controller_url: 'http://controller.test',
      },
      adapter: 'in-process',
      registrationKey: dialogue.registrationKey,
    },
    publish: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
  const nluCtx: InProcessEventContext = {
    ...ctx,
    agentConfig: {
      ...ctx.agentConfig,
      agentId: 'robot.instruction_understanding',
      config: { parallel_interaction: true, model: 'qwen3.8-flash', reasoning: 'low' },
    },
  };
  return { dialogue, nlu, ctx, nluCtx, messages, events, tts };
}
afterEach(() => vi.unstubAllGlobals());
describe('parallel interaction lane', () => {
  it('distinguishes current hold from a previously completed home command', () => {
    expect(
      summarizeMotion({
        mode: 'hold',
        active_command_id: null,
        last_command: { skill: 'home', state: 'completed' },
      }),
    ).toBe('当前保持位置；上次复位已完成。');
    expect(summarizeMotion(snapshot.motion)).toContain('正在执行动作');
    expect(
      summarizeMotion({ ...snapshot.motion, simulation_playing: false }),
    ).toContain('仿真已暂停');
    expect(summarizeMotion({ mode: 'idle', active_command_id: 'queued' })).toContain(
      '等待仿真执行',
    );
    expect(
      summarizeMotion({ mode: 'hold', last_command: { state: 'failed' } }),
    ).toContain('上次动作失败');
  });
  it.each(['home', 'chat', 'capabilities', 'status_query'])(
    'responds while NLU is unresolved, with no duplicate query reply (%s)',
    async (intent) => {
      const test = setup(intent === 'home' ? '机械臂复位' : '现在你在做什么？');
      let release!: (response: Response) => void;
      const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith('/api/status')) return Response.json(snapshot);
        const body = JSON.parse(options?.body as string) as {
          model: string;
          enable_thinking: boolean;
          reasoning_effort?: string;
          messages: Array<{ content: string }>;
        };
        if (body.model === 'qwen3.8-flash') {
          expect(body.enable_thinking).toBe(true);
          expect(body.reasoning_effort).toBe('low');
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        expect(body.enable_thinking).toBe(false);
        expect(body.messages[0]?.content).toContain('prior-command');
        expect(body.messages[0]?.content).toContain('moving');
        expect(body.messages[0]?.content).not.toContain('largeImageData');
        return sse(intent === 'home' ? '收到。' : '正在复位。');
      });
      vi.stubGlobal('fetch', fetchMock);
      await Promise.all([test.nlu.handle(test.nluCtx), test.dialogue.handle(test.ctx)]);
      await vi.waitFor(() =>
        expect(test.messages.some((m) => m.type === 'reply.final')).toBe(true),
      );
      expect(test.events.map((e) => e.event_type)).not.toContain('instruction.parsed');
      expect(test.tts.append).toHaveBeenCalled();
      release(sse(JSON.stringify({ intent })));
      await vi.waitFor(() =>
        expect(
          test.events.some(
            (e) =>
              e.event_type ===
              (intent === 'home' ? 'instruction.parsed' : 'interaction.classified'),
          ),
        ).toBe(true),
      );
      expect(test.events.some((e) => e.event_type === 'conversation.requested')).toBe(
        false,
      );
      expect(test.messages.filter((m) => m.type === 'reply.final')).toHaveLength(1);
      expect(fetchMock.mock.calls.every(([url]) => !url.includes('/api/command'))).toBe(
        true,
      );
      test.dialogue.onModuleDestroy();
    },
  );

  it('task feedback preempts slow interaction without waiting for its stream', async () => {
    const test = setup('机械臂复位');
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, options?: RequestInit) =>
        Promise.resolve(
          url.endsWith('/api/status')
            ? Response.json(snapshot)
            : (options?.body as string).includes('current_event')
              ? sse('底座角度超出关节范围，这次没有执行。')
              : new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      stream = controller;
                    },
                  }),
                ),
        ),
      ),
    );
    await test.dialogue.handle(test.ctx);
    await vi.waitFor(() => expect(stream).toBeDefined());
    await test.dialogue.handle({
      ...test.ctx,
      event: makeEvent({
        eventType: 'execution.failed',
        correlationId: test.ctx.event.correlationId,
        taskId: `task_${test.ctx.event.eventId}`,
        payload: { message: 'JOINT_LIMIT；未执行' },
      }),
    });
    await vi.waitFor(() =>
      expect(test.messages).toContainEqual(
        expect.objectContaining({
          type: 'reply.final',
          text: '底座角度超出关节范围，这次没有执行。',
        }),
      ),
    );
    stream.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '收到。' } }] })}\n\ndata: [DONE]\n`,
      ),
    );
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(test.messages.filter((m) => m.type === 'reply.final')).toHaveLength(1);
    expect(test.tts.cancel).toHaveBeenCalledTimes(2);
    test.dialogue.onModuleDestroy();
  });

  it('suppresses a raw-input delivery arriving after its task result', async () => {
    const test = setup('机械臂复位');
    const fetchMock = vi.fn(async () => sse('已完成。'));
    vi.stubGlobal('fetch', fetchMock);
    await test.dialogue.handle({
      ...test.ctx,
      event: makeEvent({
        eventType: 'execution.completed',
        correlationId: test.ctx.event.correlationId,
        taskId: `task_${test.ctx.event.eventId}`,
        payload: { message: '已完成。' },
      }),
    });
    await test.dialogue.handle(test.ctx);
    await vi.waitFor(() =>
      expect(test.messages.filter((m) => m.type === 'reply.final')).toHaveLength(1),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // Only result wording, no late acknowledgement.
    expect(test.messages.filter((m) => m.type === 'reply.final')).toHaveLength(1);
  });

  it('keeps emergency interrupt off the model-backed interaction lane', async () => {
    const test = setup('停一下');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await test.dialogue.handle(test.ctx);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks unavailable controller context unknown instead of inventing capability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    expect(
      await readInteractionSnapshot({}, new AbortController().signal),
    ).toMatchObject({ available: false });
    expect(summarizeCapabilities({})).toBe('暂时无法确认控制器能力。');
    expect(summarizeCapabilities(snapshot.capabilities).length).toBeLessThan(60);
  });
});
