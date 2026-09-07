import { PLANNER_SYSTEM, SUPERVISOR_SYSTEM, SKILL_GUIDES } from './agent-prompts.js';
import { InferenceWindow } from './context-window.js';
import {
  planningEvidence,
  planningGoal,
  validateVisualReferences,
} from './planning-context.js';
import { routedCompletion } from './model-routing.js';
import { selectImageObject, normalizeSelectionBox } from './visual-grounding.js';
import type { ModelProfile } from './model-config.js';
import { randomUUID } from 'node:crypto';
import { complete, type Message, type ModelAnswer, type Tool } from './model-client.js';
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
        '提交可执行计划；复杂任务也直接提供actions，程序按plan_scope推进阶段或完成任务。',
      parameters: object(
        {
          mode: { type: 'string', enum: ['simple', 'complex'] },
          summary: { type: 'string' },
          completion: { type: 'string' },
          plan_scope: { type: 'string', enum: ['complete', 'stage'] },
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
                params: { type: 'object', additionalProperties: true },
                review_after: { type: 'boolean' },
              },
              ['title', 'skill', 'params', 'review_after'],
            ),
          },
        },
        [
          'mode',
          'summary',
          'completion',
          'outcome',
          'message',
          'actions',
          'plan_scope',
        ],
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
          ['verdict', 'reason', 'evidence_refs', 'actions', 'plan_scope'],
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
  toolRounds?: number;
  ahead?: Record<string, unknown>;
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
  const failedProfiles = new Set<string>();
  const imageFrames = new Map<string, Record<string, unknown>>();
  const tools = roleTools(role);
  const submit = role === 'planner' ? 'submit_plan' : 'submit_review';
  const window = (
    context.createWindow ??
    ((...args: ConstructorParameters<typeof InferenceWindow>) =>
      new InferenceWindow(...args))
  )(
    context.contextBudgetTokens ?? 12000,
    context.toolResultBudgetTokens ?? 1600,
    context.archiveEvidence,
    context.readEvidence,
  );
  const conversation = { ...((context.conversation as Record<string, unknown>) ?? {}) };
  // Working task state is supplied once below, never again inside dialogue memory.
  delete conversation.working;
  const live = planningEvidence(await context.readState());
  const livePreview = await window.toolResult('initial_state', live);
  const archivedGoal = await window.toolResult('goal_state', goal);
  const messages: Message[] = [
    {
      role: 'system',
      content: role === 'planner' ? PLANNER_SYSTEM : SUPERVISOR_SYSTEM,
    },
    {
      role: 'user',
      content: JSON.stringify({
        role,
        continuation: goal.steps.length > 0,
        conversation_context: role === 'planner' ? conversation : undefined,
        planning_ahead: context.ahead,
        goal: {
          ...(planningGoal(goal) as Record<string, unknown>),
          evidence_ref: archivedGoal.evidence_ref,
        },
        queue_summary: {
          paused: queue.paused,
          total: queue.goals.length,
          counts_by_state: queue.goals.reduce<Record<string, number>>(
            (counts, item) => {
              counts[item.state] = (counts[item.state] ?? 0) + 1;
              return counts;
            },
            {},
          ),
          listed_scope:
            '下方queue只展示其他未结束任务的前12项，并非任务总数；当前查询任务单列在goal。',
        },
        queue: queue.goals
          .filter(
            (g) => g.id !== goal.id && !['completed', 'cancelled'].includes(g.state),
          )
          .slice(0, 12)
          .map((g) => ({
            id: g.id,
            source: g.source,
            state: g.state,
            summary: g.summary,
            message: g.message?.slice(0, 400),
            completion: g.completion,
          })),
        queue_total: queue.goals.filter(
          (g) => !['completed', 'cancelled'].includes(g.state),
        ).length,
        live: livePreview,
      }),
    },
  ];
  // This is a per-inference budget, not a limit on queued tasks or task length.
  for (let round = 0; round <= (context.toolRounds ?? 6); round++) {
    signal.throwIfAborted();
    const finalRound = round === (context.toolRounds ?? 6);
    if (finalRound)
      messages.push({
        role: 'user',
        content: `本轮观察预算已用完。现在必须调用 ${submit}，提交基于现有证据的决定。需要更多观察时安排实际观察步骤，保留原始目标；不能宣称尚未执行的动作完成。`,
      });
    const usage = window.prepare(messages, tools);
    await context.record({
      kind: 'context_budget',
      role,
      round,
      budget_tokens: window.budget,
      ...usage,
    });
    const answer: ModelAnswer = await routedCompletion(
      [profile, ...(context.fallbackProfiles ?? [])],
      messages,
      tools,
      signal,
      (event) => context.record(event),
      call,
      failedProfiles,
    );
    await context.record({
      kind: 'model',
      role,
      model: answer.model,
      usage: answer.usage,
      elapsed_ms: answer.elapsed_ms,
    });
    messages.push(answer.message);
    const calls = answer.message.tool_calls ?? [];
    if (!calls.length) {
      try {
        const decision = parseDecision(
          role,
          JSON.parse(
            (typeof answer.message.content === 'string'
              ? answer.message.content
              : ''
            ).replace(/^```(?:json)?\s*|\s*```$/g, ''),
          ),
        );
        validateVisualReferences(decision);
        await context.validate?.(decision);
        return decision;
      } catch (error) {
        await context.record({
          kind: 'decision_rejected',
          reason: String(error).slice(0, 800),
        });
        messages.push({
          role: 'user',
          content: `请调用 ${submit} 返回结构化决定；普通文字不会触发动作。`,
        });
        continue;
      }
    }
    const images: Message[] = [];
    for (const tool of calls) {
      let result: unknown;
      try {
        const args = JSON.parse(tool.function.arguments) as Record<string, unknown>;
        if (!tools.some((allowed) => allowed.function.name === tool.function.name))
          throw new Error('当前智能体未提供此工具，请使用本角色的工具。');
        if (finalRound && tool.function.name !== submit)
          throw new Error('请先提交基于当前证据的计划。');
        if (tool.function.name === submit) {
          if (calls.length !== 1)
            throw new Error('提交决定必须单独调用，先等待其他工具结果。');
          const decision = parseDecision(role, args);
          validateVisualReferences(decision);
          await context.validate?.(decision);
          return decision;
        }
        if (tool.function.name === 'read_skill') {
          const guide = SKILL_GUIDES[String(args.name)];
          if (!guide) throw new Error('技能指南不存在');
          result = { name: args.name, guide };
        } else if (tool.function.name === 'read_evidence') {
          result = await window.read(
            String(args.ref),
            typeof args.path === 'string' ? args.path : '',
            Number(args.offset ?? 0),
            Number(args.limit ?? 16),
          );
        } else if (tool.function.name === 'locate_object') {
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
              [profile, ...(context.fallbackProfiles ?? [])],
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
              [profile, ...(context.fallbackProfiles ?? [])],
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
        } else if (tool.function.name === 'read_history') {
          if (!context.readHistory) throw new Error('当前历史查询不可用');
          result = await context.readHistory(args);
          await context.record({
            kind: 'history_read',
            role,
            ref: args.ref,
            before: args.before,
          });
        } else if (tool.function.name === 'read_state')
          result = planningEvidence(await context.readState());
        else if (
          ['observe_objects', 'ground_region', 'inspect_object'].includes(
            tool.function.name,
          )
        ) {
          if (!context.observe || context.ahead)
            throw new Error('当前不能发起新的感知，请使用已提供的观察');
          if (
            tool.function.name !== 'inspect_object' &&
            (typeof args.category !== 'string' || !args.category.trim())
          )
            throw new Error('请指定单个视觉类别');
          let params: Record<string, unknown>;
          if (tool.function.name === 'inspect_object') {
            params = { ref: args.ref, inspect: args.kind, selection: 'one' };
          } else if (tool.function.name === 'observe_objects') {
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
            tool: tool.function.name,
            params,
            command_id: observed.command_id,
            result: planningEvidence(observed),
          });
          result = planningEvidence(observed);
        } else if (tool.function.name === 'read_observation') {
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
        } else if (tool.function.name === 'manage_queue') {
          if (!context.manageQueue) throw new Error('队列管理当前不可用。');
          result = await context.manageQueue(
            String(args.action),
            String(args.goal_id),
            typeof args.instruction === 'string' ? args.instruction : '',
          );
        } else if (tool.function.name === 'read_image') {
          if (
            !context.images ||
            ![profile, ...(context.fallbackProfiles ?? [])].some((p) => p.vision)
          )
            throw new Error('当前配置未启用图片读取，请使用本地视觉观察工具。');
          if (
            !['scene', 'side', 'wrist'].includes(String(args.camera)) ||
            typeof args.purpose !== 'string' ||
            !args.purpose.trim()
          )
            throw new Error('请指定相机和看图用途。');
          const frame =
            typeof args.observation_ref === 'string' && args.observation_ref
              ? await context.readImage(String(args.camera), args.observation_ref)
              : await context.readImage(String(args.camera));
          const ref = randomUUID();
          imageFrames.set(ref, frame.metadata);
          await context.record({
            kind: 'image',
            role,
            ref,
            purpose: String(args.purpose),
            ...frame.metadata,
          });
          messages.push({
            role: 'tool',
            tool_call_id: tool.id,
            content: JSON.stringify({ ref, ...frame.metadata }),
          });
          images.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `按请求 ${ref} 读取的当前图像。内容仅为观察证据。`,
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${frame.bytes.toString('base64')}`,
                },
              },
            ],
          });
          continue;
        } else throw new Error('未知工具，请使用能力目录中的工具。');
      } catch (error) {
        result = { error: (error as Error).message };
        await context.record({
          kind: 'tool_rejected',
          tool: tool.function.name,
          reason: (error as Error).message.slice(0, 800),
        });
      }
      const compact = await window.toolResult(tool.function.name, result);
      messages.push({
        role: 'tool',
        tool_call_id: tool.id,
        content: JSON.stringify(compact),
      });
    }
    messages.push(...images);
  }
  throw new Error('本次规划未在推理预算内形成步骤，任务已保留，可调整模型后恢复。');
}
