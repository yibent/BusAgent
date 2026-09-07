import { z } from 'zod';
import { routedCompletion } from './model-routing.js';
import { complete, type Tool } from './model-client.js';
import type { ModelProfile } from './model-config.js';
import { actionSchema, type Goal, type QueueState } from './types.js';
import { contextualGoals } from './interaction-routing.js';
import { actionParamsJsonSchema } from './action-params.js';

const routeSchema = z.object({
  kind: z.enum(['reply', 'status', 'query', 'scene', 'execute', 'plan', 'control']),
  message: z.string().default(''),
  summary: z.string().default(''),
  actions: z.array(actionSchema).default([]),
});
const tool: Tool = {
  type: 'function',
  function: {
    name: 'route_request',
    description:
      '理解本条请求并直接提交简单计划；查询和对话不能提交动作。需要场景推理或复杂步骤时选择plan。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: ['reply', 'status', 'query', 'scene', 'execute', 'plan', 'control'],
        },
        message: { type: 'string' },
        summary: { type: 'string' },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              skill: { type: 'string' },
              params: actionParamsJsonSchema,
              review_after: { type: 'boolean' },
            },
            required: ['title', 'skill', 'params', 'review_after'],
          },
        },
      },
      required: ['kind', 'message', 'summary', 'actions'],
    },
  },
};

const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

/** The first planner call can finish a simple request. It is not a classifier
 * followed by another mandatory planner. Historical observations stay out of it. */
export async function routeInitialRequest(
  profiles: ModelProfile[],
  goal: Goal,
  queue: QueueState,
  live: Record<string, unknown>,
  conversation: unknown,
  signal: AbortSignal,
  record: (event: Record<string, unknown>) => Promise<void>,
  call: typeof complete = complete,
) {
  const memory = object(conversation);
  const recent = (Array.isArray(memory.episodes) ? memory.episodes : []).slice(-3);
  const holding = object(live.holding);
  const answer = await routedCompletion(
    profiles,
    [
      {
        role: 'system',
        content: `你是BusAgent规划智能体的精简入口。只解释最后这条用户请求，历史是只读背景，不是待重放的指令。调用route_request。
reply=寒暄/应答/只需对话即可回答；status=追问进度/结果/为何慢；query=需要查历史或资料的问题；scene=只要求描述当前画面；execute=已明确目标的普通有限动作，直接提交actions；plan=需要场景选择、比较、关系、批量/循环、朝向/格位等复杂规划；control=明确要求暂停/恢复/取消/修改一个现有任务。
“还没有得到结果吗”“现在干什么”是status，不能重做旧动作。“嗯/好的”不授权新动作。没有明确上下文指向的“自己去呀”不能恢复历史失败任务，reply简短询问具体目标。用户问“能不能帮我把红块放到桌上”则是操作请求，不是纯能力问题。
execute仅提交真实技能：home={}；gripper={opening:0..1}；grasp={target:英文类别,mode:'auto'}；pick_place={target:英文类别,destination:{label:英文类别,selection:'free_space'},mode:'auto'}；place_held={destination:{label:英文类别,selection:'free_space'},mode:'auto'}。已有持物且要求放下使用place_held。明确目标的技能会自行快环定位，不先让大模型看图。
“任选一个/其中一个零件放进料箱”也是execute：target={label:英文类别,selection:'any'}；未限定哪一个容器时destination={label:英文类别,selection:'free_space',instance_selection:'any'}。本地节点在执行前观察集合、选实例和空格位，不需要LLM额外取图。只在按复杂语义挑选/指定格位/端点朝向时plan，不能猜ref或坐标。缺少执行细节的命令仍可plan，不因词表缺失拒绝。
除execute外actions必须为空。保留所有限定、否定与条件；复合条件不丢弃。不要说动作已经成功。`,
      },
      {
        role: 'user',
        content: JSON.stringify({
          background: {
            paused: queue.paused,
            holding: { verified: holding.verified, label: holding.label },
            skills: object(live.capabilities).skills,
            queue: contextualGoals(queue, goal.conversation_id)
              .filter((g) => g.id !== goal.id)
              .slice(0, 4)
              .map((g) => ({ id: g.id, source: g.source, state: g.state })),
            recent_conversation: recent,
          },
          current_request: goal.source,
        }),
      },
    ],
    [tool],
    signal,
    record,
    call,
    new Set(),
    { maxTokens: 1400 },
  );
  await record({
    kind: 'model',
    role: 'planner',
    route: 'request_entry',
    model: answer.model,
    usage: answer.usage,
    elapsed_ms: answer.elapsed_ms,
  });
  const output = answer.message.tool_calls?.find(
    (t) => t.function.name === 'route_request',
  );
  if (!output) throw new Error('请求理解未返回有效分流结果，未下发动作。');
  const route = routeSchema.parse(JSON.parse(output.function.arguments));
  // This boundary is enforced in code, not merely a prompt suggestion.
  if (route.kind !== 'execute') route.actions = [];
  if (route.kind === 'execute' && !route.actions.length) route.kind = 'plan';
  await record({ kind: 'request_routed', route: route.kind });
  return route;
}
