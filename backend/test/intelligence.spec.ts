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
  it('prepares an independent queued task during motion and uses it only after measured success', async () => {
    const models = (engine as unknown as { models: ModelConfig }).models;
    vi.spyOn(models, 'settings').mockResolvedValue({
      profiles: [profile],
      roles: { planner: 'test', supervisor: 'test' },
      fallbacks: { planner: [], supervisor: [] },
      images: true,
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
    expect(store.state.goals[1]!.steps).toHaveLength(0);
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
  it('passes complex goals to the supervisor before generating action steps', async () => {
    vi.mocked(planning.planGoal)
      .mockResolvedValueOnce(
        decision({ mode: 'complex', summary: '先观察桌面，再分类收纳', actions: [] }),
      )
      .mockResolvedValueOnce(decision());
    await engine.handle(context('complex', 'intent.created', { text: '帮我收拾桌子' }));
    await tick();
    await drain();
    expect(store.state.goals[0]!.state).toBe('review');
    expect(store.state.goals[0]!.steps).toHaveLength(0);
    await tick();
    await drain();
    expect(vi.mocked(planning.planGoal).mock.calls.map((call) => call[1])).toEqual([
      'planner',
      'supervisor',
    ]);
    expect(store.state.goals[0]!.steps).toHaveLength(2);
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
    vi.mocked(planning.planGoal).mockResolvedValueOnce(
      decision({ outcome: 'chat', actions: [], message: '队列已更新' }),
    );
    await tick();
    await drain();
    expect(vi.mocked(planning.planGoal).mock.calls.at(-1)?.[2].source).toContain(
      '取消',
    );
    expect(store.state.goals[1]!.state).toBe('queued');
    expect(store.state.goals[0]!.steps[0]!.state).toBe('dispatching');
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
          actions: [],
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
  it('continues the existing queue after a checkpoint without requiring a replacement plan', async () => {
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
    await tick();
    await drain();
    await tick();
    expect(store.state.goals[0]!.steps).toHaveLength(2);
    expect(store.state.goals[0]!.steps[1]!.command_id).toBe(pending);
    expect(store.state.goals[0]!.steps[1]!.state).toBe('dispatching');
  });
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
  const fakeGoal = {
    id: 'goal',
    steps: [],
    source: '检查朝向',
    state: 'queued',
  } as unknown as Goal;
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
  it('reads one requested image for this call and records only its reference', async () => {
    const snapshots: Message[][] = [];
    const events: Record<string, unknown>[] = [];
    const replies = [
      answer('read_image', { camera: 'wrist', purpose: '判断正反端面' }),
      answer('submit_plan', decision()),
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
    expect(JSON.stringify(events)).not.toContain('anBlZy1kYXRh');
    expect(readImage).toHaveBeenCalledWith('wrist');
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
      if (round === 2) {
        const toolReply = messages.findLast((m) => m.role === 'tool');
        const image = JSON.parse(String(toolReply!.content)) as { ref: string };
        return answer('ground_region', {
          image_ref: image.ref,
          category: 'part',
          box_normalized: [0.1, 0.2, 0.3, 0.4],
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
