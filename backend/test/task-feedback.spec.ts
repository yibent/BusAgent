import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogueAgent } from '../src/modules/dialogue/dialogue-agent.js';
import {
  TaskConversation,
  progressText,
} from '../src/modules/dialogue/task-conversation.js';
import { cancelPendingIntent } from '../src/apps/desktop-robot/pending-intents.js';
import { ConversationHub } from '../src/modules/conversation/conversation-hub.js';
import { ConversationInterruptions } from '../src/modules/conversation/conversation-interruptions.js';
import { HostConfig } from '../src/config/host-config.js';
import type { TtsAgent } from '../src/modules/tts/tts-agent.js';
import type { InProcessEventContext } from '../src/adapters/in-process/agent-classes.js';
import { parseInstruction } from '../src/apps/desktop-robot/instruction-agent.js';
import { makeEvent } from './helpers.js';

const agents: DialogueAgent[] = [];
function sse(text: string) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n`,
  );
}
function setup() {
  const hub = new ConversationHub();
  const tts = {
    startTurn: vi.fn(),
    append: vi.fn(),
    finishTurn: vi.fn(async () => {}),
    cancel: vi.fn(),
    interrupt: vi.fn(),
  };
  const agent = new DialogueAgent(
    HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test' }),
    hub,
    tts as unknown as TtsAgent,
    new ConversationInterruptions(hub),
  );
  agents.push(agent);
  const messages: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const requests: { messages: { content: string }[]; enable_thinking: boolean }[] = [];
  hub.subscribe('feedback-conv', (message) => messages.push(message));
  const context = (
    eventType: string,
    payload: unknown,
    taskId = 'task_request',
  ): InProcessEventContext => ({
    event: makeEvent({
      eventId:
        eventType === 'intent.created'
          ? taskId.replace(/^task_/, '')
          : crypto.randomUUID(),
      eventType,
      correlationId: 'feedback-conv',
      taskId,
      payload,
    }),
    agentConfig: {
      appId: 'desktop-robot-assistant',
      agentId: 'robot.dialogue',
      adapter: 'in-process',
      registrationKey: agent.registrationKey,
      config: {
        parallel_interaction: true,
        model: 'qwen-flash',
        reasoning: 'none',
        controller_url: 'http://controller.test',
      },
    },
    publish: async (event) => {
      events.push(event);
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/api/status'))
        return Response.json({
          motion: { mode: 'hold' },
          capabilities: { skills: ['home'] },
        });
      const request = JSON.parse(options?.body as string);
      requests.push(request);
      const content = request.messages[0].content;
      return sse(
        content.includes('current_event') ? '已经回到初始姿态。' : '好，我来处理。',
      );
    }),
  );
  return { agent, tts, messages, events, context, requests };
}
afterEach(() => {
  for (const agent of agents.splice(0)) agent.onModuleDestroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('coherent model-generated task feedback', () => {
  it('reports measured Panda placement failure without an LLM inventing grasp failure or confirmation', async () => {
    const t = setup();
    await t.agent.handle(
      t.context('execution.failed', {
        message: 'Physical task failed verification',
        result: {
          evaluation: {
            evaluation_source: 'arena_task_simulation_ground_truth',
            physical_success: false,
            lifted: true,
            released: true,
          },
        },
      }),
    );
    await vi.waitFor(() =>
      expect(t.messages).toContainEqual(
        expect.objectContaining({
          type: 'reply.final',
          text: '物体已抓起并释放，但最终放置未通过物理验证。',
        }),
      ),
    );
    expect(t.requests).toHaveLength(0);
  });

  it('does not acknowledge an incomplete speech preface as execution', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.agent.handle(t.context('intent.created', { text: '好，现在。' }));
    await vi.advanceTimersByTimeAsync(60000);
    expect(t.requests).toHaveLength(0);
    expect(t.tts.append).not.toHaveBeenCalled();
  });

  it('silences cancelled task timers and late events while a later home completes', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.agent.onModuleInit();
    await t.agent.handle(t.context('intent.created', { text: '抓红色方块' }));
    await t.agent.handle(t.context('execution.started', { message: '抓取开始' }));
    await vi.advanceTimersByTimeAsync(0);
    cancelPendingIntent('feedback-conv');
    await t.agent.handle(t.context('intent.created', { text: '复位' }, 'task_home'));
    await t.agent.handle(
      t.context('execution.completed', { message: '复位已完成' }, 'task_home'),
    );
    await vi.advanceTimersByTimeAsync(0);
    const count = t.requests.length;
    await t.agent.handle(t.context('execution.progress', { message: '抓取仍在进行' }));
    await vi.advanceTimersByTimeAsync(60000);
    expect(t.requests).toHaveLength(count);
  });

  it('does not let an old timeout or late start overtake a newer physical action', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.agent.handle(t.context('intent.created', { text: '抓方块' }));
    await vi.advanceTimersByTimeAsync(0);
    await t.agent.handle(t.context('intent.created', { text: '复位' }, 'task_home'));
    await t.agent.handle(
      t.context('execution.started', { message: '开始复位' }, 'task_home'),
    );
    await t.agent.handle(
      t.context('execution.completed', { message: '复位完成' }, 'task_home'),
    );
    await vi.advanceTimersByTimeAsync(0);
    const count = t.requests.length;
    await t.agent.handle(t.context('execution.started', { message: '晚到的抓取开始' }));
    await vi.advanceTimersByTimeAsync(60000);
    expect(t.requests).toHaveLength(count);
  });

  it('never revives a terminal task; unknown can resolve with measured completion', () => {
    const t = setup();
    const memory = new TaskConversation();
    memory.observe(t.context('execution.completed', { command_id: 'cmd' }));
    expect(
      memory.observe(t.context('execution.progress', { command_id: 'cmd' })),
    ).toBeUndefined();
    expect(
      memory.observe(t.context('execution.completed', { command_id: 'cmd' })),
    ).toBeUndefined();
    memory.observe(t.context('execution.unknown', {}, 'task_unknown'));
    expect(
      memory.observe(t.context('execution.completed', {}, 'task_unknown'))?.stage,
    ).toBe('completed');
  });

  it('describes preparation as preparation, and keeps old proposals out of new feedback', async () => {
    const t = setup();
    const memory = new TaskConversation();
    const task = memory.observe(
      t.context('instruction.parsed', {
        ...parseInstruction('抓红色方块'),
        prepare_last_grasp: true,
      }),
    )!;
    memory.observe(t.context('execution.started', {}));
    expect(progressText(task)).toContain('初始准备姿态');
    expect(progressText(task)).not.toContain('抓取仍在进行');
    await t.agent.handle(
      t.context('execution.failed', {
        message: '旧建议',
        result: { result: { preparation: { id: 'old', requires_confirmation: true } } },
      }),
    );
    await vi.waitFor(() => expect(t.requests).toHaveLength(1));
    await t.agent.handle(
      t.context('execution.failed', { message: '上下文失效' }, 'task_new'),
    );
    await vi.waitFor(() => expect(t.requests).toHaveLength(2));
    expect(JSON.stringify(t.requests.at(-1))).not.toContain('旧建议');
    expect(t.requests.at(-1)?.messages).toHaveLength(2);
  });

  it('gives the LLM actual task facts and remembers them for subsequent questions', async () => {
    const t = setup();
    await t.agent.handle(t.context('intent.created', { text: '机械臂复位' }));
    await vi.waitFor(() =>
      expect(t.messages.some((m) => m.type === 'reply.final')).toBe(true),
    );
    await t.agent.handle(
      t.context('instruction.parsed', parseInstruction('机械臂归位')),
    );
    const done = t.context('execution.completed', {
      message: '动作完成，实测关节已到位并停稳',
    });
    await t.agent.handle(done);
    await vi.waitFor(() =>
      expect(t.messages).toContainEqual(
        expect.objectContaining({ type: 'reply.final', text: '已经回到初始姿态。' }),
      ),
    );
    const feedback = t.requests.at(-1)!;
    expect(feedback.enable_thinking).toBe(false);
    expect(feedback.messages[0]?.content).toContain('execution.completed');
    expect(feedback.messages[0]?.content).toContain('实测关节已到位并停稳');
    expect(feedback.messages[0]?.content).toContain('home');
    expect(t.tts.append).toHaveBeenCalledWith(
      'feedback-conv',
      expect.any(Number),
      '已经回到初始姿态。',
    );
    await t.agent.handle(done); // Bus redelivery must not speak twice.
    await t.agent.handle(
      t.context('intent.created', { text: '刚才做好了吗？' }, 'task_question'),
    );
    await vi.waitFor(() => expect(t.requests).toHaveLength(3));
    expect(JSON.stringify(t.requests.at(-1))).toContain('已经回到初始姿态。');
    expect(t.requests.at(-1)?.messages[0]?.content).toContain('实测关节已到位并停稳');
  });

  it('reports slow grounding and missing feedback once, then still delivers the late result', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.agent.handle(t.context('intent.created', { text: '找黄色螺栓' }));
    await vi.advanceTimersByTimeAsync(0);
    await t.agent.handle(
      t.context('instruction.parsed', parseInstruction('找黄色螺栓')),
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(JSON.stringify(t.requests.at(-1))).toContain('正在定位黄色螺栓');
    expect(JSON.stringify(t.requests.at(-1))).toContain('task.progress');
    await vi.advanceTimersByTimeAsync(19000);
    expect(JSON.stringify(t.requests.at(-1))).toContain('task.feedback_delayed');
    const count = t.requests.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(t.requests).toHaveLength(count);
    await t.agent.handle(
      t.context('observation.ready', { message: '检测到1个黄色螺栓' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(t.requests.at(-1))).toContain('检测到1个黄色螺栓');
  });

  it('does not announce pending progress after completion', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.agent.handle(t.context('intent.created', { text: '归位' }));
    await vi.advanceTimersByTimeAsync(0);
    await t.agent.handle(t.context('execution.completed', { message: '已到位' }));
    await vi.advanceTimersByTimeAsync(0);
    const count = t.requests.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(t.requests).toHaveLength(count);
  });

  it.each([true, false])(
    'resolves acknowledgement-only chat even when classification arrives first=%s',
    async (first) => {
      const t = setup();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, options?: RequestInit) => {
          if (url.endsWith('/api/status')) return Response.json({});
          const body = JSON.parse(options?.body as string);
          t.requests.push(body);
          return sse(
            body.messages[0].content.includes('current_event')
              ? '不客气。'
              : '好，我来处理。',
          );
        }),
      );
      const classified = t.context('interaction.classified', {
        instruction_id: 'request',
        intent: 'chat',
      });
      if (first) await t.agent.handle(classified);
      await t.agent.handle(t.context('intent.created', { text: '谢谢' }));
      await vi.waitFor(() =>
        expect(t.messages.some((m) => m.text === '好，我来处理。')).toBe(true),
      );
      if (!first) await t.agent.handle(classified);
      await vi.waitFor(() =>
        expect(t.messages).toContainEqual(
          expect.objectContaining({ type: 'reply.final', text: '不客气。' }),
        ),
      );
      expect(t.requests).toHaveLength(2);
    },
  );

  it('uses factual fallback only when feedback generation fails', async () => {
    const t = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unavailable', { status: 503 })),
    );
    await t.agent.handle(
      t.context('execution.failed', { message: 'JOINT_LIMIT：目标超出110度；未执行' }),
    );
    await vi.waitFor(() =>
      expect(t.messages).toContainEqual(
        expect.objectContaining({
          type: 'reply.final',
          text: '未完成：JOINT_LIMIT：目标超出110度；未执行',
        }),
      ),
    );
  });

  it('records the textual result even while TTS readiness is stuck', async () => {
    const t = setup();
    t.tts.finishTurn.mockImplementation(() => new Promise(() => {}));
    await t.agent.handle(t.context('execution.completed', { message: '已到位' }));
    await vi.waitFor(() =>
      expect(t.events).toContainEqual(
        expect.objectContaining({
          event_type: 'reply.created',
          task_id: 'task_request',
        }),
      ),
    );
  });

  it('keeps terminal state despite late parsing and separates different tasks', () => {
    const t = setup();
    const memory = new TaskConversation();
    memory.observe(t.context('execution.failed', { message: '未执行' }));
    const late = memory.observe(
      t.context('instruction.parsed', parseInstruction('机械臂归位')),
    );
    expect(late?.stage).toBe('failed');
    memory.observe(t.context('intent.created', { text: '找螺栓' }, 'task_other'));
    expect(memory.snapshot('feedback-conv')).toHaveLength(2);
    expect(memory.snapshot('unrelated')).toHaveLength(0);
  });

  it('keeps an active action in short-term memory across many intervening queries', () => {
    const t = setup();
    const memory = new TaskConversation();
    memory.observe(
      t.context('instruction.parsed', parseInstruction('打开夹爪'), 'task_grip'),
    );
    memory.observe(
      t.context('execution.started', { message: '夹爪开始张开' }, 'task_grip'),
    );
    for (let i = 0; i < 12; i++) {
      memory.observe(
        t.context('intent.created', { text: '现在怎么样？' }, `task_query${i}`),
      );
      memory.observe(
        t.context(
          'interaction.classified',
          { intent: 'status_query', instruction_id: `query${i}` },
          `task_query${i}`,
        ),
      );
    }
    memory.observe(t.context('intent.created', { text: '底座旋转90度' }, 'task_base'));
    const focus = memory.focus('feedback-conv', 'task_base');
    expect(focus.executing).toEqual([
      expect.objectContaining({ task_id: 'task_grip', stage: 'executing' }),
    ]);
    expect(focus.current_request).toMatchObject({
      task_id: 'task_base',
      stage: 'understanding',
    });
    expect(JSON.stringify(memory.snapshot('feedback-conv'))).toContain('task_grip');
    memory.observe(
      t.context(
        'execution.queued',
        { waiting_for: 'task_grip', queue_position: 1 },
        'task_base',
      ),
    );
    expect(memory.focus('feedback-conv', 'task_question').waiting).toEqual([
      expect.objectContaining({ task_id: 'task_base', waiting_for: 'task_grip' }),
    ]);
    memory.observe(
      t.context('execution.completed', { message: '夹爪到位' }, 'task_grip'),
    );
    memory.observe(
      t.context('execution.started', { message: '底座开始转动' }, 'task_base'),
    );
    expect(memory.focus('feedback-conv', 'task_question').executing).toEqual([
      expect.objectContaining({ task_id: 'task_base' }),
    ]);
  });
});
