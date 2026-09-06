import { markExecutionLoop } from '../../observability/execution-span.js';
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface QwenChatOptions {
  apiKey: string;
  url: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  temperature?: number;
  jsonOutput?: boolean;
  maxTokens?: number;
  reasoning?: 'none' | 'low';
}

export interface SseLineBatch {
  deltas: string[];
  done: boolean;
  rest: string;
}

/** Parses one SSE `data:` line from the OpenAI-compatible chat stream. */
export function contentDeltaFromSseData(data: string): string | undefined {
  const trimmed = data.trim();
  if (trimmed.length === 0 || trimmed === '[DONE]') {
    return undefined;
  }
  try {
    const json = JSON.parse(trimmed) as {
      choices?: Array<{ delta?: { content?: unknown } }>;
    };
    const content = json.choices?.[0]?.delta?.content;
    return typeof content === 'string' && content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

/** Splits a stream buffer into complete SSE lines and leftover text. */
export function takeSseLineBatch(buffer: string): SseLineBatch {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const deltas: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '[DONE]') {
      return { deltas, done: true, rest: '' };
    }
    const delta = contentDeltaFromSseData(payload);
    if (delta !== undefined) {
      deltas.push(delta);
    }
  }
  return { deltas, done: false, rest };
}

function asBytes(chunk: unknown): Uint8Array | undefined {
  return chunk instanceof Uint8Array ? chunk : undefined;
}

export async function* streamQwenChat(
  options: QwenChatOptions,
): AsyncGenerator<string> {
  markExecutionLoop('slow', options.model);
  const response = await fetch(options.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: true,
      enable_thinking: options.reasoning === 'low',
      ...(options.reasoning === 'low'
        ? { reasoning_effort: 'low', preserve_thinking: false }
        : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
      ...(options.jsonOutput ? { response_format: { type: 'json_object' } } : {}),
    }),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Qwen chat HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  if (response.body === null) {
    throw new Error('Qwen chat response had no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done === true) {
        break;
      }
      const chunk = asBytes(result.value as unknown);
      if (chunk === undefined) {
        continue;
      }
      buffer += decoder.decode(chunk, { stream: true });
      const batch = takeSseLineBatch(buffer);
      buffer = batch.rest;
      for (const delta of batch.deltas) {
        yield delta;
      }
      if (batch.done) {
        return;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const batch = takeSseLineBatch(`${buffer}\n`);
      for (const delta of batch.deltas) {
        yield delta;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
