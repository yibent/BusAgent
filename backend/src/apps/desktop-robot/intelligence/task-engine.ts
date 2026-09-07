import { canPrepareAhead, independentAhead } from './lookahead.js';
import { validatePlan } from '../plan-validator-node.js';
import { randomUUID } from 'node:crypto';
import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
  type InProcessPublishInput,
} from '../../../adapters/in-process/agent-classes.js';
import { RuntimeState } from '../../../app/runtime-state.service.js';
import { EventBus } from '../../../bus/event-bus.service.js';
import { Logger } from '../../../common/logger.js';
import { QueueStore, type QueuedEvent } from './queue-store.js';
import { ModelConfig } from './model-config.js';
import { planGoal } from './planning.js';
import {
  ended,
  inFlight,
  intelligenceEnabled,
  semanticEvidence,
  type Action,
  type Decision,
  type Goal,
  type QueueState,
  type QueueStep,
  type Role,
} from './types.js';
import type { RobotPlan } from '../instruction-types.js';

const now = () => new Date().toISOString();
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const activeGoal = (state: QueueState) =>
  state.goals.find((g) => !ended(g) && !['blocked', 'paused'].includes(g.state));
const stepsFor = (actions: Action[]): QueueStep[] =>
  actions.map((action) => {
    const id = randomUUID();
    return {
      ...action,
      id,
      attempt: 1,
      state: 'pending',
      task_id: `iq_${id}`,
      command_id: `iq_${id}:1`,
    };
  });

export function completionReply(goal: Goal): string {
  const step = goal.steps.findLast((s) => s.state === 'completed');
  if (!step || !['perceive', 'select_target'].includes(step.skill))
    return `已完成：${goal.summary || goal.source}`;
  const payload = record(step.result);
  const result = record(payload.result ?? payload);
  const vision = record(result.vision);
  const views = Array.isArray(vision.views) ? vision.views.map(record) : [];
  const labels = [
    ...new Set(
      views.flatMap((view) =>
        Array.isArray(view.objects)
          ? view.objects
              .map((o) => record(o).label)
              .filter((label): label is string => typeof label === 'string')
          : [],
      ),
    ),
  ];
  const descriptions = [
    ...new Set(
      views.flatMap((view) =>
        Array.isArray(view.regions)
          ? view.regions
              .map((r) => record(r).description)
              .filter(
                (description): description is string => typeof description === 'string',
              )
          : [],
      ),
    ),
  ];
  if (step.params.scope === 'scene')
    return [
      labels.length
        ? `当前视角识别到：${labels.join('、')}。`
        : '当前观察未给出明确的物品清单。',
      ...descriptions.slice(0, 4),
      '这是当前可见结果，未列出不代表场景中不存在。',
    ].join('\n');
  const label = step.params.category ?? vision.label;
  const target = typeof label === 'string' ? label : '目标';
  return (result.semantic_status ?? vision.semantic_status) === 'detected'
    ? `已定位 ${target}${step.params.tracking ? '，正在持续跟踪' : ''}。`
    : `已找到 ${target} 的候选区域，但类别尚未确认。`;
}

export function executablePlan(goal: Goal, step: QueueStep): RobotPlan {
  return {
    instruction_id: goal.input_event_id,
    task_version: 1,
    command_id: step.command_id,
    queue_goal_id: goal.id,
    dispatch_attempt: step.delivery_attempts ?? 1,
    intent: {
      intent:
        step.skill === 'grasp'
          ? 'pick'
          : step.skill === 'pick_place'
            ? 'pick_place'
            : step.skill === 'place_held'
              ? 'place_held'
              : step.skill === 'perceive'
                ? 'find'
                : 'motion',
      target: {
        category: typeof step.params.target === 'string' ? step.params.target : null,
        attributes: {},
        spatial_ref: null,
        ordinal: null,
        quantity: 1,
      },
      destination: null,
      constraints: { order: null, avoid: [] },
      needs_clarification: false,
      clarification_question: null,
      source_text: goal.source,
    },
    steps: [{ id: 1, skill: step.skill, params: step.params, why: step.title }],
  };
}

