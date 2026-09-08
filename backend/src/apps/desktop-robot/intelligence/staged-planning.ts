import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { routedCompletion } from './model-routing.js';
import { complete, type Message, type Tool } from './model-client.js';
import type { ModelProfile, ModelSettings } from './model-config.js';
import {
  actionSchema,
  decisionSchema,
  reviewSchema,
  type Decision,
  type Goal,
  type QueueState,
} from './types.js';
import { localSceneReply, roleTools } from './planning.js';
import { planningEvidence, planningGoal } from './planning-context.js';
import { physicalVerdict } from './execution-policy.js';

export const taskRouteSchema = z.object({
  disposition: z.enum(['no_action', 'query', 'simple', 'complex', 'modify']),
  query_kind: z.enum(['conversation', 'history', 'status', 'scene']).optional(),
  summary: z.string().default(''),
  completion: z.string().default(''),
  requirement: z.string().default(''),
  target_goal_id: z.string().optional(),
  actions: z.array(actionSchema).default([]),
});
export type TaskRoute = z.infer<typeof taskRouteSchema>;

function validatedTaskRoute(value: unknown) {
  const route = taskRouteSchema.parse(value);
  if (route.disposition === 'simple' && !route.actions.length)
    throw new Error('快速任务模型将任务判为simple，但没有提交动作。');
  if (route.disposition !== 'simple' && route.actions.length)
    throw new Error('只有simple分类可以由快速任务模型直接提交动作。');
  if (route.disposition === 'modify' && !route.target_goal_id)
    throw new Error('修改任务必须绑定现有任务列表。');
  return route;
}

export interface StagedPlanningContext {
  settings: ModelSettings;
  taskProfiles: ModelProfile[];
  plannerProfiles: ModelProfile[];
  goal: Goal;
  queue: QueueState;
  live: Record<string, unknown>;
  conversation?: unknown;
  readImage(): Promise<{ bytes: Buffer; metadata: Record<string, unknown> }>;
  observeScene(signal: AbortSignal): Promise<Record<string, unknown>>;
  record(event: Record<string, unknown>): Promise<void>;
}

const plannerSubmit = roleTools('planner').find(
  (tool) => tool.function.name === 'submit_plan',
)!;
const reviewSubmit = roleTools('supervisor').find(
  (tool) => tool.function.name === 'submit_review',
)!;
const plannerParameters = plannerSubmit.function.parameters as {
  properties: Record<string, unknown>;
};
const taskRouteTool: Tool = {
  type: 'function',
  function: {
    name: 'submit_task_route',
    description: '提交本轮输入的唯一分类；简单任务必须同时提交完整动作序列。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        disposition: {
          type: 'string',
          enum: ['no_action', 'query', 'simple', 'complex', 'modify'],
        },
        query_kind: {
          type: 'string',
          enum: ['conversation', 'history', 'status', 'scene'],
        },
        summary: { type: 'string' },
        completion: { type: 'string' },
        requirement: { type: 'string' },
        target_goal_id: { type: 'string' },
        actions: plannerParameters.properties.actions,
      },
      required: ['disposition', 'summary', 'completion', 'requirement', 'actions'],
    },
  },
};

const json = (value: unknown) => JSON.stringify(value);
const activeLists = (queue: QueueState) =>
  queue.goals
    .filter(
      (goal) => !goal.interaction && !['completed', 'cancelled'].includes(goal.state),
    )
    .slice(-12)
    .map((goal) => ({
      id: goal.id,
      number: goal.list_number,
      source: goal.source,
      summary: goal.summary,
      state: goal.state,
      completed: goal.steps.filter((step) => step.state === 'completed').length,
      total: goal.steps.length,
    }));

function submitted(answer: Awaited<ReturnType<typeof complete>>, name: string) {
  const call = answer.message.tool_calls?.find((item) => item.function.name === name);
  if (!call) throw new Error(`模型没有调用 ${name} 提交结构化结果。`);
  try {
    return JSON.parse(call.function.arguments) as unknown;
  } catch {
    throw new Error(`${name} 返回的JSON参数无效。`);
  }
}

