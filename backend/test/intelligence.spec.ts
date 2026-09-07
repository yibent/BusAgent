/* eslint-disable @typescript-eslint/require-await -- asynchronous in-memory doubles implement the persistence/model contracts */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyQueue,
  semanticEvidence,
  type Decision,
  type Goal,
  type QueueState,
} from '../src/apps/desktop-robot/intelligence/types.js';
import {
  applyResult,
  completionReply,
  executablePlan,
  TaskEngine,
} from '../src/apps/desktop-robot/intelligence/task-engine.js';
import {
  QueueStore,
  type QueuedEvent,
  type TaskStore,
} from '../src/apps/desktop-robot/intelligence/queue-store.js';
import {
  ModelConfig,
  completionsUrl,
} from '../src/apps/desktop-robot/intelligence/model-config.js';
import * as planning from '../src/apps/desktop-robot/intelligence/planning.js';
import type {
  ModelAnswer,
  Message,
} from '../src/apps/desktop-robot/intelligence/model-client.js';
import type { InProcessEventContext } from '../src/adapters/in-process/agent-classes.js';
import type { RuntimeState } from '../src/app/runtime-state.service.js';
import type { EventBus } from '../src/bus/event-bus.service.js';

class MemoryStore implements TaskStore {
  state = emptyQueue();
  events: QueuedEvent[] = [];
  async read() {
    return structuredClone(this.state);
  }
  async change<T>(mutate: (state: QueueState, emit: (e: QueuedEvent) => void) => T) {
    const state = structuredClone(this.state);
    const emitted: QueuedEvent[] = [];
    const result = mutate(state, (e) => emitted.push(e));
    state.revision++;
    this.state = state;
    for (const entry of emitted)
      if (!this.events.some((e) => e.key === entry.key)) this.events.push(entry);
    return result;
  }
  async pending() {
    return structuredClone(this.events);
  }
  async delivered(key: string) {
    this.events = this.events.filter((e) => e.key !== key);
  }
}
const profile = {
  id: 'test',
  name: 'Test',
  provider: 'qwen' as const,
  baseUrl: 'https://model.test/v1',
  model: 'test-plus',
  apiKey: 'test-secret',
  enabled: true,
  thinking: false,
  vision: true,
};
const decision = (partial: Partial<Decision> = {}): Decision => ({
  mode: 'simple',
  summary: '抓起并放下',
  completion: '物体已放稳',
  outcome: 'continue',
  message: '',
  actions: [
    {
      title: '拿起方块',
      skill: 'grasp',
      params: { target: 'green block' },
      review_after: false,
    },
    {
      title: '放到桌面空处',
      skill: 'place_held',
      params: { destination: { label: 'table', selection: 'free_space' } },
      review_after: false,
    },
  ],
  ...partial,
});
const context = (
  eventId: string,
  type = 'intent.created',
  payload: unknown = { text: '拿起来再放下' },
  taskId?: string,
) =>
  ({
    event: {
      eventId,
      eventType: type,
      correlationId: 'conversation',
      payload,
      ...(taskId ? { taskId } : {}),
    },
  }) as InProcessEventContext;