/** Pure state transition, also used by recovery: one terminal event completes one step only. */
export function applyResult(
  state: QueueState,
  taskId: string,
  type: string,
  payload: Record<string, unknown>,
): Goal | undefined {
  const goal = state.goals.find((g) => g.steps.some((s) => s.task_id === taskId));
  const step = goal?.steps.find((s) => s.task_id === taskId);
  if (!goal || !step || !inFlight(step)) return undefined;
  if (payload.command_id && payload.command_id !== step.command_id) return undefined;
  if (
    ['execution.accepted', 'execution.started', 'execution.progress'].includes(type)
  ) {
    step.state = 'running';
    step.started_at ??= now();
    return goal;
  }
  const terminal =
    type === 'execution.completed'
      ? 'completed'
      : type === 'execution.cancelled'
        ? 'cancelled'
        : type === 'execution.unknown'
          ? 'unknown'
          : 'failed';
  step.state = terminal;
  step.result = record(semanticEvidence(payload));
  const result = record(payload.result ?? payload);
  if (result.holding) state.scene.holding = record(semanticEvidence(result.holding));
  if (result.vision) {
    state.scene.observation = record(semanticEvidence(result.vision));
    state.scene.observed_at = now();
  }
  step.finished_at = now();
  goal.updated_at = now();
  if (ended(goal) || goal.state === 'paused') return goal;
  if (terminal === 'completed') {
    if (['grasp', 'pick_place', 'place_held'].includes(step.skill))
      goal.recovery_count = 0;
    goal.state = step.review_after ? 'review' : 'running';
    goal.review_reason = step.review_after
      ? `步骤“${step.title}”已完成，需要根据观察决定后续。`
      : '';
  } else {
    goal.state = 'review';
    goal.review_reason = `步骤“${step.title}”结果 ${terminal}；保留后续任务，根据当前持物和观测决定恢复。`;
  }
  return goal;
}

