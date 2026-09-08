import { completionsUrl, type ModelProfile } from './model-config.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  [key: string]: unknown;
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
  first_token_ms?: number;
  model: string;
}

type CompletionPayload = {
  choices?: Array<{
    message?: Message;
    delta?: Partial<Message> & {
      tool_calls?: Array<
        Partial<ToolCall> & {
          index?: number;
          function?: { name?: string; arguments?: string };
        }
      >;
    };
  }>;
  usage?: Record<string, number>;
};

function answerFromJson(
  result: CompletionPayload,
  profile: ModelProfile,
  started: number,
): ModelAnswer {
  const message = result.choices?.[0]?.message;
  if (!message || (!message.content && !message.tool_calls?.length))
    throw new Error('模型返回了空响应。');
  return {
    message,
    usage: result.usage ?? {},
    elapsed_ms: Math.round(performance.now() - started),
    first_token_ms: Math.round(performance.now() - started),
    model: profile.model,
  };
}

/** Parse OpenAI-compatible SSE while preserving streamed tool arguments. */
async function answerFromStream(
  response: Response,
  profile: ModelProfile,
  started: number,
  onFirstToken: () => void,
): Promise<ModelAnswer> {
  if (!response.body) throw new Error('模型流式响应没有正文。');
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: Record<string, number> = {};
  let firstTokenMs: number | undefined;
  const calls = new Map<number, ToolCall>();
  const finishReasons = new Set<string>();
  const observedFields = new Set<string>();

  const mergeCalls = (
    fragments: Array<
      Partial<ToolCall> & {
        index?: number;
        function?: {
          name?: string;
          arguments?: string;
          parameters?: unknown;
        };
      }
    >,
  ) => {
    for (const fragment of fragments) {
      const index = fragment.index ?? calls.size;
      const current = calls.get(index) ?? {
        id: fragment.id ?? `call-${index}`,
        type: 'function',
        function: { name: '', arguments: '' },
      };
      if (fragment.id) current.id = fragment.id;
      if (fragment.type) current.type = fragment.type;
      for (const [key, value] of Object.entries(fragment))
        if (!['index', 'id', 'type', 'function'].includes(key)) current[key] = value;
      if (fragment.function?.name) current.function.name += fragment.function.name;
      if (fragment.function?.arguments)
        current.function.arguments += fragment.function.arguments;
      else if (fragment.function?.parameters !== undefined)
        current.function.arguments +=
          typeof fragment.function.parameters === 'string'
            ? fragment.function.parameters
            : JSON.stringify(fragment.function.parameters);
      calls.set(index, current);
    }
  };

  const accept = (payload: string) => {
    if (!payload || payload === '[DONE]') return;
    const chunk = JSON.parse(payload) as CompletionPayload;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (
      typeof (choice as { finish_reason?: unknown } | undefined)?.finish_reason ===
      'string'
    )
      finishReasons.add(String((choice as { finish_reason?: unknown }).finish_reason));
    const message = choice?.message;
    if (message) {
      observedFields.add('message');
      if (typeof message.content === 'string') content += message.content;
      mergeCalls(message.tool_calls ?? []);
    }
    const delta = choice?.delta;
    if (!delta) return;
    for (const field of Object.keys(delta)) observedFields.add(`delta.${field}`);
    if (typeof delta.content === 'string') content += delta.content;
    mergeCalls(delta.tool_calls ?? []);
    if (
      firstTokenMs === undefined &&
      (content.length > 0 ||
        [...calls.values()].some(
          (call) => call.function.name.length > 0 || call.function.arguments.length > 0,
        ))
    ) {
      firstTokenMs = Math.round(performance.now() - started);
      onFirstToken();
    }
  };

  const flushFrames = (final = false) => {
    buffer = buffer.replaceAll('\r\n', '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split('\n'))
        if (line.startsWith('data:')) accept(line.slice(5).trim());
      boundary = buffer.indexOf('\n\n');
    }
    if (final && buffer.trim())
      for (const line of buffer.split('\n'))
        if (line.startsWith('data:')) accept(line.slice(5).trim());
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    flushFrames(done);
    if (done) break;
  }
  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call);
  if (!content && !toolCalls.length)
    throw new Error(
      `模型返回了空流式响应（finish=${[...finishReasons].join(',') || 'unknown'}；fields=${[...observedFields].join(',') || 'none'}）。`,
    );
  return {
    message: {
      role: 'assistant',
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    usage,
    elapsed_ms: Math.round(performance.now() - started),
    ...(firstTokenMs === undefined ? {} : { first_token_ms: firstTokenMs }),
    model: profile.model,
  };
}

/** Provider parameters are isolated here; credentials and request bodies are never logged. */
export async function complete(
  profile: ModelProfile,
  messages: Message[],
  tools: Tool[],
  signal?: AbortSignal,
  options: {
    maxTokens?: number;
    toolChoice?:
      | 'auto'
      | 'none'
      | 'required'
      | { type: 'function'; function: { name: string } };
  } = {},
): Promise<ModelAnswer> {
  const started = performance.now();
  const firstToken = new AbortController();
  const firstTokenTimeout = setTimeout(
    () => firstToken.abort(new Error('模型首字响应超时。')),
    profile.firstTokenTimeoutMs ?? 8000,
  );
  // GLM-5.3 only supports enabled thinking; use its budget control for speed.
  // https://docs.z.ai/guides/vlm/glm-5.3-flash
  const glmThinkingRequired =
    profile.provider === 'glm' && /^glm-5\.3(?:-|$)/i.test(profile.model);
  try {
    const requestSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(profile.timeoutMs ?? 20000),
      firstToken.signal,
    ]);
    const response = await fetch(completionsUrl(profile.baseUrl), {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: profile.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: options.maxTokens ?? 6000,
        ...(tools.length
          ? {
              tools,
              tool_choice: options.toolChoice ?? 'auto',
              parallel_tool_calls: true,
            }
          : {}),
        ...(profile.provider === 'deepseek'
          ? { thinking: { type: profile.thinking ? 'enabled' : 'disabled' } }
          : {}),
        ...(profile.provider === 'qwen' ? { enable_thinking: profile.thinking } : {}),
        ...(profile.provider === 'gemini'
          ? {
              reasoning_effort:
                profile.reasoningEffort === 'max'
                  ? 'high'
                  : (profile.reasoningEffort ?? 'low'),
            }
          : {}),
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
      signal: requestSignal,
    });
    if (!response.ok)
      throw new Error(
        `模型 ${profile.model} 请求失败（HTTP ${response.status}），请检查地址、模型权限和账户状态。`,
      );
    if (response.headers.get('content-type')?.includes('text/event-stream'))
      return await answerFromStream(response, profile, started, () =>
        clearTimeout(firstTokenTimeout),
      );
    const result = (await response.json()) as CompletionPayload;
    clearTimeout(firstTokenTimeout);
    return answerFromJson(result, profile, started);
  } catch (error) {
    if (
      firstToken.signal.aborted &&
      firstToken.signal.reason instanceof Error &&
      firstToken.signal.reason.message === '模型首字响应超时。'
    )
      throw firstToken.signal.reason;
    throw error;
  } finally {
    clearTimeout(firstTokenTimeout);
  }
}