async function structuredCall<T>(
  profiles: ModelProfile[],
  role: 'task_router' | 'advanced_planner' | 'final_reviewer',
  messagesFor: (profile: ModelProfile) => Promise<Message[]> | Message[],
  tool: Tool,
  signal: AbortSignal,
  record: (event: Record<string, unknown>) => Promise<void>,
  accept: (value: unknown, profile: ModelProfile) => T,
): Promise<T> {
  let last: unknown = new Error('没有可用模型。');
  for (const profile of profiles) {
    signal.throwIfAborted();
    try {
      const answer = await routedCompletion(
        [profile],
        await messagesFor(profile),
        [tool],
        signal,
        record,
        complete,
        new Set(),
        {
          maxTokens: role === 'task_router' ? 1800 : 4200,
          toolChoice: { type: 'function', function: { name: tool.function.name } },
        },
      );
      await record({
        kind: 'model',
        role,
        framework: 'mastra-staged-workflow',
        model: answer.model,
        elapsed_ms: answer.elapsed_ms,
        first_token_ms: answer.first_token_ms,
        usage: answer.usage,
        tool_calls: [tool.function.name],
      });
      return accept(submitted(answer, tool.function.name), profile);
    } catch (error) {
      last = error;
      await record({
        kind: 'structured_response_rejected',
        role,
        profile: profile.id,
        reason: (error as Error).message,
      });
    }
  }
  throw last;
}

export async function routeTask(
  context: StagedPlanningContext,
  signal: AbortSignal,
): Promise<TaskRoute> {
  const route = await structuredCall(
    context.taskProfiles,
    'task_router',
    () => [
      {
        role: 'system',
        content: `你是快速任务模型。你只处理当前一句用户输入，一次完成分类；不读图片、不调用历史工具、不写自然语言回复。
disposition=no_action：闲聊、知识问答、寒暄、确认语，以及不需要系统取证的对话；系统不会创建任务列表。
disposition=query：需要读取机器人状态、任务历史或当前场景；不要生成动作。
disposition=simple：目标和目的地明确、无需中途新证据即可完成的有限机器人任务。必须一次给出完整actions；普通抓放优先一个pick_place。execution.loop可选fast_only、fast_then_slow、slow，默认fast_then_slow。不要读图，目标使用用户给出的具体英文开放词汇标签。
disposition=complex：需要识别数量/区域/姿态、阶段依赖、中途观察、整理、装箱或开放式决策。只生成精确requirement，交给高级任务模型。
disposition=modify：用户明确修改、追加、取消或纠正已有任务列表；必须从active_lists选择target_goal_id，并在requirement中说明修改。模糊指代但存在唯一活动列表时可绑定；多个候选且无法判断则作为query。
“对、好、可以、继续说”等确认不是新任务。不要从历史复制动作。actions只允许控制器技能；一抓一放尽量使用pick_place。`,
      },
      {
        role: 'user',
        content: json({
          current_request: context.goal.source,
          holding: context.live.holding,
          controller_skills: (context.live.capabilities as { skills?: unknown })
            ?.skills,
          active_lists: activeLists(context.queue),
        }),
      },
    ],
    taskRouteTool,
    signal,
    (event) => context.record(event),
    (result) => validatedTaskRoute(result),
  );
  return route;
}

function advancedSystem(profile: ModelProfile) {
  const grounding = profile.vision && profile.boxGrounding === true;
  return `你是高级机器人任务模型。当前输入已经由快速模型判定为复杂任务或任务修改。一次生成当前可执行的完整阶段序列，不进行工具循环。
每个用户完整任务对应一个编号列表。一抓一放是一个stage；优先用一个pick_place表达。每个stage必须填写唯一id、连续number、depends_on和expected_state。expected_state必须是区域内可观察的自然语言状态，例如“金属圆柱直立在蓝色料箱格位内”。
列表number已经规定物理执行顺序，不能因为先后顺序就建立依赖。depends_on默认[]；只有后续阶段的目标、目的地或完成条件必须依靠前一阶段的成功结果时才填写依赖。没有依赖的阶段允许连续执行，其Florence检查异步运行；如果后续阶段确实依赖本阶段，当前动作execution.supervision.wait=true。每个抓放阶段设置Florence局部检查，提供target_label、region_label、predicate；能可靠给出目标区域框时再提供box_2d。
execution.loop只能为fast_only、fast_then_slow、slow。普通可见物体用fast_then_slow；陌生、杂乱或精确姿态可直接slow。识别链固定为YOLOE→SAM3→Florence，成功后由SAM2/光流持续跟踪。
目标和目的地可以使用具体开放词汇label或实际ref。不要输出配置资产名。空盘/桌面插空使用selection=free_space。框坐标为[ymin,xmin,ymax,xmax]、0..1000，必须绑定当前snapshot_ref和camera。严格服从live.capabilities.skills：当前只有普通抓放时，只能规划支撑面on或敞口容器inside；不得把圆环套到立柱、把销插入孔、悬挂到挂钩，也不得把治具立柱误称为料箱。只有控制器明确提供对应插入/悬挂技能时才能规划这些关系。
${grounding ? '本模型已启用原生框选能力：对需要明确选择的目标可输出grounding={snapshot_ref,camera,box_2d}。' : '本模型没有启用原生框选能力：禁止猜测box_2d或grounding；仅输出具体label/ref，系统使用YOLOE、SAM3和最终Florence定位。'}
任务修改时保留已完成和运行中阶段，用queue_update=replace_pending替换未执行部分；系统已经绑定目标列表，无需在提交参数中重复列表编号。计划结束后由独立高级复核模型验收，因此final_review=true。`;
}