@Injectable()
export class TaskEngine
  implements InProcessAgent, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  readonly registrationKey = 'IntelligenceNode';
  private readonly logger = new Logger('Intelligence');
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private job: { id: string; abort: AbortController } | undefined;
  private ahead:
    | {
        goal: Goal;
        after: Goal;
        step: QueueStep;
        abort: AbortController;
        runtimeId: string | undefined;
        decision: Decision | undefined;
        finished: boolean;
      }
    | undefined;
  private aheadAttempted = new Set<string>();
  private restored = false;
  private lastError = '';
  constructor(
    private readonly store: QueueStore,
    private readonly models: ModelConfig,
    private readonly runtime: RuntimeState,
    private readonly bus: EventBus,
  ) {}
  onModuleInit() {
    if (!AgentClasses.has(this.registrationKey))
      AgentClasses.register(this.registrationKey, this);
  }
  onApplicationBootstrap() {
    if (intelligenceEnabled())
      this.timer = setInterval(() => {
        void this.tick();
      }, 500);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.job?.abort.abort();
    this.ahead?.abort.abort();
  }
  private base() {
    const value =
      this.runtime.current.agents.get('robot.device_adapter')?.runtimeConfig.config
        .controller_url;
    return typeof value === 'string'
      ? value.replace(/\/$/, '')
      : 'http://127.0.0.1:7861';
  }
  async live(): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.base()}/api/status`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('机械臂状态暂不可用。');
    const status = record(await response.json());
    const capabilities = record(semanticEvidence(status.capabilities));
    for (const key of ['objects', 'destinations'])
      if (Array.isArray(capabilities[key]))
        capabilities[key] = (capabilities[key] as unknown[]).map((row) => ({
          label: record(row).label,
        }));
    return {
      runtime_id: status.runtime_id,
      available: true,
      observed_at: now(),
      phase: status.phase,
      command_id: status.command_id,
      holding: semanticEvidence(status.holding),
      capabilities,
      observation: semanticEvidence(status.vision),
      visual_candidates: semanticEvidence(status.visual_candidates),
      vision_tools: [
        {
          name: 'fast',
          use: 'YOLOE 提示识别、SAM2 分割和光流跟踪',
          params: { vision_mode: 'fast' },
        },
        {
          name: 'sam3',
          use: '陌生概念/快环不确定时重新定位；可直接选择',
          params: { vision_mode: 'slow', slow_provider: 'sam3' },
        },
        {
          name: 'florence2',
          use: '场景描述/零样本候选；不强制作为 SAM3 的后续',
          params: { vision_mode: 'slow', slow_provider: 'florence2' },
        },
      ],
    };
  }
  async image(camera: string) {
    if (!['scene', 'side', 'wrist'].includes(camera)) throw new Error('Unknown camera');
    const response = await fetch(`${this.base()}/api/frame/${camera}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('当前相机尚未提供图像。');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      !response.headers.get('content-type')?.startsWith('image/jpeg') ||
      bytes.length > 20_000_000
    )
      throw new Error('相机图像格式不可用。');
    const captured = Number(response.headers.get('x-frame-time'));
    if (captured > 0 && Date.now() - captured * 1000 > 15000)
      throw new Error('相机画面已停止更新，请先恢复场景观察，再检查执行结果。');
    return {
      bytes,
      metadata: {
        camera,
        received_at: now(),
        frame_sequence: response.headers.get('x-frame-sequence'),
        observed_at: response.headers.get('x-frame-time'),
      },
    };
  }
  async snapshot() {
    return { enabled: intelligenceEnabled(), ...(await this.store.read()) };
  }
  private emit(
    emit: (e: QueuedEvent) => void,
    key: string,
    type: string,
    conversation: string,
    payload: unknown,
    taskId?: string,
  ) {
    const event: InProcessPublishInput = {
      event_type: type,
      correlation_id: conversation,
      idempotency_key: key,
      payload,
      ...(taskId ? { task_id: taskId, task_version: 1 } : {}),
    };
    emit({ key, event });
  }
  private reply(emit: (e: QueuedEvent) => void, goal: Goal, message: string) {
    this.emit(
      emit,
      `reply:${goal.id}:${randomUUID()}`,
      'intelligence.reply',
      goal.conversation_id,
      { text: message, goal_id: goal.id },
    );
  }
  async handle(context: InProcessEventContext) {
    if (!intelligenceEnabled()) return;
    const event = context.event;
    if (event.eventType === 'intent.created') {
      const input = record(event.payload).text;
      const text = typeof input === 'string' ? input.trim() : '';
      if (!text) return;
      if (/^(暂停|停止|停下|停|stop|pause)[。！!\s]*$/i.test(text)) {
        await this.control('pause');
        return;
      }
      if (/^(继续|恢复|继续执行|resume)[。！!\s]*$/i.test(text)) {
        await this.control('resume');
        return;
      }
      if (/^(取消|取消当前任务|cancel)[。！!\s]*$/i.test(text)) {
        await this.control('cancel');
        return;
      }
      if (/^(状态|进度|现在在做什么|做到哪了|还剩什么)[？?。\s]*$/.test(text)) {
        await this.store.change((state, emit) => {
          const active = activeGoal(state);
          this.emit(
            emit,
            `status:${event.eventId}`,
            'intelligence.reply',
            event.correlationId,
            {
              text: active
                ? `${active.summary || active.source}：${active.state}，已完成 ${active.steps.filter((s) => s.state === 'completed').length}/${active.steps.length} 步。${active.message}`
                : '当前没有正在执行的任务。',
            },
          );
        });
        return;
      }
      await this.store.change((state, emit) => {
        if (state.receipts.includes(event.eventId)) return;
        state.receipts.push(event.eventId);
        const goal: Goal = {
          id: `goal_${event.eventId}`,
          conversation_id: event.correlationId,
          input_event_id: event.eventId,
          source: text,
          interaction:
            /取消|暂停|停止|继续|恢复|修改|改成|改为|状态|进度|做到哪|还剩/.test(text),
          state: 'queued',
          mode: 'simple',
          summary: '',
          completion: '',
          steps: [],
          message: '',
          review_reason: '',
          recovery_count: 0,
          created_at: now(),
          updated_at: now(),
          model_calls: 0,
          revision: 1,
        };
        state.goals.push(goal);
        const waiting = state.goals.filter((g) => !ended(g)).length;
        this.reply(
          emit,
          goal,
          waiting > 1
            ? `已加入任务队列，前面还有 ${waiting - 1} 项任务。`
            : '正在结合当前场景规划任务。',
        );
      });
    } else if (event.eventType === 'perception.reported') {
      await this.store.change((state) => {
        const observation = record(semanticEvidence(event.payload));
        state.scene.observation = observation;
        state.scene.observed_at = now();
        state.scene.observations = [
          ...(state.scene.observations ?? []).filter(
            (o) => o.request_id !== observation.request_id,
          ),
          observation,
        ].slice(-32);
      });
    } else if (event.eventType === 'interrupt.requested') {
      if (record(event.payload).queue_control === true) return;
      await this.control('pause', undefined, false);
    } else if (
      event.eventType.startsWith('execution.') ||
      event.eventType === 'plan.rejected'
    ) {
      await this.store.change((state) => {
        if (state.receipts.includes(event.eventId)) return;
        state.receipts.push(event.eventId);
        applyResult(state, event.taskId ?? '', event.eventType, record(event.payload));
      });
    }
  }
  async control(
    action: string,
    id?: string,
    interrupt = true,
    instruction = '',
    requestorId?: string,
  ): Promise<QueueState> {
    this.ahead?.abort.abort();
    this.ahead = undefined;
    if (!['pause', 'resume', 'cancel', 'retry', 'up', 'amend'].includes(action))
      throw new Error('Unknown queue action');
    if (
      this.job?.id !== requestorId &&
      (action === 'pause' || (action === 'cancel' && (!id || this.job?.id === id)))
    )
      this.job?.abort.abort();
    await this.store.change((state, emit) => {
      const goal = id
        ? state.goals.find((g) => g.id === id)
        : ((['resume', 'retry'].includes(action)
            ? state.goals.find((g) => ['paused', 'blocked'].includes(g.state))
            : undefined) ?? activeGoal(state));
      if (id && !goal) throw new Error('任务不存在。');
      if (action === 'pause') {
        state.paused = true;
        if (goal && !ended(goal)) {
          goal.state = 'paused';
          goal.revision++;
        }
      } else if (action === 'cancel') {
        if (goal) {
          goal.state = 'cancelled';
          goal.revision++;
        }
      } else if (action === 'resume' || action === 'retry') {
        state.paused = false;
        if (goal && !ended(goal)) {
          goal.state = goal.steps.length ? 'review' : 'queued';
          goal.recovery_count = 0;
          goal.revision++;
          goal.review_reason = '用户恢复任务，先核对当前持物与已完成步骤。';
        }
        if (goal)
          for (const step of goal.steps)
            if (step.state === 'unknown') {
              if (step.result?.runtime_changed) {
                step.state = 'superseded';
                continue;
              }
              step.delivery_attempts = 0;
              step.last_dispatched_at = now();
            }
      } else if (action === 'amend') {
        if (!goal || !instruction.trim() || ended(goal))
          throw new Error('请提供待修改任务和新的任务要求。');
        goal.source = instruction;
        goal.summary = '';
        goal.completion = '';
        goal.recovery_count = 0;
        goal.revision++;
        goal.state = 'review';
        goal.review_reason = '用户修改了任务，保留已完成动作并重规划剩余步骤。';
      } else if (goal) {
        if (goal.state !== 'queued') throw new Error('只能调整尚未开始的任务顺序。');
        const index = state.goals.indexOf(goal);
        const before = state.goals
          .slice(0, index)
          .findLastIndex((g) => g.state === 'queued');
        if (before >= 0) {
          state.goals.splice(index, 1);
          state.goals.splice(before, 0, goal);
        }
      }
      if (goal) {
        goal.updated_at = now();
        this.reply(
          emit,
          goal,
          action === 'pause'
            ? '已暂停任务队列，保留当前持物与剩余步骤。'
            : action === 'cancel'
              ? '已取消该任务，其余任务保留。'
              : '任务队列已更新。',
        );
      }
      const ownsMotion = goal?.steps.some(inFlight);
      if (goal && ['pause', 'cancel'].includes(action)) {
        for (const step of goal.steps.filter(inFlight)) {
          step.cancel_requested = true;
          this.emit(
            emit,
            `cancel-delivery:${step.task_id}`,
            'task.cancelled',
            goal.conversation_id,
            { reason: action },
            step.task_id,
          );
        }
      }
      if (interrupt && (action === 'pause' || (action === 'cancel' && ownsMotion))) {
        this.emit(
          emit,
          `interrupt:${randomUUID()}`,
          'interrupt.requested',
          goal?.conversation_id ?? 'queue-control',
          { text: '暂停', queue_control: true },
        );
      }
    });
    return this.store.read();
  }
  private async flush() {
    for (const entry of await this.store.pending()) {
      await this.bus.publishFromAgent('robot.intelligence', {
        ...entry.event,
        source_agent_id: 'robot.intelligence',
      });
      await this.store.delivered(entry.key);
    }
  }
  private async tick() {
    if (this.ticking || !this.runtime.isReady()) return;
    this.ticking = true;
    try {
      if (!this.restored) {
        await this.store.change((state) => {
          for (const g of state.goals)
            if (g.state === 'planning') g.state = g.steps.length ? 'review' : 'queued';
        });
        this.restored = true;
      }
      await this.flush();
      const state = await this.store.read();
      // Controller reconciliation also runs while paused/cancelled, retaining measured holding state.
      const interaction = state.goals.find(
        (g) => g.interaction && g.state === 'queued',
      );
      if (interaction && !this.job) {
        this.startPlanning(interaction, state, 'planner');
        return;
      }
      const flight = state.goals.flatMap((g) => g.steps).find(inFlight);
      if (flight) {
        await this.reconcile(flight);
        await this.prepareAhead(await this.store.read(), flight);
        return;
      }
      if (state.paused || this.job) return;
      const goal = activeGoal(state);
      if (!goal) return;
      if (goal.state === 'queued' && (await this.useAhead(goal, state))) return;
      if (goal.state === 'queued' || goal.state === 'review') {
        this.startPlanning(
          goal,
          state,
          goal.state === 'queued' ? 'planner' : 'supervisor',
        );
        return;
      }
      if (goal.state !== 'running') return;
      const step = goal.steps.find((s) => s.state === 'pending');
      if (step) {
        const live = await this.live();
        if (
          live.command_id &&
          !['idle', 'completed', 'failed', 'cancelled', 'hold'].includes(
            String(live.phase),
          )
        )
          return;
        await this.store.change((current, emit) => {
          const g = current.goals.find((g) => g.id === goal.id);
          const s = g?.steps.find((s) => s.id === step.id);
          if (current.paused || !g || g.state !== 'running' || s?.state !== 'pending')
            return;
          s.state = 'dispatching';
          s.started_at = now();
          s.last_dispatched_at = now();
          s.delivery_attempts = 1;
          if (typeof live.runtime_id === 'string') s.runtime_id = live.runtime_id;
          current.scene.holding = record(live.holding);
          this.emit(
            emit,
            `dispatch:${s.command_id}`,
            'plan.proposed',
            g.conversation_id,
            executablePlan(g, s),
            s.task_id,
          );
        });
      } else
        await this.store.change((current, emit) => {
          const g = current.goals.find((g) => g.id === goal.id);
          if (!g || g.state !== 'running') return;
          if (g.mode === 'complex') {
            g.state = 'review';
            g.review_reason = '本阶段动作已结束，核对目标条件，继续展开或完成。';
          } else {
            g.state = 'completed';
            g.updated_at = now();
            g.message = completionReply(g);
            this.reply(emit, g, g.message);
          }
        });
      this.lastError = '';
    } catch (error) {
      const message = (error as Error).message;
      if (message !== this.lastError) this.logger.warn(message);
      this.lastError = message;
    } finally {
      this.ticking = false;
    }
  }
  private async reconcile(step: QueueStep) {
    const response = await fetch(
      `${this.base()}/api/commands/${encodeURIComponent(step.command_id)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (response.status === 404) {
      if (
        Date.now() - Date.parse(step.last_dispatched_at ?? step.started_at ?? now()) <
        15000
      )
        return;
      const live = await this.live();
      await this.store.change((state, emit) => {
        const goal = state.goals.find((g) => g.steps.some((s) => s.id === step.id));
        const current = goal?.steps.find((s) => s.id === step.id);
        if (!goal || !current || !inFlight(current)) return;
        if (ended(goal) || goal.state === 'paused' || current.cancel_requested) {
          current.state = 'cancelled';
          return;
        }
        if (
          current.runtime_id &&
          live.runtime_id &&
          current.runtime_id !== live.runtime_id
        ) {
          if (goal.state !== 'blocked') {
            current.state = 'unknown';
            current.result = {
              runtime_changed: true,
              message: '控制器已重启，旧命令的物理结果无法从新账本核对。',
            };
            goal.state = 'blocked';
            goal.message =
              '仿真已重启，旧命令结果未知。恢复任务后将根据新场景重新规划，不重发旧命令。';
            this.reply(emit, goal, goal.message);
          }
          return;
        }
        if ((current.delivery_attempts ?? 1) >= 3) {
          if (goal.state !== 'blocked') {
            current.state = 'unknown';
            goal.state = 'blocked';
            goal.message =
              '控制器没有返回这条命令的执行记录。已保留任务，可恢复后重新核对；不会创建新的抓取尝试。';
            this.reply(emit, goal, goal.message);
          }
          return;
        }
        // Re-deliver exactly the same controller command, never a newly generated grasp.
        current.delivery_attempts = (current.delivery_attempts ?? 1) + 1;
        current.last_dispatched_at = now();
        this.emit(
          emit,
          `redispatch:${current.command_id}:${current.delivery_attempts}`,
          'plan.proposed',
          goal.conversation_id,
          executablePlan(goal, current),
          current.task_id,
        );
      });
      return;
    }
    if (!response.ok) return;
    const result = record(await response.json());
    if (!['completed', 'failed', 'cancelled'].includes(String(result.state))) return;
    const eventType =
      result.state === 'completed' && result.ok === true
        ? 'execution.completed'
        : result.state === 'cancelled'
          ? 'execution.cancelled'
          : 'execution.failed';
    await this.store.change((state) => {
      applyResult(state, step.task_id, eventType, result);
    });
  }
  private async prepareAhead(state: QueueState, flight: QueueStep) {
    if (state.paused || this.job || this.ahead) return;
    const current = state.goals.find((g) => g.steps.some((s) => s.id === flight.id));
    const next = state.goals.find((g) => g.state === 'queued' && !g.interaction);
    if (!current || !next || !canPrepareAhead(current, flight, next)) return;
    const key = `${next.id}:${next.revision}`;
    if (this.aheadAttempted.has(key)) return;
    const settings = await this.models.settings();
    if (!settings.performance?.lookahead) return;
    this.aheadAttempted.add(key);
    if (this.aheadAttempted.size > 256)
      this.aheadAttempted.delete(this.aheadAttempted.values().next().value!);
    const preview = {
      goal: structuredClone(next),
      after: structuredClone(current),
      step: structuredClone(flight),
      abort: new AbortController(),
      finished: false,
      runtimeId: flight.runtime_id,
      decision: undefined as Decision | undefined,
    };
    this.ahead = preview;
    const recordAhead = async (data: Record<string, unknown>) => {
      await this.store.change((state, emit) => {
        const goal = state.goals.find((g) => g.id === next.id);
        if (!goal) return;
        if (data.kind === 'model') goal.model_calls++;
        if (typeof data.kind === 'string' && data.kind.startsWith('lookahead_'))
          goal.planning_ahead = data.kind.slice(10);
        this.emit(
          emit,
          `ahead:${randomUUID()}`,
          'intelligence.observed',
          goal.conversation_id,
          { goal_id: goal.id, planning_ahead: true, ...data },
        );
      });
    };
    void (async () => {
      const profiles = await this.models.profilesFor('planner');
      await recordAhead({
        kind: 'lookahead_started',
        during_command: flight.command_id,
      });
      const decision = await planGoal(
        profiles[0]!,
        'planner',
        next,
        state,
        {
          images: false,
          fallbackProfiles: [],
          toolRounds: 2,
          ahead: {
            active_action: flight,
            expected_after:
              '当前动作成功释放物体后再执行；只准备明确且与当前目标/目的地无依赖的新任务。',
          },
          readState: () => this.live(),
          readImage: () =>
            Promise.reject(
              new Error('提前规划需要新图片，改由任务开始时进行正式规划。'),
            ),
          record: recordAhead,
          validate: (decision) => {
            for (const action of decision.actions) {
              const errors = validatePlan(executablePlan(next, stepsFor([action])[0]!));
              if (errors.length) throw new Error(errors.join('；'));
            }
            return Promise.resolve();
          },
        },
        AbortSignal.any([
          preview.abort.signal,
          AbortSignal.timeout(settings.performance.planningBudgetMs),
        ]),
      );
      if (independentAhead(decision, flight)) preview.decision = decision;
      await recordAhead({
        kind: preview.decision ? 'lookahead_ready' : 'lookahead_discarded',
        reason: preview.decision
          ? 'independent_explicit_actions'
          : 'requires_fresh_reasoning',
      });
    })()
      .catch(async (error) => {
        if (!preview.abort.signal.aborted)
          await recordAhead({
            kind: 'lookahead_discarded',
            reason: (error as Error).message,
          });
      })
      .finally(() => {
        preview.finished = true;
      });
  }

  private async useAhead(goal: Goal, state: QueueState): Promise<boolean> {
    const preview = this.ahead;
    if (!preview || preview.goal.id !== goal.id) return false;
    const previous = state.goals.find((g) => g.id === preview.after.id);
    const step = previous?.steps.find((s) => s.id === preview.step.id);
    if (
      preview.abort.signal.aborted ||
      preview.goal.revision !== goal.revision ||
      previous?.state !== 'completed' ||
      previous.revision !== preview.after.revision ||
      step?.state !== 'completed'
    ) {
      preview.abort.abort();
      this.ahead = undefined;
      await this.store.change((state) => {
        const saved = state.goals.find((g) => g.id === goal.id);
        if (saved) saved.planning_ahead = 'discarded';
      });
      return false;
    }
    if (!preview.finished) return true;
    this.ahead = undefined;
    if (!preview.decision) return false;
    const live = await this.live();
    if (record(live.holding).verified || live.runtime_id !== preview.runtimeId)
      return false;
    await this.acceptDecision(
      goal,
      'planner',
      preview.decision,
      record(live.capabilities),
    );
    await this.store.change((state, emit) => {
      const saved = state.goals.find((g) => g.id === goal.id);
      if (saved) saved.planning_ahead = 'used';
      this.emit(
        emit,
        `ahead-used:${randomUUID()}`,
        'intelligence.observed',
        goal.conversation_id,
        {
          goal_id: goal.id,
          kind: 'lookahead_used',
          verified_after_command: step.command_id,
        },
      );
    });
    return true;
  }

  private startPlanning(goal: Goal, state: QueueState, role: Role) {
    const abort = new AbortController();
    this.job = { id: goal.id, abort };
    void this.runPlanning(goal, state, role, abort.signal)
      .catch(async (error) => {
        if (abort.signal.aborted) return;
        await this.store.change((current, emit) => {
          const g = current.goals.find((g) => g.id === goal.id);
          if (!g || ended(g) || g.state === 'paused') return;
          g.state = 'blocked';
          g.message = (error as Error).message;
          g.updated_at = now();
          this.reply(emit, g, `${g.message} 任务和已完成步骤已保留。`);
        });
      })
      .finally(() => {
        if (this.job?.id === goal.id) this.job = undefined;
      });
  }
  private async runPlanning(
    goal: Goal,
    state: QueueState,
    role: Role,
    signal: AbortSignal,
  ) {
    const settings = await this.models.settings();
    if (
      role === 'supervisor' &&
      goal.steps.some((s) => s.state === 'failed') &&
      goal.recovery_count >= settings.recoveryBudget
    )
      throw new Error('连续恢复未取得进展，需要调整策略或提供补充信息。');
    await this.store.change((current) => {
      const g = current.goals.find((g) => g.id === goal.id);
      if (
        g &&
        g.revision === goal.revision &&
        (!current.paused || g.interaction) &&
        !ended(g)
      )
        g.state = 'planning';
    });
    signal.throwIfAborted();
    const profiles = this.models.profilesFor
      ? await this.models.profilesFor(role)
      : [await this.models.profile(role)];
    const profile = profiles[0]!;
    signal = AbortSignal.any([
      signal,
      AbortSignal.timeout(settings.performance?.planningBudgetMs ?? 60000),
    ]);
    const decision = await planGoal(
      profile,
      role,
      goal,
      state,
      {
        images: settings.images,
        fallbackProfiles: profiles.slice(1),
        toolRounds: settings.performance?.toolRounds ?? 6,
        manageQueue: async (action, id, instruction) => {
          if (id === goal.id)
            throw new Error(
              '请选择队列中需要修改的已有任务，不要修改本条管理请求自身。',
            );
          const updated = await this.control(action, id, true, instruction, goal.id);
          return {
            goals: updated.goals.map((g) => ({
              id: g.id,
              source: g.source,
              state: g.state,
            })),
          };
        },
        validate: async (decision) => {
          if (
            decision.outcome === 'continue' &&
            !decision.actions.length &&
            !(role === 'planner' && decision.mode === 'complex') &&
            !goal.steps.some((s) => s.state === 'pending')
          )
            throw new Error(
              '当前没有待执行步骤，请提交具体actions，或核对整体目标后返回complete。',
            );
          if (
            decision.outcome === 'complete' &&
            !goal.steps.some((s) => s.state === 'completed')
          )
            throw new Error(
              '目前只有规划方案，还没有执行过任何步骤。请提交 continue 和具体 actions 让机器人实际执行，不能直接宣称完成。',
            );
          if (decision.outcome === 'chat' && role === 'supervisor')
            throw new Error(
              '监督节点需要核对任务完成条件并提交 complete，或继续安排执行，不能用闲聊结束物理任务。',
            );
          if (
            decision.outcome === 'complete' &&
            (role !== 'supervisor' ||
              goal.steps.some(
                (s) => inFlight(s) || ['pending', 'failed'].includes(s.state),
              ))
          )
            throw new Error(
              '仍有待处理或失败步骤，请先恢复或调整剩余计划，再根据新的执行证据核对目标。',
            );
          const live = await this.live();
          const skills = record(live.capabilities).skills;
          for (const action of decision.actions) {
            if (!Array.isArray(skills) || !skills.includes(action.skill))
              throw new Error(
                `当前没有 ${action.skill} 技能，请换成真实能力目录中的技能组合。`,
              );
            const step = stepsFor([action])[0]!;
            const errors = validatePlan(executablePlan(goal, step));
            if (errors.length) throw new Error(errors.join('；'));
          }
        },
        readState: async () => {
          const live = await this.live();
          await this.store.change((state) => {
            if (
              typeof live.runtime_id === 'string' &&
              state.scene.runtime_id !== live.runtime_id
            )
              state.scene = { runtime_id: live.runtime_id, observations: [] };
            state.scene.available = true;
            state.scene.holding = record(live.holding);
            state.scene.observation = record(live.observation);
          });
          return {
            ...live,
            recent_observations: (await this.store.read()).scene.observations ?? [],
          };
        },
        readImage: (camera) => this.image(camera),
        record: async (data) => {
          await this.store.change((current, emit) => {
            const g = current.goals.find((g) => g.id === goal.id);
            if (!g) return;
            if (data.kind === 'model') g.model_calls++;
            this.emit(
              emit,
              `model:${randomUUID()}`,
              'intelligence.observed',
              g.conversation_id,
              { goal_id: g.id, loop: data.kind === 'model' ? 'slow' : 'fast', ...data },
            );
          });
        },
      },
      signal,
    );
    signal.throwIfAborted();
    const live = await this.live();
    await this.store.change((_, emit) =>
      this.emit(
        emit,
        `decision:${randomUUID()}`,
        'intelligence.observed',
        goal.conversation_id,
        { kind: 'decision', role, goal_id: goal.id, ...decision },
      ),
    );
    await this.acceptDecision(goal, role, decision, record(live.capabilities));
  }
  private async acceptDecision(
    previous: Goal,
    role: Role,
    decision: Decision,
    capabilities: Record<string, unknown>,
  ) {
    const skills = Array.isArray(capabilities.skills) ? capabilities.skills : [];
    for (const action of decision.actions)
      if (!skills.includes(action.skill))
        throw new Error(`当前控制器没有提供 ${action.skill}，需要重新规划可用技能。`);
    await this.store.change((state, emit) => {
      const goal = state.goals.find((g) => g.id === previous.id);
      if (
        !goal ||
        goal.revision !== previous.revision ||
        (state.paused && !goal.interaction) ||
        ended(goal) ||
        goal.state === 'paused'
      )
        return;
      goal.updated_at = now();
      if (role === 'planner' || !goal.summary)
        goal.summary = decision.summary || goal.summary;
      if (role === 'planner' || !goal.completion)
        goal.completion = decision.completion || goal.completion;
      goal.message = decision.message;
      if (decision.outcome === 'chat') {
        if (role === 'supervisor') throw new Error('监督节点不能用闲聊结束执行任务。');
        goal.state = 'completed';
        this.reply(emit, goal, decision.message || decision.summary);
        return;
      }
      if (decision.outcome === 'blocked' || decision.outcome === 'clarify') {
        goal.state = 'blocked';
        this.reply(emit, goal, decision.message || '需要补充任务信息。');
        return;
      }
      if (decision.outcome === 'complete') {
        if (
          role !== 'supervisor' ||
          !goal.steps.some((s) => s.state === 'completed') ||
          goal.steps.some((s) => inFlight(s) || ['pending', 'failed'].includes(s.state))
        )
          throw new Error('任务仍有未完成或失败步骤，不能宣布完成。');
        goal.state = 'completed';
        this.reply(emit, goal, decision.message || '任务完成条件已核对。');
        return;
      }
      goal.interaction = false;
      if (role === 'planner' && decision.mode === 'complex') {
        goal.proposal = decision.actions;
        goal.mode = 'complex';
        goal.state = 'review';
        goal.review_reason = '根据规划方案生成可执行队列。';
        this.reply(emit, goal, `执行方案：${goal.summary}`);
        return;
      }
      if (!decision.actions.length) {
        if (role === 'supervisor' && goal.steps.some((s) => s.state === 'pending')) {
          if (goal.steps.some((s) => s.state === 'failed')) goal.recovery_count++;
          for (const step of goal.steps)
            if (['failed', 'cancelled'].includes(step.state)) step.state = 'superseded';
          goal.state = 'running';
          goal.message = decision.message || '继续执行已规划的剩余步骤。';
          this.reply(emit, goal, goal.message);
          return;
        }
        throw new Error('规划尚未给出下一步动作，任务保留等待补充。');
      }
      if (role === 'supervisor' && goal.steps.some((s) => s.state === 'failed'))
        goal.recovery_count++;
      for (const step of goal.steps)
        if (['pending', 'failed', 'cancelled'].includes(step.state))
          step.state = 'superseded';
      goal.steps.push(...stepsFor(decision.actions));
      goal.state = 'running';
      goal.message = `接下来：${decision.actions.map((a) => a.title).join('；')}。`;
      this.reply(emit, goal, goal.message);
    });
  }
}