const drain = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('durable goal execution', () => {
  let store: MemoryStore;
  let engine: TaskEngine;
  let publish: ReturnType<typeof vi.fn>;
  const tick = () => (engine as unknown as { tick(): Promise<void> }).tick();
  beforeEach(() => {
    vi.stubEnv('BUSAGENT_ROBOT', 'franka_panda');
    vi.stubEnv('BUSAGENT_INTELLIGENCE', '1');
    store = new MemoryStore();
    publish = vi.fn().mockResolvedValue({});
    const models = {
      settings: vi.fn().mockResolvedValue({ images: true, recoveryBudget: 3 }),
      profile: vi.fn().mockResolvedValue(profile),
      profilesFor: vi.fn().mockResolvedValue([profile]),
    };
    const runtime = { isReady: () => true, current: { agents: new Map() } };
    engine = new TaskEngine(
      store as unknown as QueueStore,
      models as unknown as ModelConfig,
      runtime as unknown as RuntimeState,
      { publishFromAgent: publish } as unknown as EventBus,
    );
    publish.mockImplementation(
      async (
        _source: string,
        input: { event_type: string; payload: Record<string, unknown> },
      ) => {
        if (!['planning.requested', 'supervision.requested'].includes(input.event_type))
          return {};
        const role =
          input.event_type === 'planning.requested' ? 'planner' : 'supervisor';
        const request = context(
          String(input.payload.request_id),
          input.event_type,
          input.payload,
        );
        request.publish = async (output) => {
          const response = context(
            'decision-' + String(input.payload.request_id),
            output.event_type,
            output.payload,
          );
          response.event.sourceAgentId =
            role === 'planner' ? 'robot.planning' : 'robot.supervision';
          await engine.handle(response);
          return;
        };
        queueMicrotask(() => {
          void engine.handleInference(role, request);
        });
        return {};
      },
    );
    vi.spyOn(engine, 'live').mockResolvedValue({
      phase: 'idle',
      command_id: null,
      holding: { verified: false },
      capabilities: { skills: ['grasp', 'place_held', 'perceive'] },
    });
    vi.spyOn(planning, 'planGoal').mockResolvedValue(decision());
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 404 })),
    );
  });
  afterEach(() => {
    engine.onModuleDestroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it('never turns a voice filler or progress followup into another goal', async () => {
    await engine.handle(context('filler', 'intent.created', { text: '嗯。' }));
    await engine.handle(
      context('status', 'intent.created', { text: '还没有得到结果吗？' }),
    );
    await tick();
    expect(store.state.goals).toEqual([]);
    expect(planning.planGoal).not.toHaveBeenCalled();
    expect(
      publish.mock.calls.some(
        ([, event]) =>
          (event as { event_type: string }).event_type === 'robot.execute.requested',
      ),
    ).toBe(false);
  });
  it('keeps the scheduler and status replies available while visual preparation is waiting', async () => {
    let finish!: (value: boolean) => void;
    const preparation = vi
      .spyOn(
        engine as unknown as { preparePrimitive(...args: unknown[]): Promise<boolean> },
        'preparePrimitive',
      )
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    store.state.goals = [
      {
        id: 'preparing',
        conversation_id: 'conversation',
        input_event_id: 'source',
        source: '任选一个零件装箱',
        state: 'running',
        interaction: false,
        mode: 'simple',
        summary: '装箱',
        completion: '放稳',
        message: '',
        review_reason: '',
        recovery_count: 0,
        created_at: '2026-09-08',
        updated_at: '2026-09-08',
        model_calls: 1,
        revision: 1,
        steps: [
          {
            title: '装箱',
            skill: 'pick_place',
            params: { target: { label: 'part', selection: 'any' } },
            review_after: false,
            id: 'part-step',
            task_id: 'part-task',
            command_id: 'part-command',
            state: 'pending',
            attempt: 1,
          },
        ],
      },
    ];
    await tick();
    expect(preparation).toHaveBeenCalledTimes(1);
    await engine.handle(
      context('query', 'intent.created', { text: '还没有得到结果吗？' }),
    );
    await tick();
    expect(preparation).toHaveBeenCalledTimes(1);
    expect(store.state.goals).toHaveLength(1);
    expect(
      publish.mock.calls.some(
        ([, e]) => (e as { event_type: string }).event_type === 'intelligence.reply',
      ),
    ).toBe(true);
    finish(false);
    await drain();
  });
  it('plans a spoken reset without an LLM, reports pause, and answers progress without creating another task', async () => {
    store.state.paused = true;
    vi.spyOn(engine, 'live').mockResolvedValue({
      phase: 'hold',
      capabilities: { skills: ['home'] },
    });
    await engine.handle(
      context('home', 'intent.created', { text: '嗯，那你。先把机械臂复位吧。' }),
    );
    await tick();
    await drain();
    await tick();
    expect(planning.planGoal).not.toHaveBeenCalled();
    expect(store.state.goals[0]?.steps[0]?.skill).toBe('home');
    expect(store.state.goals[0]?.message).toContain('尚未开始');
    expect(store.state.goals[0]?.message).toContain('暂停');
    expect(
      publish.mock.calls.some(
        ([, event]) => (event as { event_type: string }).event_type === 'plan.proposed',
      ),
    ).toBe(false);
    await engine.handle(
      context('status', 'intent.created', { text: '机械臂复位任务执行的怎么样了？' }),
    );
    const reply = store.events.findLast(
      (e) => e.event.event_type === 'intelligence.reply',
    )?.event.payload;
    expect(reply).toMatchObject({
      verbatim: true,
      queue_paused: true,
      target_goal_id: 'goal_home',
    });
    expect(JSON.stringify(reply)).toContain('尚未开始');
    expect(store.state.goals).toHaveLength(1);
    expect(store.state.paused).toBe(true);
    store.state.goals.push({
      ...store.state.goals[0]!,
      id: 'old-blocked-test',
      state: 'blocked',
      steps: [],
    });
    await engine.control('resume', undefined, false);
    await tick();
    await drain();
    await tick();
    expect(store.state.goals[0]?.steps[0]?.state).toBe('dispatching');
    expect(planning.planGoal).not.toHaveBeenCalled();
    expect(store.state.goals[1]?.state).toBe('blocked');
  });
  it('keeps completed and failed questions out of the execution list', async () => {
    await engine.handle(context('question', 'intent.created', { text: '你是谁' }));
    expect((await engine.snapshot()).goals).toHaveLength(0);
    expect(store.state.goals).toHaveLength(1);
  });
  it('prepares an independent queued task during motion and uses it only after measured success', async () => {
    const models = (engine as unknown as { models: ModelConfig }).models;
    vi.spyOn(models, 'settings').mockResolvedValue({
      profiles: [profile],
      roles: { planner: 'test', supervisor: 'test' },
      fallbacks: { planner: [], supervisor: [] },
      images: true,
      supervisorEnabled: true,
      recoveryBudget: 3,
      performance: {
        lookahead: true,
        requestTimeoutMs: 20000,
        planningBudgetMs: 60000,
        toolRounds: 6,
      },
    });
    vi.spyOn(engine, 'live').mockResolvedValue({
      runtime_id: 'arena-one',
      phase: 'idle',
      holding: { verified: false },
      capabilities: { skills: ['pick_place'] },
    });
    const firstDecision = decision({
      actions: [
        {
          title: 'first',
          skill: 'pick_place',
          params: { target: 'orange gear', destination: { label: 'blue tray' } },
          review_after: false,
        },
      ],
    });
    const nextDecision = decision({
      actions: [
        {
          title: 'second',
          skill: 'pick_place',
          params: { target: 'cyan ring', destination: { label: 'yellow tray' } },
          review_after: false,
        },
      ],
    });
    vi.mocked(planning.planGoal)
      .mockResolvedValueOnce(firstDecision)
      .mockResolvedValueOnce(nextDecision);
    await engine.handle(
      context('first', 'intent.created', { text: '把橙色齿轮放进蓝色托盘' }),
    );
    await engine.handle(
      context('second', 'intent.created', { text: '把青色圆环放进黄色托盘' }),
    );
    await tick();
    await drain();
    await tick();
    const first = store.state.goals[0]!.steps[0]!;
    await engine.handle(
      context(
        'started',
        'execution.started',
        { command_id: first.command_id },
        first.task_id,
      ),
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({ state: 'running', command_id: first.command_id }),
            ),
          ),
        ),
    );
    await tick();
    await drain();
    expect(planning.planGoal).toHaveBeenCalledTimes(2);
    expect(store.state.goals[1]!.state).toBe('queued');
    expect(store.state.goals[1]!.steps[0]!.state).toBe('pending');
    await engine.handle(
      context(
        'done',
        'execution.completed',
        {
          command_id: first.command_id,
          result: { ok: true, holding: { verified: false } },
        },
        first.task_id,
      ),
    );
    await tick();
    await tick();
    await tick();
    expect(store.state.goals[1]!.steps[0]!.state).toBe('dispatching');
    expect(planning.planGoal).toHaveBeenCalledTimes(2);
  });

  it('accepts more than eight tasks and deduplicates replayed input', async () => {
    for (let i = 0; i < 20; i++) await engine.handle(context(`input-${i}`));
    await engine.handle(context('input-0'));
    expect(store.state.goals).toHaveLength(20);
    expect(planning.planGoal).not.toHaveBeenCalled();
  });
  it('leaves physical failures for manual review with zero supervisor calls when disabled', async () => {
    const models = (engine as unknown as { models: ModelConfig }).models;
    vi.spyOn(models, 'settings').mockResolvedValue({
      ...(await models.settings()),
      supervisorEnabled: false,
    });
    await engine.handle(context('manual-review'));
    await tick();
    await drain();
    await tick();
    await tick();
    const goal = store.state.goals[0]!;
    const first = goal.steps[0]!;
    await engine.handle(
      context(
        'grasp-failed',
        'execution.failed',
        {
          command_id: first.command_id,
          ok: false,
          failure: { code: 'NO_IK' },
          holding: { verified: false },
        },
        first.task_id,
      ),
    );
    const calls = vi.mocked(planning.planGoal).mock.calls.length;
    await tick();
    await drain();
    await tick();
    expect(planning.planGoal).toHaveBeenCalledTimes(calls);
    expect(store.state.goals[0]!.state).toBe('review');
    expect(store.state.goals[0]!.steps[0]!.state).toBe('failed');
    expect(store.state.goals[0]!.message).toContain('自动监督 LLM 已关闭');
  });
  it('plans a grasp for the following placement orientation without changing queue intent', async () => {
    await engine.handle(context('oriented-transfer'));
    await tick();
    await drain();
    const goal = store.state.goals[0]!;
    const first = goal.steps[0]!;
    const second = goal.steps[1]!;
    const orientation = {
      axis_ref: `obs:${'a'.repeat(32)}:scene_camera:0`,
      endpoint: 0,
      direction: 'up',
    };
    second.params.orientation = orientation;
    const plan = executablePlan(goal, first);
    expect(plan.steps[0]!.params.orientation).toEqual(orientation);
    expect(first.params.orientation).toBeUndefined();
    second.skill = 'grasp';
    expect(executablePlan(goal, first).steps[0]!.params.orientation).toBeUndefined();
  });
  it('dispatches the next step only after the first physical result, with stable command ids', async () => {
    await engine.handle(context('input'));
    await tick();
    await drain();
    await tick();
    await tick();
    let goal = store.state.goals[0]!;
    expect(goal.steps.map((s) => s.state)).toEqual(['dispatching', 'pending']);
    const first = goal.steps[0]!;
    const plan = executablePlan(goal, first);
    expect(plan.command_id).toBe(first.command_id);
    expect(plan.queue_goal_id).toBe(goal.id);
    await engine.handle(
      context(
        'done-1',
        'execution.completed',
        { command_id: first.command_id, ok: true },
        first.task_id,
      ),
    );
    await tick();
    goal = store.state.goals[0]!;
    expect(goal.steps.map((s) => s.state)).toEqual(['completed', 'dispatching']);
    expect(goal.state).toBe('running');
    expect(planning.planGoal).toHaveBeenCalledTimes(1);
    await engine.handle(
      context(
        'old-duplicate',
        'execution.completed',
        { command_id: first.command_id },
        first.task_id,
      ),
    );
    expect(store.state.goals[0]!.steps[1]!.state).toBe('dispatching');
  });
  it('retains remaining actions and later user tasks on failure', async () => {
    await engine.handle(context('first'));
    await engine.handle(context('second'));
    await tick();
    await drain();
    await tick();
    const first = store.state.goals[0]!.steps[0]!;
    await engine.handle(
      context(
        'failed',
        'execution.failed',
        { command_id: first.command_id, message: 'empty grasp' },
        first.task_id,
      ),
    );
    expect(store.state.goals[0]!.state).toBe('review');
    expect(store.state.goals[0]!.steps[1]!.state).toBe('pending');
    expect(store.state.goals[1]!.state).toBe('queued');
  });
  it('rejects mismatched command results', async () => {
    await engine.handle(context('input'));
    await tick();
    await drain();
    await tick();
    const step = store.state.goals[0]!.steps[0]!;
    await engine.handle(
      context(
        'stale',
        'execution.completed',
        { command_id: 'someone-else' },
        step.task_id,
      ),
    );
    expect(store.state.goals[0]!.steps[0]!.state).toBe('dispatching');
  });
  it('pauses without deleting pending work and a late completion cannot unpause', async () => {
    await engine.handle(context('first'));
    await engine.handle(context('second'));
    await tick();
    await drain();
    await tick();
    const step = store.state.goals[0]!.steps[0]!;
    await engine.control('pause');
    await engine.handle(
      context(
        'done',
        'execution.completed',
        { command_id: step.command_id },
        step.task_id,
      ),
    );
    expect(store.state.paused).toBe(true);
    expect(store.state.goals[0]!.state).toBe('paused');
    expect(store.state.goals[1]!.state).toBe('queued');
    await engine.control('resume');
    expect(store.state.goals[0]!.state).toBe('review');
  });
  it('cancels only the requested waiting task without freezing other tasks', async () => {
    await engine.handle(context('first'));
    await engine.handle(context('second'));
    await engine.control('cancel', store.state.goals[1]!.id);
    expect(store.state.goals[0]!.state).toBe('queued');
    expect(store.state.paused).toBe(false);
    expect(
      store.events.filter((e) => e.event.event_type === 'interrupt.requested'),
    ).toHaveLength(0);
  });
  it('does not interpret its own cancellation interrupt as a global pause', async () => {
    await engine.handle(context('input'));
    await engine.handle(
      context('own-stop', 'interrupt.requested', { queue_control: true }),
    );
    expect(store.state.paused).toBe(false);
  });
  it('recovers a physical completion from the controller ledger after event loss', async () => {
    await engine.handle(context('input'));
    await tick();
    await drain();
    await tick();
    const step = store.state.goals[0]!.steps[0]!;
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ state: 'completed', ok: true, command_id: step.command_id }),
      ),
    );
    await tick();
    expect(store.state.goals[0]!.steps[0]!.state).toBe('completed');
    expect(store.state.goals[0]!.steps[1]!.state).toBe('pending');
  });
  it('keeps unknown physical results unresolved instead of submitting another grasp', async () => {
    await engine.handle(context('input'));
    await tick();
    await drain();
    await tick();
    const step = store.state.goals[0]!.steps[0]!;
    await engine.handle(context('unknown', 'execution.unknown', {}, step.task_id));
    await tick();
    expect(store.state.goals[0]!.steps[0]!.state).toBe('unknown');
    expect(store.state.goals[0]!.steps[1]!.state).toBe('pending');
    expect(planning.planGoal).toHaveBeenCalledTimes(1);
  });
  it('dispatches a complete complex plan and finishes with supervision disabled', async () => {
    const models = (engine as unknown as { models: ModelConfig }).models;
    vi.spyOn(models, 'settings').mockResolvedValue({
      images: false,
      supervisorEnabled: false,
      recoveryBudget: 3,
    } as Awaited<ReturnType<ModelConfig['settings']>>);
    vi.mocked(planning.planGoal).mockResolvedValueOnce(
      decision({ mode: 'complex', plan_scope: 'complete' }),
    );
    await engine.handle(
      context('complex', 'intent.created', { text: '把两个明确步骤执行完' }),
    );
    await tick();
    await drain();
    expect(store.state.goals[0]!.steps).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      await tick();
      const step = store.state.goals[0]!.steps[i]!;
      await engine.handle(
        context(
          'done-' + i,
          'execution.completed',
          { command_id: step.command_id, holding: { verified: i === 0 } },
          step.task_id,
        ),
      );
    }
    await tick();
    expect(store.state.goals[0]!.state).toBe('completed');
    expect(vi.mocked(planning.planGoal).mock.calls.map((call) => call[1])).toEqual([
      'planner',
    ]);
    expect(
      publish.mock.calls.some(
        (call) =>
          (call[1] as { event_type: string }).event_type === 'planning.requested',
      ),
    ).toBe(true);
    expect(
      publish.mock.calls.some(
        (call) =>
          (call[1] as { event_type: string }).event_type === 'supervision.requested',
      ),
    ).toBe(false);
  });
  it('processes explicit queue management while motion is in flight, leaving ordinary tasks FIFO', async () => {
    await engine.handle(context('first'));
    await tick();
    await drain();
    await tick();
    await engine.handle(
      context('second', 'intent.created', { text: '把红色方块放到托盘' }),
    );
    await engine.handle(
      context('manage', 'intent.created', { text: '取消刚才那个红色方块任务' }),
    );
    vi.mocked(planning.planGoal).mockImplementation(async (_profile, _role, goal) =>
      goal.source.includes('取消')
        ? decision({ outcome: 'chat', actions: [], message: '队列已更新' })
        : decision(),
    );
    await tick();
    await drain();
    expect(vi.mocked(planning.planGoal).mock.calls.at(-1)?.[2].source).toContain(
      '取消',
    );
    expect(store.state.goals[1]!.state).toBe('queued');
    expect(store.state.goals[0]!.steps[0]!.state).toBe('dispatching');
  });
  it('answers history while another planner is slow without enqueueing a physical action or a canned receipt', async () => {
    let finish!: (decision: Decision) => void;
    vi.mocked(planning.planGoal).mockImplementation(async (_profile, _role, goal) =>
      goal.source.includes('刚才')
        ? decision({ outcome: 'chat', actions: [], message: '刚才尚未开始动作。' })
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    await engine.handle(context('slow'));
    await tick();
    await drain();
    await engine.handle(
      context('query', 'intent.created', {
        text: '我们刚才都干了啥',
        utterance_id: 'u1',
      }),
    );
    await engine.handle(
      context('query-replay', 'intent.created', {
        text: '我们刚才都干了啥',
        utterance_id: 'u1',
      }),
    );
    expect(store.state.goals).toHaveLength(2);
    expect(store.events.some((e) => JSON.stringify(e).includes('已加入任务队列'))).toBe(
      false,
    );
    await tick();
    await drain();
    expect(store.state.goals[0]!.state).toBe('planning');
    expect(store.state.goals[1]!.state).toBe('completed');
    expect(store.state.goals[1]!.steps).toHaveLength(0);
    finish(decision());
    await drain();
  });
  it('correlates immediate pause feedback with the new utterance rather than the original motion request', async () => {
    await engine.handle(context('original'));
    await tick();
    await drain();
    await engine.handle(context('pause-input', 'intent.created', { text: '暂停' }));
    const payloads = store.events
      .filter((e) => e.event.event_type === 'intelligence.reply')
      .map((e) => e.event.payload);
    expect(payloads.at(-1)).toMatchObject({
      instruction_id: 'pause-input',
      user_text: '暂停',
      goal_state: 'paused',
    });
    expect(store.state.goals[0]!.source).toBe('拿起来再放下');
  });
  it('makes an asynchronously rejected proposal recoverable and ignores its redelivery', async () => {
    publish.mockResolvedValue({}); // Delivery happens after the worker returns.
    await engine.handle(context('invalid-proposal'));
    await tick();
    await drain();
    const waiting = store.state.goals[0]!;
    expect(waiting.state).toBe('planning');
    const response = context('invalid-decision', 'intelligence.decision.proposed', {
      goal_id: waiting.id,
      request_id: waiting.inference_request!.id,
      revision: waiting.revision,
      decision: decision({ mode: 'complex', actions: [] }),
      capabilities: { skills: ['grasp', 'place_held', 'perceive'] },
    });
    response.event.sourceAgentId = 'robot.planning';
    await expect(engine.handle(response)).resolves.toBeUndefined();
    expect(store.state.goals[0]).toMatchObject({
      state: 'blocked',
      source: '拿起来再放下',
      steps: [],
    });
    expect(store.state.goals[0]!.inference_request).toBeUndefined();
    const saved = structuredClone(store.state);
    await engine.handle(response);
    expect(store.state).toEqual(saved);
    expect(planning.planGoal).not.toHaveBeenCalled();
  });
  it('does not confuse an outline with completed physical execution', async () => {
    vi.mocked(planning.planGoal)
      .mockResolvedValueOnce(decision({ mode: 'complex', actions: [] }))
      .mockResolvedValueOnce(decision({ outcome: 'complete', actions: [] }));
    await engine.handle(context('outline'));
    await tick();
    await drain();
    await tick();
    await drain();
    expect(store.state.goals[0]!.steps).toHaveLength(0);
    expect(store.state.goals[0]!.state).toBe('blocked');
  });
  it('preserves the overall completion condition across successful observation checkpoints', async () => {
    vi.mocked(planning.planGoal)
      .mockResolvedValueOnce(
        decision({
          mode: 'complex',
          summary: '整理两个零件',
          completion: '两个零件都已放入各自托盘',
          plan_scope: 'stage',
          actions: [
            {
              title: '观察目标',
              skill: 'perceive',
              params: { category: 'part' },
              review_after: true,
            },
          ],
        }),
      )
      .mockResolvedValue(
        decision({
          summary: '继续观察',
          completion: '当前目标已识别',
          actions: [
            {
              title: '观察目标',
              skill: 'perceive',
              params: { category: 'part' },
              review_after: true,
            },
          ],
        }),
      );
    await engine.handle(context('checkpoints'));
    await tick();
    await drain();
    for (let i = 0; i < 5; i++) {
      await tick();
      await drain();
      await tick();
      const step = store.state.goals[0]!.steps.at(-1)!;
      await engine.handle(
        context(
          `observed-${i}`,
          'execution.completed',
          { command_id: step.command_id },
          step.task_id,
        ),
      );
    }
    const goal = store.state.goals[0]!;
    expect(goal.completion).toBe('两个零件都已放入各自托盘');
    expect(goal.summary).toBe('整理两个零件');
    expect(goal.steps.filter((s) => s.state === 'completed')).toHaveLength(5);
    expect(goal.recovery_count).toBe(0);
    expect(goal.state).toBe('review');
  });
  it.each([false, true])(
    'continues the existing queue after a checkpoint and acknowledges reviewed checks: %s',
    async (hasLocalCheck) => {
      vi.mocked(planning.planGoal)
        .mockResolvedValueOnce(
          decision({
            actions: [
              {
                title: '观察',
                skill: 'perceive',
                params: { category: 'part' },
                review_after: true,
              },
              {
                title: '抓取',
                skill: 'grasp',
                params: { target: 'part' },
                review_after: false,
              },
            ],
          }),
        )
        .mockResolvedValueOnce(decision({ actions: [] }));
      await engine.handle(context('keep-plan'));
      await tick();
      await drain();
      await tick();
      const first = store.state.goals[0]!.steps[0]!;
      const pending = store.state.goals[0]!.steps[1]!.command_id;
      await engine.handle(
        context(
          'observed',
          'execution.completed',
          { command_id: first.command_id },
          first.task_id,
        ),
      );
      if (hasLocalCheck)
        store.state.goals[0]!.checks = [
          {
            id: 'local-check',
            step_id: first.id,
            command_id: first.command_id,
            revision: store.state.goals[0]!.revision,
            state: 'uncertain',
            result: { reason: 'occluded ROI' },
          },
        ];
      await tick();
      await drain();
      await tick();
      expect(store.state.goals[0]!.steps).toHaveLength(2);
      expect(store.state.goals[0]!.steps[1]!.command_id).toBe(pending);
      expect(store.state.goals[0]!.steps[1]!.state).toBe('dispatching');
      if (hasLocalCheck)
        expect(store.state.goals[0]!.checks![0]!.state).toBe('superseded');
    },
  );
  it('does not redeliver a cancelled child after pause followed by immediate resume', async () => {
    await engine.handle(context('first'));
    await tick();
    await drain();
    await tick();
    await engine.control('pause');
    await engine.control('resume');
    store.state.goals[0]!.steps[0]!.last_dispatched_at = new Date(
      Date.now() - 16000,
    ).toISOString();
    await tick();
    expect(store.state.goals[0]!.steps[0]!.state).toBe('cancelled');
    expect(store.events.some((e) => e.key.startsWith('redispatch:'))).toBe(false);
  });
  it('retries missing delivery using the exact physical command and exposes an unresolved result', async () => {
    await engine.handle(context('first'));
    await tick();
    await drain();
    await tick();
    const command = store.state.goals[0]!.steps[0]!.command_id;
    for (let i = 0; i < 3; i++) {
      store.state.goals[0]!.steps[0]!.last_dispatched_at = new Date(
        Date.now() - 16000,
      ).toISOString();
      await tick();
    }
    expect(store.state.goals[0]!.steps[0]!.command_id).toBe(command);
    expect(store.state.goals[0]!.steps[0]!.delivery_attempts).toBe(3);
    expect(store.state.goals[0]!.steps[0]!.state).toBe('unknown');
    expect(store.state.goals[0]!.state).toBe('blocked');
    expect(planning.planGoal).toHaveBeenCalledTimes(1);
  });
  it('does not replay a missing command into a restarted simulator', async () => {
    await engine.handle(context('first'));
    await tick();
    await drain();
    await tick();
    const step = store.state.goals[0]!.steps[0]!;
    step.runtime_id = 'previous-simulator';
    step.last_dispatched_at = new Date(Date.now() - 16000).toISOString();
    vi.spyOn(engine, 'live').mockResolvedValue({
      runtime_id: 'new-simulator',
      holding: { verified: false },
    });
    await tick();
    expect(store.state.goals[0]!.state).toBe('blocked');
    expect(store.state.goals[0]!.steps[0]!.result?.runtime_changed).toBe(true);
    expect(store.events.some((e) => e.key.startsWith('redispatch:'))).toBe(false);
    await engine.control('retry', store.state.goals[0]!.id);
    expect(store.state.goals[0]!.steps[0]!.state).toBe('superseded');
    expect(store.state.goals[0]!.state).toBe('review');
  });
  it('keeps measured holding and scene evidence from terminal feedback', async () => {
    await engine.handle(context('first'));
    await tick();
    await drain();
    await tick();
    const step = store.state.goals[0]!.steps[0]!;
    await engine.handle(
      context(
        'done',
        'execution.completed',
        {
          result: {
            holding: { verified: true },
            vision: { semantic_status: 'detected' },
          },
        },
        step.task_id,
      ),
    );
    expect(store.state.scene.holding).toEqual({ verified: true });
    expect(store.state.scene.observation?.semantic_status).toBe('detected');
  });
  it('does not count a recovery home move as progress toward the manipulation goal', async () => {
    await engine.handle(context('first'));
    await tick();
    await drain();
    await tick();
    const goal = store.state.goals[0]!;
    goal.recovery_count = 2;
    const step = goal.steps[0]!;
    step.skill = 'home';
    await engine.handle(
      context(
        'home-done',
        'execution.completed',
        { command_id: step.command_id },
        step.task_id,
      ),
    );
    expect(store.state.goals[0]!.recovery_count).toBe(2);
  });
  it('reports scene findings and preserves uncertainty without another model call', () => {
    const goal = {
      source: '看看场景',
      steps: [
        {
          state: 'completed',
          skill: 'perceive',
          params: { scope: 'scene' },
          result: {
            result: {
              vision: {
                views: [{ objects: [{ label: 'nut' }, { label: 'nut' }], regions: [] }],
              },
            },
          },
        },
      ],
    } as unknown as Goal;
    expect(completionReply(goal)).toContain('nut');
    expect(completionReply(goal)).toContain('未列出不代表');
    expect(completionReply(goal).match(/nut/g)).toHaveLength(1);
  });
});