function normalizeStages(decision: Decision, retryLimit: number, existing?: Goal) {
  const retained =
    existing?.steps.filter(
      (step) =>
        step.stage &&
        (step.state === 'completed' ||
          ['dispatching', 'running', 'unknown'].includes(step.state)),
    ) ?? [];
  const retainedIds = new Set(
    retained.flatMap((step) => (step.stage ? [step.stage.id] : [])),
  );
  const baseNumber = Math.max(0, ...retained.map((step) => step.stage?.number ?? 0));
  const renamed = new Map<string, string>();
  const originals = new Set<string>();
  for (const [index, action] of decision.actions.entries()) {
    if (!action.stage) throw new Error(`高级计划第${index + 1}个动作缺少stage。`);
    if (originals.has(action.stage.id)) throw new Error('高级计划的stage id不能重复。');
    originals.add(action.stage.id);
    const original = action.stage.id;
    action.stage.number = baseNumber + index + 1;
    if (retainedIds.has(original))
      action.stage.id = `${original}-r${existing?.revision ?? 1}-${action.stage.number}`;
    renamed.set(original, action.stage.id);
  }
  const ids = new Set(retainedIds);
  for (const action of decision.actions) {
    const stage = action.stage!;
    stage.depends_on = stage.depends_on.map(
      (dependency) => renamed.get(dependency) ?? dependency,
    );
    for (const dependency of stage.depends_on)
      if (!ids.has(dependency))
        throw new Error(`stage依赖不存在或顺序错误：${dependency}`);
    ids.add(stage.id);
  }
  const depended = new Set(
    decision.actions.flatMap((action) => action.stage?.depends_on ?? []),
  );
  for (const action of decision.actions) {
    if (!action.stage || !['grasp', 'pick_place', 'place_held'].includes(action.skill))
      continue;
    action.execution ??= { loop: 'fast_then_slow' };
    action.execution.max_attempts ??= retryLimit;
    const target = action.params.target as { label?: unknown } | string | undefined;
    const destination = action.params.destination as
      | { label?: unknown; grounding?: { box_2d?: unknown } }
      | string
      | undefined;
    const targetLabel =
      typeof target === 'string'
        ? target
        : typeof target?.label === 'string'
          ? target.label
          : action.stage.title;
    const regionLabel =
      typeof destination === 'string'
        ? destination
        : typeof destination?.label === 'string'
          ? destination.label
          : 'workspace';
    const box =
      typeof destination === 'object' && destination
        ? destination.grounding?.box_2d
        : undefined;
    const requestedPredicate = action.execution.supervision?.predicate;
    action.execution.supervision = {
      kind: 'florence',
      camera: 'scene',
      target_label: targetLabel,
      region_label: regionLabel,
      predicate:
        requestedPredicate ??
        (/直立|upright/i.test(action.stage.expected_state)
          ? 'upright'
          : /内|inside/i.test(action.stage.expected_state)
            ? 'inside'
            : /上|on/i.test(action.stage.expected_state)
              ? 'on'
              : 'present'),
      wait: depended.has(action.stage.id),
      ...(Array.isArray(box) && box.length === 4 ? { box_2d: box as number[] } : {}),
    };
  }
  return decision;
}

