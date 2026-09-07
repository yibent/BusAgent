import { completionsUrl, type ModelProfile } from './model-config.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content:
    | string
    | null
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
};
export interface Tool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ModelAnswer {
  message: Message;
  usage: Record<string, number>;
  elapsed_ms: number;
  model: string;
}

/** Provider parameters are isolated here; credentials and request bodies are never logged. */
export async function complete(
  profile: ModelProfile,
  messages: Message[],
  tools: Tool[],
  signal?: AbortSignal,
): Promise<ModelAnswer> {
  const started = performance.now();
  // GLM-5.3 only supports enabled thinking; use its budget control for speed.
  // https://docs.z.ai/guides/vlm/glm-5.3-flash
  const glmThinkingRequired =
    profile.provider === 'glm' && /^glm-5\.3(?:-|$)/i.test(profile.model);
  const response = await fetch(completionsUrl(profile.baseUrl), {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: profile.model,
      messages,
      stream: false,
      max_tokens: 6000,
      ...(tools.length
        ? { tools, tool_choice: 'auto', parallel_tool_calls: false }
        : {}),
      ...(profile.provider === 'qwen' ? { enable_thinking: profile.thinking } : {}),
      ...(profile.provider === 'glm'
        ? glmThinkingRequired
          ? {
              thinking: { type: 'enabled', clear_thinking: false },
              reasoning_effort: profile.reasoningEffort ?? 'low',
              temperature: 1,
              top_p: 0.95,
            }
          : { thinking: { type: profile.thinking ? 'enabled' : 'disabled' } }
        : {}),
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(profile.timeoutMs ?? 20000)])
      : AbortSignal.timeout(profile.timeoutMs ?? 20000),
  });
  if (!response.ok)
    throw new Error(
      `模型 ${profile.model} 请求失败（HTTP ${response.status}），请检查地址、模型权限和账户状态。`,
    );
  const result = (await response.json()) as {
    choices?: Array<{ message?: Message }>;
    usage?: Record<string, number>;
  };
  const message = result.choices?.[0]?.message;
  if (!message || (!message.content && !message.tool_calls?.length))
    throw new Error('模型返回了空响应。');
  return {
    message,
    usage: result.usage ?? {},
    elapsed_ms: Math.round(performance.now() - started),
    model: profile.model,
  };
}