describe('model-driven observation', () => {
  afterEach(() => vi.restoreAllMocks());
  const answer = (name: string, args: unknown): ModelAnswer => ({
    model: 'test-plus',
    elapsed_ms: 12,
    usage: {},
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: name,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
  });
  it('retrieves archived context through the planner tool and returns information without actions', async () => {
    const history = vi.fn().mockResolvedValue({
      recent: [{ ref: 'old', text: '先别重试，等我指定放置位置' }],
    });
    const call = vi
      .fn()
      .mockResolvedValueOnce(answer('read_history', { ref: 'old' }))
      .mockResolvedValueOnce(
        answer(
          'submit_plan',
          decision({
            outcome: 'chat',
            actions: [],
            message: '你刚才要求先别重试，等待指定位置。',
          }),
        ),
      );
    const result = await planning.planGoal(
      profile,
      'planner',
      { source: '刚才我说过什么', steps: [] } as unknown as Goal,
      emptyQueue(),
      {
        conversation: { omitted: 20, archive_available: true },
        images: false,
        readHistory: history,
        readState: async () => ({ available: false }),
        readImage: vi.fn(),
        record: vi.fn(),
      },
      new AbortController().signal,
      call,
    );
    expect(history).toHaveBeenCalledWith({ ref: 'old' });
    expect(JSON.stringify(call.mock.calls[1]?.[1])).toContain('先别重试');
    expect(result.actions).toHaveLength(0);
    expect(result.outcome).toBe('chat');
  });
  const fakeGoal = {
    id: 'goal',
    steps: [],
    source: '检查朝向',
    state: 'queued',
  } as unknown as Goal;
  it('reserves a final plan submission after the observation budget is consumed', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(answer('read_state', {}))
      .mockResolvedValueOnce(answer('submit_plan', decision()));
    const result = await planning.planGoal(
      profile,
      'planner',
      fakeGoal,
      emptyQueue(),
      {
        images: false,
        toolRounds: 1,
        readImage: vi.fn(),
        readState: async () => ({}),
        record: async () => {},
      },
      new AbortController().signal,
      call,
    );
    expect(result).toEqual(decision());
    expect(
      (call.mock.calls[1]![2] as Array<{ function: { name: string } }>).map(
        (tool: { function: { name: string } }) => tool.function.name,
      ),
    ).toEqual(['submit_plan']);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('does not send images by default', async () => {
    const call = vi.fn().mockResolvedValue(answer('submit_plan', decision()));
    const readImage = vi.fn();
    await planning.planGoal(
      profile,
      'planner',
      fakeGoal,
      emptyQueue(),
      { images: true, readImage, readState: async () => ({}), record: async () => {} },
      new AbortController().signal,
      call,
    );
    expect(readImage).not.toHaveBeenCalled();
    expect(JSON.stringify(call.mock.calls[0])).not.toContain('data:image');
  });
  it('grounds an uncertain first-view selection using the alternate snapshot', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(
        answer('locate_object', {
          description: 'part inside bin',
          category: 'metal cylinder',
          camera: 'scene',
          inspect: 'axis',
        }),
      )
      .mockResolvedValueOnce(
        answer('select_box', {
          found: false,
          description: 'reflection',
          uncertainty: 'shape uncertain',
        }),
      )
      .mockResolvedValueOnce(
        answer('select_box', {
          found: true,
          box_normalized: [0.5, 0.3, 0.6, 0.4],
          description: 'side view part',
          uncertainty: '',
        }),
      )
      .mockResolvedValueOnce(answer('submit_plan', decision()));
    const readImage = vi.fn(async (camera: string) => ({
      bytes: Buffer.from(camera),
      metadata: { snapshot_ref: camera + '-snapshot' },
    }));
    const observe = vi.fn().mockResolvedValue({ ok: true, command_id: 'vision-test' });
    await planning.planGoal(
      profile,
      'planner',
      fakeGoal,
      emptyQueue(),
      {
        images: true,
        readImage,
        observe,
        readState: async () => ({}),
        record: async () => {},
      },
      new AbortController().signal,
      call,
    );
    expect(readImage.mock.calls.map(([camera]) => camera)).toEqual(['scene', 'side']);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        grounding: {
          snapshot_ref: 'side-snapshot',
          camera: 'side_camera',
          box_normalized: [0.5, 0.3, 0.6, 0.4],
        },
        inspect: 'axis',
      }),
      expect.any(AbortSignal),
    );
  });
  it('reads one requested image for this call and records only its reference', async () => {
    const snapshots: Message[][] = [];
    const events: Record<string, unknown>[] = [];
    const replies = [
      answer('read_image', {
        camera: 'wrist',
        purpose: '判断正反端面',
        observation_ref: 'same-frame',
      }),
      {
        message: { role: 'assistant' as const, content: 'closed end is visible' },
        model: profile.model,
        usage: {},
        elapsed_ms: 1,
      },
      answer('submit_review', {
        verdict: 'repair',
        reason: '继续放置',
        actions: decision().actions,
        plan_scope: 'complete',
      }),
    ];
    const call = vi.fn(async (_profile, messages: Message[]) => {
      snapshots.push(structuredClone(messages));
      return replies.shift()!;
    });
    const readImage = vi.fn().mockResolvedValue({
      bytes: Buffer.from('jpeg-data'),
      metadata: { camera: 'wrist' },
    });
    await planning.planGoal(
      profile,
      'supervisor',
      fakeGoal,
      emptyQueue(),
      {
        images: true,
        readImage,
        readObservation: async () => ({
          geometry: {
            axis_ref: 'observed-axis',
            endpoints_px: [
              [40, 80],
              [120, 140],
            ],
          },
        }),
        readState: async () => ({}),
        record: async (e) => {
          events.push(e);
        },
      },
      new AbortController().signal,
      call,
    );
    expect(JSON.stringify(snapshots[0])).not.toContain('data:image');
    expect(JSON.stringify(snapshots[1])).toContain('data:image/jpeg');
    expect(JSON.stringify(snapshots[1])).toContain('endpoints_px');
    expect(JSON.stringify(snapshots[2])).not.toContain('data:image');
    expect(JSON.stringify(events)).not.toContain('anBlZy1kYXRh');
    expect(readImage).toHaveBeenCalledWith('wrist', 'same-frame');
  });
  it('grounds a box against the exact requested image and returns a real executable reference', async () => {
    let round = 0;
    const observe = vi.fn().mockResolvedValue({
      ok: true,
      command_id: 'vision_command',
      vision: {
        request_id: 'c'.repeat(32),
        references: [{ ref: `obs:${'c'.repeat(32)}:scene_camera:0` }],
      },
    });
    const events: Record<string, unknown>[] = [];
    const call = vi.fn(async (_profile, messages: Message[]) => {
      round++;
      if (round === 1)
        return answer('read_image', { camera: 'scene', purpose: 'select bin part' });
      if (round === 2)
        return {
          message: { role: 'assistant' as const, content: 'part visible' },
          model: profile.model,
          usage: {},
          elapsed_ms: 1,
        };
      if (round === 3) {
        const toolReply = messages.findLast((m) => m.role === 'tool');
        const image = JSON.parse(
          typeof toolReply!.content === 'string' ? toolReply!.content : '{}',
        ) as { image_ref: string };
        return answer('ground_region', {
          image_ref: image.image_ref,
          category: 'part',
          box_2d: [200, 100, 400, 300],
        });
      }
      expect(JSON.stringify(messages)).toContain(
        `obs:${'c'.repeat(32)}:scene_camera:0`,
      );
      return answer('submit_plan', decision());
    });
    await planning.planGoal(
      profile,
      'planner',
      fakeGoal,
      emptyQueue(),
      {
        images: true,
        observe,
        readImage: async () => ({
          bytes: Buffer.from('jpeg'),
          metadata: { camera: 'scene', snapshot_ref: 'b'.repeat(32) },
        }),
        readState: async () => ({}),
        record: async (e) => {
          events.push(e);
        },
      },
      new AbortController().signal,
      call,
    );
    expect(observe.mock.calls[0]![0]).toMatchObject({
      selection: 'one',
      grounding: {
        camera: 'scene_camera',
        snapshot_ref: 'b'.repeat(32),
        box_normalized: [0.1, 0.2, 0.3, 0.4],
      },
    });
    expect(events.some((e) => e.kind === 'vision_tool')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('data:image');
  });
  it('lets a text planner request an image handled by its vision fallback', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(
        answer('read_image', { camera: 'scene', purpose: '判断位置' }),
      )
      .mockResolvedValueOnce({
        message: { role: 'assistant', content: 'object visible' },
        model: profile.model,
        usage: {},
        elapsed_ms: 1,
      })
      .mockResolvedValueOnce(answer('submit_plan', decision()));
    const readImage = vi.fn().mockResolvedValue({
      bytes: Buffer.from('jpeg-data'),
      metadata: { camera: 'scene' },
    });
    await planning.planGoal(
      { ...profile, vision: false },
      'planner',
      fakeGoal,
      emptyQueue(),
      {
        images: true,
        fallbackProfiles: [{ ...profile, id: 'vision-backup' }],
        readImage,
        readState: async () => ({}),
        record: async () => {},
      },
      new AbortController().signal,
      call,
    );
    expect(readImage).toHaveBeenCalledOnce();
    expect(call.mock.calls.map(([p]) => (p as { id: string }).id)).toEqual([
      'test',
      'vision-backup',
      'test',
    ]);
  });
  it('returns unsupported skill errors to the model to choose a different loop', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(
        answer(
          'submit_plan',
          decision({
            actions: [
              {
                title: '使用不可用技能',
                skill: 'invented',
                params: {},
                review_after: false,
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(answer('submit_plan', decision()));
    const validate = vi.fn(async (d: Decision) => {
      if (d.actions[0]?.skill === 'invented')
        throw new Error('choose an available tool');
    });
    const result = await planning.planGoal(
      profile,
      'planner',
      fakeGoal,
      emptyQueue(),
      {
        images: true,
        readImage: vi.fn(),
        readState: async () => ({}),
        record: async () => {},
        validate,
      },
      new AbortController().signal,
      call,
    );
    expect(result.actions[0]!.skill).toBe('grasp');
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('removes image tensors and credentials while preserving semantic uncertainty', () => {
    expect(
      semanticEvidence({
        mask: [1, 2],
        image: 'bytes',
        apiKey: 'secret',
        score: 0.2,
        reason: 'tracking_lost',
        views: [{ image_url: 'data:image/jpeg;base64,x', label: 'nut' }],
      }),
    ).toEqual({ score: 0.2, reason: 'tracking_lost', views: [{ label: 'nut' }] });
  });
  it('normalizes a base URL or a full completion URL exactly once', () => {
    expect(completionsUrl('https://example.test/v1/')).toBe(
      'https://example.test/v1/chat/completions',
    );
    expect(completionsUrl('https://example.test/v1/chat/completions')).toBe(
      'https://example.test/v1/chat/completions',
    );
  });
  it('preserves another goal when applying failure feedback', () => {
    const state = emptyQueue();
    expect(applyResult(state, 'missing', 'execution.failed', {})).toBeUndefined();
  });
  it('reviews uncertain post-action evidence without replaying the completed action', () => {
    const state = emptyQueue();
    state.goals.push({
      id: 'g',
      state: 'running',
      recovery_count: 0,
      steps: [
        {
          id: 's',
          task_id: 't',
          command_id: 'c',
          skill: 'pick_place',
          state: 'running',
          title: '装入格位',
          review_after: false,
        },
        {
          id: 'next',
          task_id: 't2',
          command_id: 'c2',
          skill: 'pick_place',
          state: 'pending',
        },
      ],
    } as unknown as Goal);
    applyResult(state, 't', 'execution.completed', {
      command_id: 'c',
      result: {
        ok: true,
        review_required: true,
        review_reason: '新图像未能确认格位',
        evaluation: { physical_success: true },
      },
    });
    expect(state.goals[0]!.state).toBe('review');
    expect(state.goals[0]!.steps.map((s) => s.state)).toEqual(['completed', 'pending']);
    expect(state.goals[0]!.review_reason).toBe('新图像未能确认格位');
  });
});