function simplePhysicalCompletion(goal: Goal) {
  if ((goal.initial_mode ?? goal.mode) !== 'simple' || goal.skipped_stages?.length)
    return false;
  if (goal.checks?.some((check) => ['failed', 'uncertain'].includes(check.state)))
    return false;
  const active = goal.steps.filter(
    (step) =>
      ['grasp', 'pick_place', 'place_held'].includes(step.skill) &&
      step.state !== 'superseded',
  );
  return (
    active.length > 0 &&
    active.every(
      (step) =>
        step.state === 'completed' &&
        physicalVerdict((step.result ?? {}) as Record<string, unknown>, step.skill) ===
          'passed',
    )
  );
}

async function advancedPlan(
  context: StagedPlanningContext,
  route: TaskRoute,
  signal: AbortSignal,
): Promise<Decision> {
  let frame: { bytes: Buffer; metadata: Record<string, unknown> } | undefined;
  let localEvidence: Record<string, unknown> | undefined;
  const decision = await structuredCall(
    context.plannerProfiles,
    'advanced_planner',
    async (profile) => {
      if (profile.vision && !frame) frame = await context.readImage();
      if (!profile.vision && !localEvidence)
        localEvidence = await context.observeScene(signal);
      const targetList = route.target_goal_id
        ? context.queue.goals.find((goal) => goal.id === route.target_goal_id)
        : undefined;
      const facts = {
        original_request: context.goal.source,
        advanced_requirement: route.requirement,
        route_summary: route.summary,
        completion: route.completion,
        list_operation: route.disposition === 'modify' ? 'modify' : 'create',
        target_goal_id: route.target_goal_id,
        target_list: targetList ? planningGoal(targetList) : undefined,
        active_lists: activeLists(context.queue),
        current_list: planningGoal(context.goal),
        live: planningEvidence(context.live),
        conversation: context.conversation,
        local_visual_evidence: planningEvidence(localEvidence),
        image: frame?.metadata,
      };
      const userContent: Exclude<Message['content'], string | null> = [
        { type: 'text', text: json(facts) },
      ];
      if (profile.vision && frame)
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${frame.bytes.toString('base64')}`,
          },
        });
      return [
        { role: 'system', content: advancedSystem(profile) },
        { role: 'user', content: userContent },
      ];
    },
    plannerSubmit,
    signal,
    (event) => context.record(event),
    (value) => {
      const parsed = decisionSchema.parse({
        ...(value as Record<string, unknown>),
        mode: 'complex',
        final_review: context.settings.architecture?.finalReview ?? true,
        target_goal_id: route.target_goal_id,
        advanced_requirement: route.requirement,
        architecture: 'staged',
      });
      if (parsed.outcome === 'continue' && !parsed.actions.length)
        throw new Error('高级任务模型没有提交可执行阶段。');
      return parsed.actions.length
        ? normalizeStages(
            parsed,
            context.settings.architecture?.stageRetryLimit ?? 2,
            context.goal.steps.length ? context.goal : undefined,
          )
        : parsed;
    },
  );
  return decision;
}

export async function continueStagedPlanning(
  context: StagedPlanningContext,
  signal: AbortSignal,
): Promise<Decision> {
  return advancedPlan(
    context,
    taskRouteSchema.parse({
      disposition: 'complex',
      summary: context.goal.summary,
      completion: context.goal.completion,
      requirement: context.goal.advanced_requirement || context.goal.source,
      actions: [],
    }),
    signal,
  );
}

export async function reviewStagedPlanning(
  context: StagedPlanningContext,
  profiles: ModelProfile[],
  signal: AbortSignal,
): Promise<Decision> {
  let frame: { bytes: Buffer; metadata: Record<string, unknown> } | undefined;
  let localEvidence: Record<string, unknown> | undefined;
  const decision = await structuredCall(
    profiles,
    'final_reviewer',
    async (profile) => {
      if (profile.vision && !frame) frame = await context.readImage();
      if (!profile.vision && !localEvidence)
        localEvidence = await context.observeScene(signal);
      const content: Exclude<Message['content'], string | null> = [
        {
          type: 'text',
          text: json({
            original_request: context.goal.source,
            completion: context.goal.completion,
            task_list: planningGoal(context.goal),
            live: planningEvidence(context.live),
            local_visual_evidence: planningEvidence(localEvidence),
            image: frame?.metadata,
          }),
        },
      ];
      if (profile.vision && frame)
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${frame.bytes.toString('base64')}`,
          },
        });
      return [
        {
          role: 'system',
          content: `你是独立的任务列表最终复核模型。根据原始目标、每个stage的执行结果、Florence检查、当前持物状态和最新场景证据判断整个列表是否完成。
只提交submit_review：complete=所有目标有证据满足；repair=需要追加有限修复阶段；blocked=能力或场景条件不足；continue=已有待执行阶段应继续。不要重做已确认成功的阶段。图像只能支持可见事实，未知不能判定成功。repair动作同样必须带stage、expected_state、依赖、快慢环和Florence监督。`,
        },
        { role: 'user', content },
      ];
    },
    reviewSubmit,
    signal,
    (event) => context.record(event),
    (value) => {
      const review = reviewSchema.parse(value);
      if (review.verdict !== 'complete' && simplePhysicalCompletion(context.goal))
        return decisionSchema.parse({
          mode: 'simple',
          outcome: 'complete',
          message:
            '高级复核已读取执行结果；有效抓放均有物理成功和释放证据，未重复执行已完成物体。',
          actions: [],
          final_review: false,
          architecture: 'staged',
        });
      const parsed = decisionSchema.parse({
        mode: 'complex',
        outcome: review.verdict === 'repair' ? 'continue' : review.verdict,
        message: review.reason,
        actions: review.actions,
        plan_scope: review.plan_scope,
        queue_update: 'replace_pending',
        final_review: review.verdict === 'repair',
        architecture: 'staged',
      });
      return parsed.actions.length
        ? normalizeStages(
            parsed,
            context.settings.architecture?.stageRetryLimit ?? 2,
            context.goal.steps.length ? context.goal : undefined,
          )
        : parsed;
    },
  );
  return decision;
}

