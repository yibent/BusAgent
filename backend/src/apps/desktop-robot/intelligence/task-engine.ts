import {
  policyParams,
  retryByPolicy,
  physicalVerdict,
  supervisionUnavailableVerdict,
} from './execution-policy.js';
import { canPrepareAhead, independentAhead } from './lookahead.js';
import {
  executionGoals,
  immediateAction,
  isAcknowledgement,
  isSceneQuestion,
  statusReply,
  hasMeaningfulInput,
  waitingMessage,
} from './interaction-routing.js';
import { recoveryObservation, resolveRecovery } from './local-recovery.js';
import {
  compactContext,
  ContextMemory,
} from '../../../modules/conversation/context-memory.js';
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
import { localSceneReply, planGoal } from './planning.js';
import {
  continueStagedPlanning,
  reviewStagedPlanning,
  runStagedPlanning,
} from './staged-planning.js';
import { ContextCompression } from '../../../modules/conversation/context-compression.js';
import { observeScene, readObservation } from './observation-tools.js';
import { groundPrimitive, needsPrimitiveGrounding } from './primitive-grounding.js';
import { observeOperation } from './operation-telemetry.js';
import {
  applyStageVerificationFailure,
  skipRepeatedIndependentFailure,
} from './stage-policy.js';
import { selectImageObject } from './visual-grounding.js';
import { trackBackground } from '../../../observability/execution-span.js';
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
interface ReplyTo {
  conversation: string;
  instruction: string;
  text: string;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const activeGoal = (state: QueueState) =>
  executionGoals(state).find(
    (g) => !ended(g) && !['blocked', 'paused'].includes(g.state),
  );
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
  const params = policyParams(step);
  if (step.execution) params.execution_policy = step.execution;
  if (step.skill === 'grasp' && !params.orientation) {
    const index = goal.steps.findIndex((item) => item.id === step.id);
    const nextManipulation =
      index < 0
        ? undefined
        : goal.steps
            .slice(index + 1)
            .find(
              (item) =>
                item.state === 'pending' &&
                ['grasp', 'pick_place', 'place_held'].includes(item.skill),
            );
    // Choose the grasp for the intended placement, including when the planner
    // expresses the same transfer as two separate queue steps.
    if (nextManipulation?.skill === 'place_held' && nextManipulation.params.orientation)
      params.orientation = structuredClone(nextManipulation.params.orientation);
  }
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
    steps: [{ id: 1, skill: step.skill, params, why: step.title }],
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
  if (result.world) state.scene.world = record(semanticEvidence(result.world));
  if (result.vision) {
    state.scene.observation = record(semanticEvidence(result.vision));
    state.scene.observed_at = now();
  }
  step.finished_at = now();
  goal.updated_at = now();
  if (ended(goal) || goal.state === 'paused') return goal;
  if (resolveRecovery(goal, step, state, (action) => stepsFor([action])[0]!))
    return goal;
  if (terminal === 'completed') {
    if (step.execution?.supervision && step.execution.supervision.kind !== 'none') {
      goal.checks ??= [];
      if (!goal.checks.some((c) => c.command_id === step.command_id))
        goal.checks.push({
          id: `check:${step.command_id}`,
          step_id: step.id,
          command_id: step.command_id,
          revision: goal.revision,
          state: 'pending',
        });
    }
    if (['grasp', 'pick_place', 'place_held'].includes(step.skill))
      goal.recovery_count = 0;
    goal.state = step.review_after || result.review_required ? 'review' : 'running';
    if (result.review_required) goal.review_kind = 'verification';
    else if (step.review_after) goal.review_kind = 'continuation';
    else delete goal.review_kind;
    goal.review_reason = result.review_required
      ? typeof result.review_reason === 'string'
        ? result.review_reason
        : '动作后证据不确定，需要检查已完成动作。'
      : step.review_after
        ? `步骤“${step.title}”已完成，需要根据观察决定后续。`
        : '';
  } else {
    goal.state = 'review';
    goal.review_kind = 'failure';
    goal.review_reason = `步骤“${step.title}”结果 ${terminal}；保留后续任务，根据当前持物和观测决定恢复。`;
  }
  if (goal.checks?.some((c) => ['failed', 'uncertain'].includes(c.state))) {
    goal.state = 'review';
    goal.review_kind = 'continuation';
    goal.review_reason = '局部监督有待处理的结论，请检查checks。';
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
  private intakeJobs = new Map<string, AbortController>();
  private verificationJobs = new Map<string, AbortController>();
  private preparationJobs = new Map<string, AbortController>();
  private inferenceJobs = new Set<string>();
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
    private readonly memory?: ContextMemory,
    private readonly compression?: ContextCompression,
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
    for (const abort of this.intakeJobs.values()) abort.abort();
    for (const abort of this.preparationJobs.values()) abort.abort();
    for (const abort of this.verificationJobs.values()) abort.abort();
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
    const world = record(status.world);
    const hasWorld = Array.isArray(world.collections) && world.collections.length > 0;
    const observation = record(status.vision);
    return {
      runtime_id: status.runtime_id,
      available: true,
      observed_at: now(),
      phase: status.phase,
      command_id: status.command_id,
      holding: semanticEvidence(status.holding),
      capabilities,
      observation: semanticEvidence(
        hasWorld && observation.collection
          ? {
              request_id: observation.request_id,
              scope: observation.scope,
              label: observation.label,
              observed_at: observation.observed_at,
              ok: observation.ok,
            }
          : observation,
      ),
      visual_candidates: hasWorld ? [] : semanticEvidence(status.visual_candidates),
      world: semanticEvidence(status.world),
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
  async image(camera: string, observationRef?: string) {
    if (!['scene', 'side', 'wrist'].includes(camera)) throw new Error('Unknown camera');
    if (observationRef && !/^[a-f0-9]{32}$/.test(observationRef))
      throw new Error('Invalid observation reference');
    const snapshotResponse = observationRef
      ? await fetch(`${this.base()}/api/observations/${observationRef}`, {
          signal: AbortSignal.timeout(3000),
        })
      : await fetch(`${this.base()}/api/snapshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ camera }),
          signal: AbortSignal.timeout(6000),
        });
    if (!snapshotResponse.ok) throw new Error('当前相机无法捕获同步RGB-D图像');
    const snapshot = (await snapshotResponse.json()) as Record<string, unknown>;
    if (observationRef) snapshot.snapshot_ref = observationRef;
    const response = await fetch(
      `${this.base()}/api/observations/${String(snapshot.snapshot_ref)}/frame/${camera}`,
      {
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!response.ok) throw new Error('当前相机尚未提供图像。');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      !response.headers.get('content-type')?.startsWith('image/jpeg') ||
      bytes.length > 20_000_000
    )
      throw new Error('相机图像格式不可用。');
    const captured = Number(snapshot.observed_at);
    if (!observationRef && captured > 0 && Date.now() - captured * 1000 > 15000)
      throw new Error('相机画面已停止更新，请先恢复场景观察，再检查执行结果。');
    return {
      bytes,
      metadata: {
        camera,
        received_at: now(),
        snapshot_ref: snapshot.snapshot_ref,
        frame_sequence:
          snapshot.frame_sequence ??
          (Array.isArray(snapshot.views)
            ? snapshot.views.map(record).find((v) => v.camera === `${camera}_camera`)
                ?.sequence
            : undefined),
        observed_at: snapshot.observed_at,
      },
    };
  }
  async snapshot() {
    const state = await this.store.read();
    return { enabled: intelligenceEnabled(), ...state, goals: executionGoals(state) };
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
  private reply(
    emit: (e: QueuedEvent) => void,
    goal: Goal,
    message: string,
    verbatim = !goal.interaction,
  ) {
    this.emit(
      emit,
      `reply:${goal.id}:${randomUUID()}`,
      'intelligence.reply',
      goal.conversation_id,
      {
        text: message,
        goal_id: goal.id,
        instruction_id: goal.input_event_id,
        user_text: goal.source,
        goal_state: goal.state,
        interaction: goal.interaction === true,
        verbatim,
      },
    );
  }
  async handle(context: InProcessEventContext) {
    if (!intelligenceEnabled()) return;
    const event = context.event;
    if (event.eventType === 'intelligence.decision.proposed') {
      const payload = record(event.payload);
      const state = await this.store.read();
      const goal = state.goals.find((g) => g.id === payload.goal_id);
      if (
        !goal ||
        !goal.inference_request ||
        goal.inference_request.id !== payload.request_id ||
        goal.revision !== payload.revision
      )
        return;
      const role = goal.inference_request.role;
      if (
        event.sourceAgentId !==
        (role === 'planner' ? 'robot.planning' : 'robot.supervision')
      )
        return;
      try {
        await this.acceptDecision(
          goal,
          role,
          payload.decision as Decision,
          record(payload.capabilities),
        );
      } catch (error) {
        // The response is delivered asynchronously: the inference worker can
        // already have returned. Do not leave a rejected proposal in planning.
        await this.failInference(goal, error as Error);
      } finally {
        this.finishInference(goal.id);
      }
    } else if (event.eventType === 'intent.created') {
      const input = record(event.payload).text;
      const text = typeof input === 'string' ? input.trim() : '';
      if (!hasMeaningfulInput(text)) return;
      const replyTo = {
        conversation: event.correlationId,
        instruction: event.eventId,
        text,
      };
      if (isAcknowledgement(text)) {
        await this.store.change((state, emit) => {
          const active = state.goals.findLast(
            (goal) =>
              goal.conversation_id === event.correlationId &&
              !ended(goal) &&
              ['queued', 'planning', 'running', 'review', 'paused'].includes(
                goal.state,
              ),
          );
          this.emit(
            emit,
            `ack:${event.eventId}`,
            'intelligence.reply',
            event.correlationId,
            {
              text: active
                ? active.state === 'running'
                  ? `正在执行“${active.summary || active.source}”。`
                  : `“${active.summary || active.source}”正在处理中。`
                : '我在。',
              instruction_id: event.eventId,
              user_text: text,
              interaction: true,
              verbatim: true,
            },
          );
        });
        return;
      }
      if (/^(暂停|停止|停下|停|stop|pause)[。！!\s]*$/i.test(text)) {
        await this.control('pause', undefined, true, '', undefined, replyTo);
        return;
      }
      if (/^(继续|恢复|继续执行|resume)[。！!\s]*$/i.test(text)) {
        await this.control('resume', undefined, true, '', undefined, replyTo);
        return;
      }
      if (/^(取消|取消当前任务|cancel)[。！!\s]*$/i.test(text)) {
        await this.control('cancel', undefined, true, '', undefined, replyTo);
        return;
      }
      const status = statusReply(await this.store.read(), text, event.correlationId);
      if (status) {
        await this.store.change((state, emit) => {
          const current = statusReply(state, text, event.correlationId)!;
          this.emit(
            emit,
            `status:${event.eventId}`,
            'intelligence.reply',
            event.correlationId,
            {
              text: current.text,
              instruction_id: event.eventId,
              user_text: text,
              verbatim: true,
              queue_paused: state.paused,
              target_goal_id: current.goal?.id,
              target_goal_state: current.goal?.state,
            },
          );
        });
        return;
      }
      let created: Goal | undefined;
      await this.store.change((state) => {
        const utterance = record(event.payload).utterance_id;
        const receipt =
          typeof utterance === 'string'
            ? `utterance:${event.correlationId}:${utterance}`
            : event.eventId;
        if (state.receipts.includes(receipt)) return;
        state.receipts.push(receipt);
        if (state.receipts.length > 2000)
          state.receipts.splice(0, state.receipts.length - 2000);
        if (state.goals.length > 128) {
          const removable = state.goals
            .map((goal, index) => ({ goal, index }))
            .filter(({ goal }) => ended(goal))
            .slice(0, state.goals.length - 128)
            .map(({ index }) => index);
          for (const index of removable.reverse()) state.goals.splice(index, 1);
        }
        const goal: Goal = {
          id: `goal_${event.eventId}`,
          conversation_id: event.correlationId,
          input_event_id: event.eventId,
          source: text,
          // All fresh requests can be interpreted while the arm is busy.
          // The model decides chat/query/action; only accepted actions join motion dispatch.
          interaction: true,
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
        created = structuredClone(goal);
      });
      if (
        created &&
        (await this.models.settings()).architecture?.mode === 'staged' &&
        !this.intakeJobs.has(created.id)
      )
        this.startPlanning(created, 'planner', true);
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
        if (state.receipts.length > 2000)
          state.receipts.splice(0, state.receipts.length - 2000);
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
    replyTo?: ReplyTo,
  ): Promise<QueueState> {
    if (['pause', 'cancel', 'amend'].includes(action))
      for (const [goalId, abort] of this.preparationJobs)
        if (!id || id === goalId) abort.abort();
    if (id && id !== requestorId && ['pause', 'cancel', 'amend'].includes(action))
      this.intakeJobs.get(id)?.abort();
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
        : action === 'resume'
          ? (state.goals.find((g) => g.id === state.paused_goal_id && !ended(g)) ??
            activeGoal(state))
          : action === 'retry'
            ? state.goals.findLast((g) => ['paused', 'blocked'].includes(g.state))
            : activeGoal(state);
      if (id && !goal) throw new Error('任务不存在。');
      if (action === 'pause') {
        state.paused = true;
        if (goal && !ended(goal)) {
          state.paused_goal_id = goal.id;
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
        delete state.paused_goal_id;
        if (goal && !ended(goal)) {
          goal.state = goal.steps.some((s) => s.state !== 'pending')
            ? 'review'
            : 'queued';
          goal.recovery_count = 0;
          goal.revision++;
          goal.review_reason = '用户恢复任务，先核对当前持物与已完成步骤。';
          goal.review_kind = goal.steps.some((s) =>
            ['failed', 'unknown'].includes(s.state),
          )
            ? 'failure'
            : 'continuation';
          delete goal.inference_request;
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
        goal.review_kind = 'continuation';
        delete goal.inference_request;
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
          replyTo
            ? {
                ...goal,
                conversation_id: replyTo.conversation,
                input_event_id: replyTo.instruction,
                source: replyTo.text,
              }
            : goal,
          action === 'pause'
            ? '已暂停任务队列，保留当前持物与剩余步骤。'
            : action === 'cancel'
              ? '已取消该任务，其余任务保留。'
              : '任务队列已更新。',
        );
      } else if (replyTo) {
        this.emit(
          emit,
          `control-reply:${replyTo.instruction}`,
          'intelligence.reply',
          replyTo.conversation,
          {
            instruction_id: replyTo.instruction,
            user_text: replyTo.text,
            text:
              action === 'pause'
                ? '任务队列已暂停，当前没有活动任务。'
                : action === 'resume'
                  ? '任务队列已恢复，当前没有待执行任务。'
                  : '当前没有可取消的活动任务。',
          },
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
            if (g.state === 'planning') {
              g.state = g.steps.length ? 'review' : 'queued';
              g.revision++;
              delete g.inference_request;
              g.review_kind ??= g.steps.some((s) =>
                ['failed', 'unknown'].includes(s.state),
              )
                ? 'failure'
                : 'continuation';
            }
        });
        this.restored = true;
      }
      await this.flush();
      const state = await this.store.read();
      this.scheduleVerification(state);
      // Controller reconciliation also runs while paused/cancelled, retaining measured holding state.
      for (const interaction of state.goals.filter(
        (g) => g.interaction && g.state === 'queued',
      )) {
        if (this.intakeJobs.size >= 2) break;
        if (!this.intakeJobs.has(interaction.id))
          this.startPlanning(interaction, 'planner', true);
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
      if (goal.interaction || this.intakeJobs.has(goal.id)) return;
      if (goal.state === 'queued' && goal.steps.some((s) => s.state === 'pending')) {
        await this.store.change((current) => {
          const ready = current.goals.find((g) => g.id === goal.id);
          if (ready?.state === 'queued' && !current.paused) ready.state = 'running';
        });
        goal.state = 'running';
      }
      if (goal.state === 'queued' && (await this.useAhead(goal, state))) return;
      if (goal.state === 'queued' || goal.state === 'review') {
        const intelligenceSettings = await this.models.settings();
        const inferenceRole: Role =
          goal.architecture === 'staged'
            ? ['final', 'verification'].includes(goal.review_kind ?? '')
              ? 'supervisor'
              : 'planner'
            : goal.state === 'queued' ||
                goal.review_kind === 'continuation' ||
                goal.steps.some((step) => step.execution)
              ? 'planner'
              : 'supervisor';
        if (goal.state === 'review' && goal.review_kind === 'failure') {
          let retried = false;
          await this.store.change((current) => {
            const g = current.goals.find((item) => item.id === goal.id);
            if (g?.state === 'review' && g.revision === goal.revision)
              retried = retryByPolicy(g, current, (old) => stepsFor([old])[0]!);
          });
          if (retried) return;
        }
        if (
          goal.state === 'review' &&
          (goal.architecture === 'staged' ||
            !goal.steps.findLast((s) => s.state === 'failed')?.execution) &&
          (await this.recoverLocally(goal, state))
        )
          return;
        if (goal.state === 'review') {
          let skipped = false;
          await this.store.change((current) => {
            const pending = current.goals.find((item) => item.id === goal.id);
            if (pending)
              skipped = skipRepeatedIndependentFailure(
                pending,
                intelligenceSettings.architecture?.stageRetryLimit ?? 2,
              );
          });
          if (skipped) return;
        }
        if (
          goal.state === 'review' &&
          inferenceRole === 'supervisor' &&
          intelligenceSettings.supervisorEnabled === false
        ) {
          const message =
            '自动监督 LLM 已关闭，等待人工核验或调整后续步骤；执行反馈已保留。';
          if (goal.message !== message)
            await this.store.change((current) => {
              const waiting = current.goals.find((g) => g.id === goal.id);
              if (waiting?.state === 'review') waiting.message = message;
            });
          return;
        }
        this.startPlanning(goal, inferenceRole);
        return;
      }
      if (goal.state !== 'running') return;
      const step = goal.steps.find((s) => s.state === 'pending');
      if (step) {
        if (
          goal.checks?.some(
            (c) =>
              ['pending', 'running'].includes(c.state) &&
              goal.steps.find((s) => s.id === c.step_id)?.execution?.supervision?.wait,
          )
        )
          return;
        const live = await this.live();
        if (
          live.command_id &&
          !['idle', 'completed', 'failed', 'cancelled', 'hold'].includes(
            String(live.phase),
          )
        )
          return;
        if (needsPrimitiveGrounding(step)) {
          if (!this.preparationJobs.has(goal.id)) {
            const abort = new AbortController();
            this.preparationJobs.set(goal.id, abort);
            void trackBackground(() => this.preparePrimitive(goal, step, abort.signal))
              .catch((error) => this.logger.warn(String(error)))
              .finally(() => this.preparationJobs.delete(goal.id));
          }
          return;
        }
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
          if (g.checks?.some((c) => ['pending', 'running'].includes(c.state))) return;
          if (g.checks?.some((c) => ['failed', 'uncertain'].includes(c.state))) {
            g.state = 'review';
            g.review_kind = 'continuation';
            g.review_reason = '异步监督返回失败或不确定，请根据checks修正剩余任务。';
            return;
          }
          if (
            g.final_review ||
            (g.plan_scope ?? (g.mode === 'complex' ? 'stage' : 'complete')) === 'stage'
          ) {
            g.state = 'review';
            g.review_kind = g.final_review ? 'final' : 'continuation';
            g.review_reason =
              '执行批次已结束，异步检查已收齐。请对照原始目标做最终检查或追加下一批，不重复完成的动作。';
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
  /** One durable local inspection at a time; physical dispatch does not await inference. */
  private scheduleVerification(state: QueueState) {
    if (this.verificationJobs.size) return;
    for (const goal of state.goals) {
      if (ended(goal) || goal.state === 'paused') continue;
      const job = goal.checks?.find(
        (c) => c.state === 'pending' || c.state === 'running',
      );
      if (!job) continue;
      const step = goal.steps.find((s) => s.id === job.step_id);
      if (!step?.execution?.supervision) continue;
      const abort = new AbortController();
      this.verificationJobs.set(job.id, abort);
      void trackBackground(async () => {
        await this.store.change((current, emit) => {
          const g = current.goals.find((g) => g.id === goal.id);
          const c = g?.checks?.find((c) => c.id === job.id);
          if (c) {
            c.state = 'running';
            c.started_at = now();
          }
          this.emit(
            emit,
            `${job.id}:started`,
            'intelligence.observed',
            goal.conversation_id,
            {
              kind: 'operation_started',
              operation: 'placement_verification',
              domain: 'vision',
              operation_id: job.id,
              started_at_ms: Date.now(),
              goal_id: goal.id,
              check_id: job.id,
              loop: 'fast',
            },
          );
        });
        const policy = step.execution!.supervision!;
        let verdict = physicalVerdict(record(step.result), step.skill);
        let evidence: Record<string, unknown> = { physical_verdict: verdict };
        try {
          if (policy.kind === 'florence') {
            if ((!policy.box_2d && !policy.region_label) || !policy.target_label)
              throw new Error(
                'Florence局部监督需要target_label，以及box_2d或region_label',
              );
            const output = record(record(step.result).result ?? step.result);
            const frozen = record(output.post_action_snapshot).observation_ref;
            if (typeof frozen !== 'string')
              throw new Error(
                '动作未提供冻结的执行后图像，不能用后来场景冒充该动作结果',
              );
            const frame = await this.image(policy.camera ?? 'scene', frozen);
            const response = await fetch(
              `${process.env.BUSAGENT_VISION_URL ?? 'http://127.0.0.1:5570'}/verify`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  snapshot_ref: frame.metadata.snapshot_ref,
                  camera: policy.camera ?? 'scene',
                  box_2d: policy.box_2d,
                  target_label: policy.target_label,
                  region_label: policy.region_label,
                  predicate: policy.predicate ?? 'present',
                }),
                signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
              },
            );
            if (!response.ok) throw new Error(`局部监督服务HTTP ${response.status}`);
            evidence = {
              ...evidence,
              frame: frame.metadata,
              visual: await response.json(),
            };
            const visual = record(evidence.visual);
            if (visual.verdict !== 'passed' || verdict !== 'passed')
              verdict =
                visual.verdict === 'failed' || verdict === 'failed'
                  ? 'failed'
                  : 'uncertain';
          }
        } catch (error) {
          evidence.error = (error as Error).message;
          evidence.visual_unavailable = true;
          verdict = supervisionUnavailableVerdict(verdict);
        }
        const stageRetryLimit =
          (await this.models.settings()).architecture?.stageRetryLimit ?? 2;
        await this.store.change((current, emit) => {
          const g = current.goals.find((g) => g.id === goal.id);
          const c = g?.checks?.find((c) => c.id === job.id);
          if (!g || !c) return;
          if (g.revision !== job.revision || ended(g)) {
            c.state = 'superseded';
            return;
          }
          c.state = verdict;
          c.result = evidence;
          c.finished_at = now();
          if (verdict === 'passed' && step.stage)
            for (const prior of g.checks ?? []) {
              if (prior.id === c.id || !['failed', 'uncertain'].includes(prior.state))
                continue;
              const priorStep = g.steps.find(
                (candidate) => candidate.id === prior.step_id,
              );
              if (priorStep?.stage?.id === step.stage.id) prior.state = 'superseded';
            }
          if (verdict !== 'passed' && g.state !== 'paused') {
            applyStageVerificationFailure(
              g,
              step,
              verdict,
              stageRetryLimit,
              (action) => stepsFor([action])[0]!,
            );
          }
          this.emit(
            emit,
            `${job.id}:finished`,
            'intelligence.observed',
            goal.conversation_id,
            {
              kind: 'operation_completed',
              operation: 'placement_verification',
              domain: 'vision',
              operation_id: job.id,
              finished_at_ms: Date.now(),
              goal_id: goal.id,
              check_id: job.id,
              verdict,
              evidence,
            },
          );
        });
      })
        .catch((error) => this.logger.warn(String(error)))
        .finally(() => this.verificationJobs.delete(job.id));
      return;
    }
  }

  private async preparePrimitive(
    goal: Goal,
    step: QueueStep,
    signal: AbortSignal,
  ): Promise<boolean> {
    const settings = await this.models.settings();
    const recordEvent = async (data: Record<string, unknown>) => {
      await this.store.change((state, emit) => {
        const current = state.goals.find((g) => g.id === goal.id);
        if (current && ['model', 'provider_failure'].includes(String(data.kind)))
          current.model_calls++;
        this.emit(
          emit,
          `grounding:${randomUUID()}`,
          'intelligence.observed',
          goal.conversation_id,
          { goal_id: goal.id, step_id: step.id, ...data },
        );
      });
    };
    try {
      const observe = (params: Record<string, unknown>) =>
        observeOperation(
          recordEvent,
          typeof params.inspect === 'string' ? params.inspect : 'perception',
          () =>
            observeScene(
              this.base(),
              params,
              goal.conversation_id,
              AbortSignal.any([
                signal,
                AbortSignal.timeout(settings.nodeTimeouts?.perception ?? 15000),
              ]),
            ),
        );
      const remembered = record((await this.live()).world).objects;
      const action = await groundPrimitive(
        step,
        observe,
        (label, field) =>
          observeOperation(recordEvent, 'visual_fallback', async () => {
            if (!settings.images)
              throw new Error(`当前视觉未找到 ${label}，图像语义回退已关闭。`);
            const profiles = this.models.profilesFor
              ? await this.models.profilesFor('visual')
              : [await this.models.profile('planner')];
            signal.throwIfAborted();
            const frame = await this.image('scene');
            const selection = await selectImageObject(
              profiles,
              frame.bytes,
              `当前用户要求：${goal.source}。只框出${field === 'target' ? '一个待抓取物体' : '一个用于放置的容器本身'}，视觉类别提示是 ${label}；不要执行任务。`,
              signal,
              recordEvent,
            );
            return observe({
              category: label,
              selection: 'one',
              grounding: {
                snapshot_ref: frame.metadata.snapshot_ref,
                camera: 'scene_camera',
                box_normalized: selection.box_normalized,
              },
            });
          }),
        Array.isArray(remembered) ? remembered : [],
      );
      signal.throwIfAborted();
      let applied = false;
      await this.store.change((state) => {
        const g = state.goals.find((g) => g.id === goal.id);
        const s = g?.steps.find((s) => s.id === step.id);
        if (
          state.paused ||
          !g ||
          g.state !== 'running' ||
          g.revision !== goal.revision ||
          s?.state !== 'pending'
        )
          return;
        s.params = action.params;
        applied = true;
      });
      return applied;
    } catch (error) {
      if (signal.aborted) return false;
      await this.store.change((state, emit) => {
        const g = state.goals.find((g) => g.id === goal.id);
        const s = g?.steps.find((s) => s.id === step.id);
        if (
          state.paused ||
          !g ||
          g.state !== 'running' ||
          g.revision !== goal.revision ||
          s?.state !== 'pending'
        )
          return;
        s.state = 'failed';
        s.finished_at = now();
        s.result = {
          ok: false,
          message: (error as Error).message,
          physical_attempted: false,
          failure: { code: 'GROUNDING_UNRESOLVED', scope: 'pre_dispatch' },
        };
        g.state = 'review';
        g.review_kind = 'failure';
        g.review_reason = `执行前视觉选择未完成，机械臂尚未动作：${(error as Error).message}`;
        g.message = g.review_reason;
        this.reply(emit, g, g.message);
      });
      return false;
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
  private async recoverLocally(goal: Goal, state: QueueState): Promise<boolean> {
    const proposal = recoveryObservation(goal, state);
    if (!proposal) return false;
    if (proposal.recovery.kind === 'verify_cell') {
      const parent = goal.steps.find((s) => s.id === proposal.recovery.parent_id)!;
      const ref = String(record(parent.params.destination).cell_ref);
      try {
        const observation = await readObservation(
          this.base(),
          ref.split(':')[1]!,
          AbortSignal.timeout(3000),
        );
        const cell = (
          Array.isArray(observation.references) ? observation.references : []
        )
          .map(record)
          .find((r) => r.ref === ref);
        if (!cell) return false;
        if (typeof cell.cell_id === 'string') proposal.recovery.cell_id = cell.cell_id;
        else {
          proposal.recovery.row = Number(cell.row);
          proposal.recovery.column = Number(cell.column);
        }
      } catch {
        return false;
      }
    }
    let applied = false;
    await this.store.change((current, emit) => {
      const g = current.goals.find((g) => g.id === goal.id);
      if (
        !g ||
        g.revision !== goal.revision ||
        g.state !== 'review' ||
        current.paused ||
        g.local_recoveries?.includes(proposal.recovery.key)
      )
        return;
      const child = stepsFor([proposal])[0]!;
      const next = g.steps.findIndex((s) => s.state === 'pending');
      g.steps.splice(next < 0 ? g.steps.length : next, 0, child);
      g.local_recoveries = [...(g.local_recoveries ?? []), proposal.recovery.key];
      g.state = 'running';
      g.message = proposal.title;
      applied = true;
      this.emit(
        emit,
        `recovery:${proposal.recovery.key}`,
        'intelligence.observed',
        g.conversation_id,
        {
          ...proposal.recovery,
          recovery_kind: proposal.recovery.kind,
          kind: 'local_recovery',
          goal_id: g.id,
        },
      );
    });
    return applied;
  }
  private async prepareAhead(state: QueueState, flight: QueueStep) {
    if (state.paused || this.job || this.ahead) return;
    const current = state.goals.find((g) => g.steps.some((s) => s.id === flight.id));
    const next = state.goals.find(
      (g) => g.state === 'queued' && !g.interaction && !g.steps.length,
    );
    if (
      !current ||
      !next ||
      current.architecture === 'staged' ||
      next.architecture === 'staged' ||
      !canPrepareAhead(current, flight, next)
    )
      return;
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
        if (['model', 'provider_failure'].includes(String(data.kind)))
          goal.model_calls++;
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
          createWindow: this.compression
            ? (...args) => this.compression!.createWindow(...args)
            : undefined,
          contextBudgetTokens: settings.performance.contextBudgetTokens ?? 12000,
          toolResultBudgetTokens: settings.performance.toolResultBudgetTokens ?? 1600,
          fallbackProfiles: profiles.slice(1),
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

  private startPlanning(goal: Goal, role: Role, intake = false) {
    const abort = new AbortController();
    if (intake) this.intakeJobs.set(goal.id, abort);
    else this.job = { id: goal.id, abort };
    void (async () => {
      await this.store.change((state, emit) => {
        const current = state.goals.find((g) => g.id === goal.id);
        if (
          !current ||
          current.revision !== goal.revision ||
          ended(current) ||
          current.state === 'paused'
        )
          return;
        const request = {
          id: randomUUID(),
          role,
          revision: current.revision,
          requested_at: now(),
        };
        current.inference_request = request;
        current.state = 'planning';
        this.emit(
          emit,
          `inference:${request.id}`,
          role === 'planner' ? 'planning.requested' : 'supervision.requested',
          goal.conversation_id,
          { goal_id: goal.id, request_id: request.id, revision: goal.revision },
        );
      });
      await this.flush();
    })().catch(async (error) => {
      await this.failInference(goal, error as Error);
      this.finishInference(goal.id);
    });
  }

  private finishInference(id: string) {
    this.intakeJobs.delete(id);
    if (this.job?.id === id) this.job = undefined;
  }

  private async failInference(goal: Goal, error: Error) {
    await this.store.change((current, emit) => {
      const g = current.goals.find((g) => g.id === goal.id);
      if (!g || g.revision !== goal.revision || ended(g) || g.state === 'paused')
        return;
      delete g.inference_request;
      g.state = 'blocked';
      g.message = /timeout|timed out|aborted due/i.test(error.message)
        ? '模型服务响应超时，本次请求未完成。'
        : error.message;
      g.updated_at = now();
      this.reply(
        emit,
        g,
        g.interaction
          ? `${g.message}这不代表任何动作已执行；可直接查询当前任务进度。`
          : `${g.message}任务和已完成步骤已保留。`,
        true,
      );
    });
  }

  /** Called only by independently registered planner/supervisor Bus consumers. */
  async handleInference(role: Role, context: InProcessEventContext) {
    const payload = record(context.event.payload);
    const state = await this.store.read();
    const goal = state.goals.find((g) => g.id === payload.goal_id);
    const request = goal?.inference_request;
    if (
      !goal ||
      !request ||
      request.id !== payload.request_id ||
      request.role !== role ||
      goal.revision !== payload.revision ||
      ended(goal) ||
      goal.state === 'paused' ||
      this.inferenceJobs.has(request.id)
    )
      return;
    if (
      role === 'supervisor' &&
      (await this.models.settings()).supervisorEnabled === false
    ) {
      await this.store.change((current) => {
        const g = current.goals.find((g) => g.id === goal.id);
        if (g?.inference_request?.id === request.id) {
          g.state = 'review';
          delete g.inference_request;
        }
      });
      this.finishInference(goal.id);
      return;
    }
    const abort =
      this.intakeJobs.get(goal.id) ??
      (this.job?.id === goal.id ? this.job.abort : new AbortController());
    this.inferenceJobs.add(request.id);
    try {
      const result = await this.runPlanning(goal, state, role, abort.signal);
      if (result && !abort.signal.aborted)
        await context.publish({
          event_type: 'intelligence.decision.proposed',
          correlation_id: goal.conversation_id,
          causation_id: context.event.eventId,
          idempotency_key: `decision:${request.id}`,
          payload: {
            goal_id: goal.id,
            revision: goal.revision,
            request_id: request.id,
            ...result,
          },
        });
    } catch (error) {
      if (!abort.signal.aborted) await this.failInference(goal, error as Error);
    } finally {
      this.inferenceJobs.delete(request.id);
      this.finishInference(goal.id);
    }
  }

  private async runPlanning(
    goal: Goal,
    state: QueueState,
    role: Role,
    signal: AbortSignal,
  ) {
    const settings = await this.models.settings();
    if (role === 'supervisor' && settings.supervisorEnabled === false) return;
    if (
      role === 'supervisor' &&
      goal.architecture === 'staged' &&
      (goal.final_review_count ?? 0) >= (settings.architecture?.finalReviewLimit ?? 2)
    )
      throw new Error('任务列表已达到高级复核上限，需要用户查看失败阶段。');
    if (
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
    const direct =
      role === 'planner' && !goal.steps.length
        ? immediateAction(goal.source)
        : undefined;
    if (direct) {
      const live = await this.live();
      const capabilities = record(live.capabilities);
      if (
        Array.isArray(capabilities.skills) &&
        capabilities.skills.includes(direct.skill)
      ) {
        const errors = validatePlan(executablePlan(goal, stepsFor([direct])[0]!));
        if (!errors.length) {
          await this.store.change((_, emit) =>
            this.emit(
              emit,
              `direct:${goal.id}`,
              'intelligence.observed',
              goal.conversation_id,
              {
                kind: 'direct_plan',
                role,
                loop: 'fast',
                goal_id: goal.id,
                skill: direct.skill,
              },
            ),
          );
          return {
            decision: {
              mode: 'simple' as const,
              summary: direct.title,
              completion: '控制器确认动作完成',
              outcome: 'continue' as const,
              message: '',
              actions: [direct],
              plan_scope: 'complete' as const,
            },
            capabilities,
          };
        }
      }
    }
    const architecture =
      goal.architecture ??
      (goal.interaction && !goal.steps.length
        ? (settings.architecture?.mode ?? 'legacy')
        : 'legacy');
    const recordInference = async (data: Record<string, unknown>) => {
      await this.store.change((current, emit) => {
        const g = current.goals.find((item) => item.id === goal.id);
        if (!g) return;
        if (['model', 'provider_failure'].includes(String(data.kind))) g.model_calls++;
        this.emit(
          emit,
          `model:${randomUUID()}`,
          'intelligence.observed',
          g.conversation_id,
          {
            goal_id: g.id,
            loop: data.kind === 'model' ? 'slow' : undefined,
            ...data,
          },
        );
      });
    };
    if (
      architecture === 'staged' &&
      role === 'planner' &&
      goal.interaction &&
      !goal.steps.length
    ) {
      signal = AbortSignal.any([
        signal,
        AbortSignal.timeout(settings.performance?.planningBudgetMs ?? 60000),
      ]);
      const live = await this.live();
      if (isSceneQuestion(goal.source)) {
        const observed = await observeScene(
          this.base(),
          {
            scope: 'scene',
            scene_mode: 'auto',
            cameras: ['scene_camera'],
          },
          goal.conversation_id,
          AbortSignal.any([
            signal,
            AbortSignal.timeout(settings.nodeTimeouts?.perception ?? 15000),
          ]),
        );
        const decision: Decision = {
          mode: 'simple',
          outcome: 'chat',
          message: localSceneReply(observed),
          actions: [],
          summary: '',
          completion: '',
          plan_scope: 'complete',
          evidence_reply: true,
          architecture: 'staged',
        };
        return { decision, capabilities: record(live.capabilities) };
      }
      const decision = await runStagedPlanning(
        {
          settings,
          taskProfiles: await this.models.profilesFor('task'),
          plannerProfiles: await this.models.profilesFor('planner'),
          goal,
          queue: state,
          live,
          conversation: await this.memory?.view(goal.conversation_id, 2000),
          readImage: () => this.image('scene'),
          observeScene: (currentSignal) =>
            observeScene(
              this.base(),
              {
                scope: 'scene',
                scene_mode: 'auto',
                cameras: ['scene_camera', 'side_camera'],
              },
              goal.conversation_id,
              AbortSignal.any([
                currentSignal,
                AbortSignal.timeout(settings.nodeTimeouts?.perception ?? 15000),
              ]),
            ),
          record: recordInference,
        },
        signal,
      );
      for (const action of decision.actions) {
        const step = stepsFor([action])[0]!;
        const errors = validatePlan(executablePlan(goal, step));
        if (errors.length) throw new Error(errors.join('；'));
      }
      await this.store.change((_, emit) =>
        this.emit(
          emit,
          `decision:${randomUUID()}`,
          'intelligence.observed',
          goal.conversation_id,
          { kind: 'decision', role: 'staged', goal_id: goal.id, ...decision },
        ),
      );
      return { decision, capabilities: record(live.capabilities) };
    }
    if (architecture === 'staged' && goal.architecture === 'staged') {
      signal = AbortSignal.any([
        signal,
        AbortSignal.timeout(settings.performance?.planningBudgetMs ?? 60000),
      ]);
      const live = await this.live();
      const context = {
        settings,
        taskProfiles: await this.models.profilesFor('task'),
        plannerProfiles: await this.models.profilesFor('planner'),
        goal,
        queue: state,
        live,
        conversation: await this.memory?.view(goal.conversation_id, 2000),
        readImage: () => this.image('scene'),
        observeScene: (currentSignal: AbortSignal) =>
          observeScene(
            this.base(),
            {
              scope: 'scene',
              scene_mode: 'auto',
              cameras: ['scene_camera', 'side_camera'],
            },
            goal.conversation_id,
            AbortSignal.any([
              currentSignal,
              AbortSignal.timeout(settings.nodeTimeouts?.perception ?? 15000),
            ]),
          ),
        record: recordInference,
      };
      const decision =
        role === 'supervisor'
          ? await reviewStagedPlanning(
              context,
              await this.models.profilesFor('supervisor'),
              signal,
            )
          : await continueStagedPlanning(context, signal);
      const currentLive = decision.actions.length ? await this.live() : live;
      await this.store.change((_, emit) =>
        this.emit(
          emit,
          `decision:${randomUUID()}`,
          'intelligence.observed',
          goal.conversation_id,
          { kind: 'decision', role, goal_id: goal.id, ...decision },
        ),
      );
      return { decision, capabilities: record(currentLive.capabilities) };
    }
    const profiles = this.models.profilesFor
      ? await this.models.profilesFor(role)
      : [await this.models.profile(role)];
    const visualProfiles = this.models.profilesFor
      ? await this.models.profilesFor('visual')
      : profiles;
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
        persistBrain: true,
        deadlineMs: Date.now() + (settings.performance?.planningBudgetMs ?? 60000),
        readQueue: () => this.store.read(),
        images: settings.images,
        createWindow: this.compression
          ? (...args) => this.compression!.createWindow(...args)
          : undefined,
        conversation:
          role === 'planner'
            ? await this.memory?.view(goal.conversation_id, 2000)
            : undefined,
        contextBudgetTokens: settings.performance?.contextBudgetTokens ?? 12000,
        toolResultBudgetTokens: settings.performance?.toolResultBudgetTokens ?? 1600,
        ...(this.store.archiveEvidence
          ? {
              archiveEvidence: (ref: string, value: unknown) =>
                this.store.archiveEvidence(goal.id, ref, value),
              readEvidence: (ref: string) => this.store.readEvidence(goal.id, ref),
            }
          : {}),
        ...(this.memory
          ? {
              readHistory: async (args: {
                query?: string;
                ref?: string;
                before?: string;
                limit?: number;
              }) => {
                const history = await this.memory!.history(goal.conversation_id, args);
                return {
                  ...compactContext(history.entries, {}, 4500),
                  has_more: history.has_more,
                  before: 'before' in history ? history.before : undefined,
                };
              },
            }
          : {}),
        fallbackProfiles: profiles.slice(1),
        visualProfiles,
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
            goal.steps.some(
              (s) => inFlight(s) || ['pending', 'failed'].includes(s.state),
            )
          )
            throw new Error(
              '仍有待处理或失败步骤，请先恢复或调整剩余计划，再根据新的执行证据核对目标。',
            );
          if (!decision.actions.length) return;
          const live = await this.live();
          const skills = record(live.capabilities).skills;
          for (const action of decision.actions) {
            if (!Array.isArray(skills) || !skills.includes(action.skill))
              throw new Error(
                `当前没有 ${action.skill} 技能，可用技能：${Array.isArray(skills) ? skills.join(', ') : '执行器暂不可用'}。请按工具schema中的真实名称提交。`,
              );
            const step = stepsFor([action])[0]!;
            const errors = validatePlan(executablePlan(goal, step));
            if (errors.length) throw new Error(errors.join('；'));
          }
        },
        readState: async () => {
          let live: Record<string, unknown>;
          try {
            live = await this.live();
          } catch (error) {
            // Historical questions and queue queries remain available during a
            // simulator outage. Motion still validates against fresh capabilities.
            return {
              available: false,
              error: String(error),
              holding: { verified: false, unknown: true },
            };
          }
          await this.store.change((state) => {
            if (
              typeof live.runtime_id === 'string' &&
              state.scene.runtime_id !== live.runtime_id
            )
              state.scene = { runtime_id: live.runtime_id, observations: [] };
            state.scene.available = true;
            state.scene.holding = record(live.holding);
            state.scene.observation = record(live.observation);
            state.scene.world = record(live.world);
          });
          return {
            ...live,
            recent_observations: (await this.store.read()).scene.observations ?? [],
          };
        },
        readImage: (camera, observationRef) => this.image(camera, observationRef),
        observe: (params, signal) =>
          observeScene(
            this.base(),
            params,
            goal.conversation_id,
            AbortSignal.any([
              signal,
              AbortSignal.timeout(settings.nodeTimeouts?.perception ?? 15000),
            ]),
          ),
        readObservation: (id, signal) => readObservation(this.base(), id, signal),
        record: recordInference,
      },
      signal,
    );
    signal.throwIfAborted();
    const live = decision.actions.length ? await this.live() : {};
    await this.store.change((_, emit) =>
      this.emit(
        emit,
        `decision:${randomUUID()}`,
        'intelligence.observed',
        goal.conversation_id,
        { kind: 'decision', role, goal_id: goal.id, ...decision },
      ),
    );
    return { decision, capabilities: record(live.capabilities) };
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
      const requestGoal = state.goals.find((g) => g.id === previous.id);
      if (
        !requestGoal ||
        requestGoal.revision !== previous.revision ||
        (state.paused && !requestGoal.interaction) ||
        ended(requestGoal) ||
        requestGoal.state === 'paused'
      )
        return;
      let goal = requestGoal;
      if (
        decision.outcome === 'continue' &&
        decision.target_goal_id &&
        decision.target_goal_id !== requestGoal.id
      ) {
        const target = state.goals.find((item) => item.id === decision.target_goal_id);
        if (!target || ended(target))
          throw new Error('待修改的任务列表不存在或已经结束。');
        if (target.interaction) throw new Error('不能把任务修改应用到临时交互请求。');
        const retainedStageNumber = Math.max(
          0,
          ...target.steps
            .filter((step) => step.state === 'completed' || inFlight(step))
            .map((step) => step.stage?.number ?? 0),
        );
        const renamed = new Map<string, string>();
        for (const [index, action] of decision.actions.entries())
          if (action.stage) {
            const original = action.stage.id;
            action.stage.number = retainedStageNumber + index + 1;
            action.stage.id = `list-${target.list_number ?? 'x'}-stage-${action.stage.number}-r${target.revision + 1}`;
            renamed.set(original, action.stage.id);
          }
        for (const action of decision.actions)
          if (action.stage)
            action.stage.depends_on = action.stage.depends_on.map(
              (id) => renamed.get(id) ?? id,
            );
        state.goals.splice(state.goals.indexOf(requestGoal), 1);
        target.source = `${target.source}\n用户修改：${requestGoal.source}`;
        target.revision++;
        goal = target;
      }
      goal.updated_at = now();
      if (role === 'supervisor' && goal.architecture === 'staged')
        goal.final_review_count = (goal.final_review_count ?? 0) + 1;
      const continuing = goal.steps.length > 0;
      delete goal.inference_request;
      if (!continuing || !goal.summary) goal.summary = decision.summary || goal.summary;
      if (!continuing || !goal.completion)
        goal.completion = decision.completion || goal.completion;
      goal.message = decision.message;
      if (decision.outcome === 'chat') {
        if (role === 'supervisor') throw new Error('监督节点不能用闲聊结束执行任务。');
        if (decision.silent) {
          state.goals.splice(state.goals.indexOf(goal), 1);
          return;
        }
        goal.state = 'completed';
        this.reply(
          emit,
          goal,
          decision.message || decision.summary,
          decision.evidence_reply === true || isSceneQuestion(goal.source),
        );
        if (goal.interaction && decision.architecture === 'staged')
          state.goals.splice(state.goals.indexOf(goal), 1);
        return;
      }
      if (decision.outcome === 'blocked' || decision.outcome === 'clarify') {
        goal.state = 'blocked';
        this.reply(emit, goal, decision.message || '需要补充任务信息。');
        return;
      }
      if (decision.outcome === 'complete') {
        if (
          !goal.steps.some((s) => s.state === 'completed') ||
          goal.steps.some((s) => inFlight(s) || ['pending', 'failed'].includes(s.state))
        )
          throw new Error('任务仍有未完成或失败步骤，不能宣布完成。');
        goal.state = 'completed';
        this.reply(emit, goal, decision.message || '任务完成条件已核对。');
        return;
      }
      goal.final_review = decision.final_review ?? goal.final_review ?? false;
      goal.interaction = false;
      goal.architecture = decision.architecture ?? goal.architecture ?? 'legacy';
      if (decision.advanced_requirement)
        goal.advanced_requirement = decision.advanced_requirement;
      goal.list_number ??=
        Math.max(0, ...state.goals.map((item) => item.list_number ?? 0)) + 1;
      goal.initial_mode ??= decision.mode;
      goal.mode =
        goal.mode === 'complex' || decision.mode === 'complex' ? 'complex' : 'simple';
      goal.plan_scope =
        decision.plan_scope ??
        (continuing ? goal.plan_scope : undefined) ??
        (goal.mode === 'complex' ? 'stage' : 'complete');
      delete goal.review_kind;
      goal.review_reason = '';
      if (!decision.actions.length) {
        if (goal.steps.some((s) => s.state === 'pending')) {
          if (goal.steps.some((s) => s.state === 'failed')) goal.recovery_count++;
          for (const step of goal.steps)
            if (['failed', 'cancelled'].includes(step.state)) step.state = 'superseded';
          // Mastra has reviewed these conclusions and explicitly retained the
          // remaining batch. Do not send the same check back every tick.
          for (const check of goal.checks ?? [])
            if (['failed', 'uncertain'].includes(check.state))
              check.state = 'superseded';
          goal.state = 'running';
          goal.message = decision.message || '继续执行已规划的剩余步骤。';
          this.reply(emit, goal, goal.message);
          return;
        }
        throw new Error('规划尚未给出下一步动作，任务保留等待补充。');
      }
      if (goal.steps.some((s) => s.state === 'failed')) goal.recovery_count++;
      for (const step of goal.steps)
        if (
          [
            'failed',
            'cancelled',
            ...(decision.queue_update === 'append' ? [] : ['pending']),
          ].includes(step.state)
        )
          step.state = 'superseded';
      for (const check of goal.checks ?? [])
        if (['failed', 'uncertain'].includes(check.state)) check.state = 'superseded';
      goal.steps.push(...stepsFor(decision.actions));
      goal.state = goal.steps.some(inFlight)
        ? 'running'
        : role === 'planner'
          ? 'queued'
          : 'running';
      goal.message = waitingMessage(state, goal);
      this.reply(emit, goal, goal.message);
    });
  }
}
