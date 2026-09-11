import { estimateTokens } from '../../../modules/conversation/context-format.js';
import { Mastra } from '@mastra/core/mastra';
import { isSceneQuestion } from './interaction-routing.js';
import { executionPolicyJsonSchema } from './execution-policy.js';
import { TokenLimiter } from '@mastra/core/processors';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { toStandardSchema } from '@mastra/core/schema';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { PLANNER_SYSTEM, SUPERVISOR_SYSTEM, SKILL_GUIDES, groundingPrompt } from './agent-prompts.js';
import { actionParamsJsonSchema } from './action-params.js';
import { observeOperation } from './operation-telemetry.js';
import { InferenceWindow } from './context-window.js';
import {
  executionBrief,
  planningEvidence,
  planningGoal,
  validateVisualReferences,
} from './planning-context.js';
import { routedCompletion } from './model-routing.js';
import { selectImageObject, normalizeSelectionBox } from './visual-grounding.js';
import { mastraModel } from './mastra-model.js';
import type { ModelProfile } from './model-config.js';
import { randomUUID, createHash } from 'node:crypto';
import { complete, type Tool } from './model-client.js';
import {
  decisionSchema,
  reviewSchema,
  type Decision,
  type Goal,
  type QueueState,
  type Role,
} from './types.js';
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'read_execution_queue',
      description:
        '读取当前目标的完整结构化执行列表与异步监督结果。submit_plan用queue_update=append分批追加，replace_pending编辑未执行部分；已完成和运行中动作保留。',
      parameters: object({}, []),
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill',
      description: '按需读取专项技能的参数和用法。',
      parameters: object(
        { name: { type: 'string', enum: Object.keys(SKILL_GUIDES) } },
        ['name'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_evidence',
      description:
        '查询被压缩的完整工具证据；path为JSON Pointer，数组按offset/limit分页。',
      parameters: object(
        {
          ref: { type: 'string' },
          path: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 32 },
        },
        ['ref'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'locate_object',
      description:
        '按自然语言关系从当前图像选择一个物体，再用同帧SAM2生成实际ref。适合箱内横倒件、特定用途料箱等类别检测无法区分的目标；只观察不运动，短上下文视觉选择。',
      parameters: object(
        {
          description: { type: 'string' },
          category: { type: 'string' },
          camera: { type: 'string', enum: ['scene', 'side', 'wrist'] },
          inspect: { type: 'string', enum: ['axis', 'grid'] },
        },
        ['description', 'category', 'camera'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_history',
      description:
        '查询当前会话原始对话/执行记录，或用goal_引用读取机器人任务详情。默认返回最近记录；可按关键词、来源ref检索，before翻页。只读且不等待机械臂。',
      parameters: object(
        {
          query: { type: 'string' },
          ref: { type: 'string' },
          before: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 80 },
        },
        [],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_object',
      description:
        '对实际物体ref获取当前RGB-D几何。grid识别料箱格网、行列和占用；axis给出物体长轴两个端点的图像位置，可结合对应观察图识别正反端。不会运动。',
      parameters: object(
        { ref: { type: 'string' }, kind: { type: 'string', enum: ['grid', 'axis'] } },
        ['ref', 'kind'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'observe_objects',
      description:
        '立即观察某类物体的集合、实际引用与空间分组；只做感知，无机械运动。多物体是正常结果，之后选择成员ref。',
      parameters: object(
        {
          category: { type: 'string' },
          vision_mode: { type: 'string', enum: ['auto', 'fast', 'slow'] },
          slow_provider: { type: 'string', enum: ['sam3', 'florence2'] },
          cameras: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['scene_camera', 'side_camera', 'wrist_camera'],
            },
          },
        },
        ['category'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ground_region',
      description:
        '将本轮read_image中选定的单个物体框交给SAM2，生成当前可执行引用。优先box_2d=[ymin,xmin,ymax,xmax]归一化0..1000，也兼容box_normalized=[left,top,right,bottom]范围0..1。image_ref来自read_image。',
      parameters: object(
        {
          image_ref: { type: 'string' },
          category: { type: 'string' },
          box_2d: {
            type: 'array',
            items: { type: 'number', minimum: 0, maximum: 1000 },
            minItems: 4,
            maxItems: 4,
          },
          box_normalized: {
            type: 'array',
            items: { type: 'number' },
            minItems: 4,
            maxItems: 4,
          },
        },
        ['image_ref', 'category'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_observation',
      description:
        '按观察编号读取完整证据中的一页物体引用；历史步骤只保存编号，需要旧候选时在此查阅，执行会重新定位。',
      parameters: object(
        {
          observation_ref: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
        },
        ['observation_ref'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_state',
      description: '读取当前机械臂持物、可用技能及最近视觉语义。不会触发运动。',
      parameters: object({}, []),
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_image',
      description: '按需读取当前相机图片供本次模型判断。相机选择scene、side、wrist。',
      parameters: object(
        {
          camera: { type: 'string', enum: ['scene', 'side', 'wrist'] },
          purpose: { type: 'string' },
          observation_ref: {
            type: 'string',
            description:
              '可选，读取inspect_object等返回的同一次观察图以对应几何端点；省略则读取新图。',
          },
        },
        ['camera', 'purpose'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_queue',
      description:
        '仅在用户明确要求取消、暂停、恢复、修改已有任务时调用。普通新动作保持追加排队。goal_id 必须来自真实队列；amend 用 instruction 保存用户修改后的任务目标。',
      parameters: object(
        {
          action: {
            type: 'string',
            enum: ['cancel', 'pause', 'resume', 'retry', 'amend'],
          },
          goal_id: { type: 'string' },
          instruction: { type: 'string' },
        },
        ['action', 'goal_id', 'instruction'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_plan',
      description:
        '在同一次提交中判断复杂度并给出动作序列。简单任务一次提交全部actions，正常执行后直接完成；复杂任务按需要分批，提交后不再调用模型确认计划。',
      parameters: object(
        {
          queue_update: { type: 'string', enum: ['replace_pending', 'append'] },
          final_review: {
            type: 'boolean',
            description:
              '是否执行完再调用Mastra验收。简单任务通常false，控制器/局部监督反馈即可结束；用户明确要求或需要语义验收时true。',
          },
          mode: {
            type: 'string',
            enum: ['simple', 'complex'],
            default: 'simple',
            description:
              '由你在本次规划判断。simple=明确目标的完整有限动作序列，多步也可以简单；complex=需要条件循环、执行中获取新证据再决定后续工作。与快慢环选择独立。',
          },
          summary: { type: 'string' },
          completion: { type: 'string' },
          plan_scope: {
            type: 'string',
            enum: ['complete', 'stage'],
            description:
              'complete=已提交整个目标所需序列，简单任务使用此值；stage=只提交当前可确定批次，结束后必须再决策。复杂任务能一次给完时也用complete。',
          },
          outcome: {
            type: 'string',
            enum: ['continue', 'complete', 'blocked', 'clarify', 'chat'],
          },
          message: { type: 'string' },
          actions: {
            type: 'array',
            items: object(
              {
                title: { type: 'string' },
                skill: { type: 'string' },
                params: actionParamsJsonSchema,
                review_after: {
                  type: 'boolean',
                  description:
                    '此动作之后是否必须重新调用Mastra决策。普通连续动作false；仅后续步骤依赖新证据/决策时true，局部异步监督在execution中设置。',
                },
                execution: executionPolicyJsonSchema,
              },
              ['title', 'skill', 'params'],
            ),
          },
        },
        ['actions', 'outcome'],
      ),
    },
  },
];

export function roleTools(role: Role): Tool[] {
  if (role === 'planner') return TOOLS;
  const action = TOOLS.find((t) => t.function.name === 'submit_plan')!.function
    .parameters;
  return [
    ...TOOLS.filter((t) => !['submit_plan', 'manage_queue'].includes(t.function.name)),
    {
      type: 'function',
      function: {
        name: 'submit_review',
        description: '提交对当前任务的监督结论和剩余步骤修正；不修改用户目标。',
        parameters: object(
          {
            verdict: {
              type: 'string',
              enum: ['continue', 'repair', 'complete', 'blocked'],
            },
            reason: { type: 'string' },
            evidence_refs: { type: 'array', items: { type: 'string' } },
            plan_scope: { type: 'string', enum: ['complete', 'stage'] },
            actions: (action.properties as Record<string, unknown>).actions,
          },
          ['verdict', 'reason', 'actions'],
        ),
      },
    },
  ];
}

function parseDecision(role: Role, value: unknown): Decision {
  if (role === 'planner') return decisionSchema.parse(value);
  const review = reviewSchema.parse(value);
  if (review.verdict === 'repair' && !review.actions.length)
    throw new Error('repair需要可执行恢复步骤；缺少能力或证据请返回blocked。');
  if (review.verdict !== 'repair' && review.actions.length)
    throw new Error('只有repair可以提交剩余队列修正。');
  return decisionSchema.parse({
    mode: 'complex',
    summary: '',
    completion: '',
    outcome: review.verdict === 'repair' ? 'continue' : review.verdict,
    message: review.reason,
    actions: review.actions,
    plan_scope: review.plan_scope,
  });
}

export interface PlanningContext {
  persistBrain?: boolean;
  deadlineMs?: number;
  readOnly?: boolean;
  queueControl?: boolean;
  contextBudgetTokens?: number;
  toolResultBudgetTokens?: number;
  archiveEvidence?: (ref: string, value: unknown) => Promise<void>;
  readEvidence?: (ref: string) => Promise<unknown>;
  createWindow?:
    | ((...args: ConstructorParameters<typeof InferenceWindow>) => InferenceWindow)
    | undefined;
  conversation?: unknown;
  readHistory?(args: {
    query?: string;
    ref?: string;
    before?: string;
    limit?: number;
  }): Promise<unknown>;
  readState(): Promise<Record<string, unknown>>;
  readQueue?(): Promise<QueueState>;
  readImage(
    camera: string,
    observationRef?: string,
  ): Promise<{ bytes: Buffer; metadata: Record<string, unknown> }>;
  record(event: Record<string, unknown>): Promise<void>;
  validate?(decision: Decision): Promise<void>;
  manageQueue?(action: string, id: string, instruction: string): Promise<unknown>;
  observe?(
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
  readObservation?(id: string, signal: AbortSignal): Promise<Record<string, unknown>>;
  images: boolean;
  fallbackProfiles?: ModelProfile[];
  visualProfiles?: ModelProfile[];
  toolRounds?: number;
  ahead?: Record<string, unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const localSceneLabel = (label: string) =>
  ({
    block: '方块',
    cube: '方块',
    cylinder: '圆柱',
    nut: '螺母',
    gear: '齿轮',
    shaft: '轴',
    bolt: '螺栓',
    bracket: '支架',
    sleeve: '轴套',
    washer: '垫圈',
    wrench: '扳手',
    screwdriver: '螺丝刀',
    tray: '料盘',
    bowl: '碗状容器',
    box: '箱体',
    table: '桌面',
  })[label.toLowerCase()] ?? label;

export function localSceneReply(packet: Record<string, unknown>): string {
  const vision = asRecord(packet.vision ?? packet);
  const views = Array.isArray(vision.views) ? vision.views.map(asRecord) : [];
  const labels = [
    ...new Set(
      views.flatMap((view) =>
        Array.isArray(view.objects)
          ? view.objects
              .map(asRecord)
              .map((item) => item.label)
              .filter((label): label is string => typeof label === 'string' && !!label)
          : [],
      ),
    ),
  ].map(localSceneLabel);
  const captions = [
    ...new Set(
      views
        .map((view) => view.caption)
        .filter(
          (caption): caption is string => typeof caption === 'string' && !!caption,
        ),
    ),
  ];
  const regions = [
    ...new Set(
      views.flatMap((view) =>
        Array.isArray(view.regions)
          ? view.regions
              .map(asRecord)
              .map((item) => item.description)
              .filter(
                (description): description is string =>
                  typeof description === 'string' && !!description,
              )
          : [],
      ),
    ),
  ];
  if (labels.length && captions.length)
    return `当前画面识别到${labels.join('、')}。本地视觉描述：${captions.join('；')}`;
  if (labels.length) return `当前画面识别到${labels.join('、')}。`;
  if (captions.length) return `当前画面的本地视觉描述：${captions.join('；')}`;
  if (regions.length) return `当前画面主要包含：${regions.join('、')}。`;
  return '当前画面已读取，但本地视觉没有得到足够可靠的物体类别。';
}

let brainMemory: Memory | undefined;
function memory() {
  if (!brainMemory) {
    const directory = resolve(process.env.BUSAGENT_MASTRA_DIR ?? '.local/mastra');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    brainMemory = new Memory({
      storage: new LibSQLStore({
        id: 'robot-brain',
        url: `file:${directory}/brain.db`,
      }),
      options: {
        lastMessages: 12,
        semanticRecall: false,
        generateTitle: false,
        workingMemory: {
          enabled: true,
          scope: 'resource',
          template: `# Current task
## Original goal and constraints
## Chosen objects, groups, container and cells (actual refs)
## Verified completed work
## Pending work and unresolved failures
## Evidence references and their freshness`,
        },
      },
    });
  }
  return brainMemory;
}

export async function planGoal(
  profile: ModelProfile,
  role: Role,
  goal: Goal,
  queue: QueueState,
  context: PlanningContext,
  signal: AbortSignal,
  call: typeof complete = complete,
): Promise<Decision> {
  const original = context;
  context = {
    ...context,
    readImage: (camera, ref) =>
      observeOperation(
        (e) => original.record(e),
        'camera_frame',
        () =>
          ref === undefined
            ? original.readImage(camera)
            : original.readImage(camera, ref),
      ),
    ...(original.observe
      ? {
          observe: (params: Record<string, unknown>, s: AbortSignal) =>
            observeOperation(
              (e) => original.record(e),
              typeof params.inspect === 'string' ? params.inspect : 'perception',
              () => original.observe!(params, s),
            ),
        }
      : {}),
  };
  if (
    role === 'planner' &&
    !goal.steps.length &&
    context.observe &&
    isSceneQuestion(goal.source)
  ) {
    const observed = await context.observe(
      {
        scope: 'scene',
        scene_mode: 'auto',
        cameras: ['scene_camera'],
      },
      signal,
    );
    await context.record({
      kind: 'vision_tool',
      role,
      route: 'local_scene_query',
      purpose: goal.source,
      command_id: observed.command_id,
      result: planningEvidence(observed),
    });
    return decisionSchema.parse({
      mode: 'simple',
      outcome: 'chat',
      message: localSceneReply(observed),
      actions: [],
      plan_scope: 'complete',
      evidence_reply: true,
    });
  }
  const window = new InferenceWindow(
    context.contextBudgetTokens ?? 12000,
    context.toolResultBudgetTokens ?? 2200,
    context.archiveEvidence,
    context.readEvidence,
  );
  const imageFrames = new Map<string, Record<string, unknown>>();
  const cache = new Map<string, Promise<unknown>>();
  const submit = role === 'planner' ? 'submit_plan' : 'submit_review';
  let decision: Decision | undefined;
  let controlGoal = goal;
  const execute = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    signal.throwIfAborted();
    if (name === 'read_execution_queue') {
      const current = context.readQueue ? await context.readQueue() : queue;
      controlGoal = current.goals.find((g) => g.id === goal.id) ?? goal;
      return window.toolResult(name, controlGoal);
    }
    if (name === submit) {
      const candidate = parseDecision(role, args);
      if (context.persistBrain) {
        candidate.final_review ??= candidate.mode === 'complex';
        for (const action of candidate.actions)
          action.execution ??= {
            loop: 'fast_then_slow',
            max_attempts: 1,
            supervision: { kind: 'none' },
          };
      }
      if (
        context.readOnly &&
        (candidate.actions.length ||
          !['chat', 'clarify', 'blocked'].includes(candidate.outcome))
      )
        throw new Error('当前为只读查询，请回答问题，不下发动作');
      validateVisualReferences(candidate);
      await context.validate?.(candidate);
      decision = candidate;
      return {
        accepted: true,
        actions: candidate.actions.length,
        outcome: candidate.outcome,
      };
    }
    let result: unknown;
    if (name === 'read_skill') {
      const guide = SKILL_GUIDES[String(args.name)];
      if (!guide) throw new Error('技能指南不存在');
      result = { name: args.name, guide };
    } else if (name === 'read_evidence') {
      return await window.read(
        String(args.ref),
        typeof args.path === 'string' ? args.path : '',
        Number(args.offset ?? 0),
        Number(args.limit ?? 16),
      );
    } else if (name === 'locate_object') {
      if (!context.images) throw new Error('当前未启用按需图片读取。');
      if (!context.observe) throw new Error('当前视觉节点不可用。');
      if (
        !['scene', 'side', 'wrist'].includes(String(args.camera)) ||
        typeof args.description !== 'string' ||
        !args.description.trim()
      )
        throw new Error('请提供目标描述和相机。');
      let camera = String(args.camera);
      let frame = await context.readImage(camera);
      let selected;
      try {
        selected = await selectImageObject(
          context.visualProfiles ?? [profile, ...(context.fallbackProfiles ?? [])],
          frame.bytes,
          String(args.description),
          signal,
          (event) => context.record(event),
          call,
        );
      } catch (error) {
        signal.throwIfAborted();
        // A single view can hide an end face or turn reflection into an
        // apparent edge. One independent view is useful new evidence.
        const alternate = camera === 'side' ? 'scene' : 'side';
        await context.record({
          kind: 'visual_view_fallback',
          camera,
          alternate,
          reason: (error as Error).message,
        });
        camera = alternate;
        frame = await context.readImage(camera);
        selected = await selectImageObject(
          context.visualProfiles ?? [profile, ...(context.fallbackProfiles ?? [])],
          frame.bytes,
          String(args.description),
          signal,
          (event) => context.record(event),
          call,
        );
      }
      const observed = await context.observe(
        {
          scope: 'target',
          category: String(args.category),
          selection: 'one',
          grounding: {
            snapshot_ref: frame.metadata.snapshot_ref,
            camera: camera + '_camera',
            box_normalized: selected.box_normalized,
          },
          ...(args.inspect ? { inspect: args.inspect } : {}),
        },
        signal,
      );
      await context.record({
        kind: 'vision_tool',
        tool: 'locate_object',
        description: args.description,
        selection: selected,
        command_id: observed.command_id,
        result: planningEvidence(observed),
      });
      result = {
        selection: selected,
        ...(planningEvidence(observed) as Record<string, unknown>),
      };
    } else if (name === 'read_history') {
      if (!context.readHistory) throw new Error('当前历史查询不可用');
      result = await context.readHistory(args);
      await context.record({
        kind: 'history_read',
        role,
        ref: args.ref,
        before: args.before,
      });
    } else if (name === 'read_state') {
      live = await context.readState();
      result = planningEvidence(live);
    } else if (['observe_objects', 'ground_region', 'inspect_object'].includes(name)) {
      if (!context.observe || context.ahead)
        throw new Error('当前不能发起新的感知，请使用已提供的观察');
      if (
        name !== 'inspect_object' &&
        (typeof args.category !== 'string' || !args.category.trim())
      )
        throw new Error('请指定单个视觉类别');
      let params: Record<string, unknown>;
      if (name === 'inspect_object') {
        params = { ref: args.ref, inspect: args.kind, selection: 'one' };
      } else if (name === 'observe_objects') {
        params = {
          scope: 'target',
          category: args.category,
          selection: 'all',
          vision_mode: args.vision_mode ?? 'auto',
          slow_provider: args.slow_provider ?? 'sam3',
          cameras: args.cameras,
        };
      } else {
        const frame = imageFrames.get(String(args.image_ref));
        if (!frame?.snapshot_ref)
          throw new Error('请先read_image，再使用它返回的image_ref框选');
        params = {
          category: args.category,
          selection: 'one',
          grounding: {
            snapshot_ref: frame.snapshot_ref,
            camera: `${String(frame.camera)}_camera`,
            box_normalized: normalizeSelectionBox(args),
          },
        };
      }
      const observed = await context.observe(params, signal);
      await context.record({
        kind: 'vision_tool',
        tool: name,
        params,
        command_id: observed.command_id,
        result: planningEvidence(observed),
      });
      result = planningEvidence(observed);
    } else if (name === 'read_observation') {
      if (!context.readObservation) throw new Error('观察存储当前不可用');
      const observed = await context.readObservation(
        String(args.observation_ref),
        signal,
      );
      const refs = Array.isArray(observed.references) ? observed.references : [];
      const offset = Math.max(0, Number(args.offset) || 0);
      result = {
        request_id: observed.request_id,
        label: observed.label,
        observed_at: observed.observed_at,
        references: refs.slice(offset, offset + 32),
        geometry: observed.geometry,
        total: refs.length,
        next_offset: offset + 32 < refs.length ? offset + 32 : null,
      };
    } else if (name === 'manage_queue') {
      if (!context.manageQueue) throw new Error('队列管理当前不可用。');
      result = await context.manageQueue(
        String(args.action),
        String(args.goal_id),
        typeof args.instruction === 'string' ? args.instruction : '',
      );
    } else if (name === 'read_image') {
      if (!context.images) throw new Error('当前未启用图片读取');
      const camera = String(args.camera);
      if (!['scene', 'side', 'wrist'].includes(camera) || !args.purpose)
        throw new Error('请提供相机和看图目的');
      const frame = await context.readImage(
        camera,
        typeof args.observation_ref === 'string' ? args.observation_ref : undefined,
      );
      const ref = randomUUID();
      imageFrames.set(ref, frame.metadata);
      await context.record({
        kind: 'image',
        role,
        ref,
        purpose: args.purpose,
        ...frame.metadata,
      });
      const geometry =
        typeof args.observation_ref === 'string' && context.readObservation
          ? planningEvidence(
              await context.readObservation(args.observation_ref, signal),
            )
          : undefined;
      // A narrow visual call receives the pixels once. Neither Mastra memory nor the Bus stores image bytes.
      const answer = await routedCompletion(
        context.visualProfiles ?? [profile, ...(context.fallbackProfiles ?? [])],
        [
          {
            role: 'system',
            content:
              '你是机器人视觉工具，只回答给定观察问题。输出简洁JSON：findings、objects（description和box_2d，坐标[ymin,xmin,ymax,xmax]归一化0..1000）、uncertainty。不要制定动作或改变目标。端点语义必须结合给出的端点像素位置，不能猜编号。',
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  purpose: args.purpose,
                  frame: frame.metadata,
                  geometry,
                }),
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${frame.bytes.toString('base64')}`,
                },
              },
            ],
          },
        ],
        [],
        signal,
        (e) => context.record(e),
        call,
        new Set(),
        { maxTokens: 1400 },
      );
      await context.record({
        kind: 'model',
        role: 'visual_observer',
        route: 'focused_image',
        model: answer.model,
        elapsed_ms: answer.elapsed_ms,
        usage: answer.usage,
      });
      result = { image_ref: ref, ...frame.metadata, findings: answer.message.content };
    } else throw new Error('未知工具');
    return window.toolResult(name, result);
  };
  let live = await context.readState();
  const skills = (live.capabilities as { skills?: string[] } | undefined)?.skills;
  const definitions = structuredClone(roleTools(role)).filter(
    (t) =>
      !(
        t.function.name === 'manage_queue' &&
        (context.readOnly || context.queueControl === false)
      ),
  );
  // Publish the controller's actual callable vocabulary at every model step,
  // including after history trimming. This is a tool contract, not an asset list.
  if (skills?.length) {
    const definition = definitions.find((t) => t.function.name === submit)!;
    const properties = definition.function.parameters.properties as Record<
      string,
      unknown
    >;
    const actions = properties.actions as {
      items: { properties: Record<string, unknown> };
    };
    actions.items.properties.skill = {
      type: 'string',
      enum: skills,
      description:
        '当前执行器的真实技能名称；抓取为grasp，持物放置为place_held，连续抓放为pick_place。',
    };
  }
  const tools = Object.fromEntries(
    definitions.map(({ function: definition }) => [
      definition.name,
      createTool({
        id: definition.name,
        description: definition.description,
        inputSchema: toStandardSchema(definition.parameters),
        execute: async (input: unknown) => {
          const args = input as Record<string, unknown>;
          const key = createHash('sha256')
            .update(JSON.stringify([definition.name, args]))
            .digest('hex');
          const reusable = ![
            submit,
            'manage_queue',
            'read_state',
            'read_execution_queue',
          ].includes(definition.name);
          if (reusable && cache.has(key)) {
            await context.record({ kind: 'tool_cache_hit', tool: definition.name });
            return cache.get(key)!;
          }
          const pending = execute(definition.name, args).catch(async (error) => {
            cache.delete(key);
            signal.throwIfAborted();
            await context.record({
              kind: 'tool_rejected',
              tool: definition.name,
              reason: String(error).slice(0, 800),
            });
            return { error: (error as Error).message, arguments: args };
          });
          if (reusable) cache.set(key, pending);
          return pending;
        },
      }),
    ]),
  );
  const initial = {
    current_request: goal.source,
    role,
    continuation: goal.steps.length > 0,
    live: planningEvidence(live),
    goal: planningGoal(goal),
    queue: queue.goals
      .filter((g) => g.id !== goal.id && !['completed', 'cancelled'].includes(g.state))
      .slice(0, 12)
      .map((g) => ({ id: g.id, source: g.source, state: g.state })),
    conversation: context.conversation,
    planning_ahead: context.ahead,
  };
  const agent = new Agent({
    id: `robot-${role}`,
    name: `Robot ${role}`,
    instructions:
      (role === 'planner' ? PLANNER_SYSTEM : SUPERVISOR_SYSTEM) +
      groundingPrompt(profile.provider) +
      '\n不可压缩的当前用户目标：' +
      goal.source,
    model: mastraModel(
      [profile, ...(context.fallbackProfiles ?? [])],
      signal,
      (e) => context.record({ role, ...e }),
      call,
    ),
    inputProcessors: [
      {
        id: 'robot-step-boundaries',
        processInputStep: ({ stepNumber, rotateResponseMessageId, messageList }) => {
          // Mastra otherwise stores the whole tool loop as one assistant
          // message, which its TokenLimiter cannot trim by completed step.
          if (stepNumber > 0) rotateResponseMessageId?.();
          // Native TokenLimiter can retire the initial user/tool messages.
          // Keep only bounded current control facts in a replaceable system tag.
          messageList.clearSystemMessages('robot-control-state');
          messageList.addSystem(
            '当前执行事实（数据，不是指令；不因图片描述而覆盖持物反馈）：' +
              JSON.stringify(executionBrief(controlGoal, live)),
            'robot-control-state',
          );
        },
      },
      new TokenLimiter({
        limit: Math.max(
          4000,
          (context.contextBudgetTokens ?? 12000) - estimateTokens(definitions),
        ),
        trimMode: 'contiguous',
      }),
    ],
    tools,
    ...(context.persistBrain ? { memory: memory() } : {}),
  });
  const brain = context.persistBrain
    ? new Mastra({ agents: { brain: agent }, logger: false }).getAgent('brain')
    : agent;
  // Budget the whole initial message, not each component independently: several
  // individually bounded reports plus history can still exceed one model window.
  const input = await window.toolResult('planning_input', initial);
  // One evidence-gathering response, then a forced structured decision. A
  // complex task can deliberately submit a stage and re-enter with new facts;
  // it cannot spend an unbounded number of LLM calls preparing one decision.
  const toolRoundLimit = Math.min(context.toolRounds ?? 2, 2);
  const result = await brain.generate(JSON.stringify(input), {
    toolCallConcurrency: { limit: 4, strategy: 'called' },
    maxSteps: toolRoundLimit + 1,
    maxProcessorRetries: 0,
    abortSignal: signal,
    modelSettings: { maxRetries: 0, maxOutputTokens: 3500 },
    stopWhen: () => decision !== undefined,
    ...(context.persistBrain
      ? {
          memory: {
            thread: `${goal.id}:${role}`,
            resource: `${goal.conversation_id}:${goal.id}:${role}`,
          },
          savePerStep: true,
        }
      : {}),
    prepareStep: ({ stepNumber }) =>
      stepNumber >= toolRoundLimit ||
      (context.deadlineMs !== undefined &&
        context.deadlineMs - Date.now() <
          [profile, ...(context.fallbackProfiles ?? [])].reduce(
            (sum, p) => sum + (p.timeoutMs ?? 20000),
            0,
          ))
        ? { activeTools: [submit], toolChoice: { type: 'tool', toolName: submit } }
        : undefined,
  });
  if (decision) return decision;
  await context.record({
    kind: 'brain_stopped',
    framework: 'mastra',
    finish_reason: result.finishReason,
    steps: result.steps.length,
    tripwire: result.tripwire,
    error: result.error?.message,
  });
  if (result.error) throw result.error;
  if (result.tripwire)
    throw new Error(`Mastra处理器停止：${JSON.stringify(result.tripwire)}`);
  // Queries may finish naturally; text never becomes a physical command.
  if (result.text?.trim())
    await context.record({
      kind: 'uncommitted_response',
      text: result.text.slice(0, 800),
    });
  throw new Error('Mastra尚未提交可执行决定，已保存任务和观察记录。');
}