/** One Mastra decision cycle: a single fast route, then at most one advanced call. */
export async function runStagedPlanning(
  context: StagedPlanningContext,
  signal: AbortSignal,
): Promise<Decision> {
  const inputSchema = z.object({ request: z.string() });
  const routeStep = createStep({
    id: 'route-current-input',
    inputSchema,
    outputSchema: taskRouteSchema,
    execute: async () => routeTask(context, signal),
  });
  const decisionStep = createStep({
    id: 'resolve-route',
    inputSchema: taskRouteSchema,
    outputSchema: decisionSchema,
    execute: async ({ inputData: route }) => {
      await context.record({
        kind: 'task_route',
        route: route.disposition,
        target_goal_id: route.target_goal_id,
      });
      if (route.disposition === 'query' && route.query_kind === 'scene')
        return decisionSchema.parse({
          mode: 'simple',
          outcome: 'chat',
          actions: [],
          message: localSceneReply(await context.observeScene(signal)),
          evidence_reply: true,
          architecture: 'staged',
        });
      if (route.disposition === 'query' && route.query_kind === 'status') {
        const lists = activeLists(context.queue);
        return decisionSchema.parse({
          mode: 'simple',
          outcome: 'chat',
          actions: [],
          message: lists.length
            ? lists
                .map(
                  (list) =>
                    `列表${list.number ?? ''}“${list.summary || list.source}”${list.state}，已完成${list.completed}/${list.total}步`,
                )
                .join('；')
            : '当前没有活动任务列表。',
          evidence_reply: true,
          architecture: 'staged',
        });
      }
      if (route.disposition === 'no_action' || route.disposition === 'query')
        return decisionSchema.parse({
          mode: 'simple',
          outcome: 'chat',
          actions: [],
          message: '',
          silent: true,
          architecture: 'staged',
        });
      if (route.disposition === 'simple')
        for (const action of route.actions) {
          action.execution ??= { loop: 'fast_then_slow' };
          action.execution.max_attempts ??=
            context.settings.architecture?.stageRetryLimit ?? 2;
        }
      if (route.disposition === 'simple')
        return decisionSchema.parse({
          mode: 'simple',
          outcome: 'continue',
          summary: route.summary,
          completion: route.completion,
          actions: route.actions,
          plan_scope: 'complete',
          final_review: context.settings.architecture?.finalReview ?? true,
          architecture: 'staged',
        });
      return advancedPlan(context, route, signal);
    },
  });
  const workflow = createWorkflow({
    id: 'busagent-staged-task',
    inputSchema,
    outputSchema: decisionSchema,
  })
    .then(routeStep)
    .then(decisionStep)
    .commit();
  const run = await workflow.createRun({
    runId: `staged-${context.goal.id}-${context.goal.revision}`,
  });
  const result = await run.start({ inputData: { request: context.goal.source } });
  if (result.status !== 'success')
    throw result.status === 'failed'
      ? result.error
      : new Error(`阶段任务工作流未完成：${result.status}`);
  return decisionSchema.parse(result.result);
}
