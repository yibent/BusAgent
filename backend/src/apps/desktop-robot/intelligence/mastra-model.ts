import { estimateTokens } from '../../../modules/conversation/context-format.js';
import type {
  LanguageModelV2,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { complete, type Message, type Tool } from './model-client.js';
import { routedCompletion } from './model-routing.js';
import type { ModelProfile } from './model-config.js';

/** Transport adapter only. Mastra owns the agent loop, tool scheduling and memory. */
export function wireMessages(prompt: LanguageModelV2Prompt): Message[] {
  return prompt.flatMap((message): Message[] => {
    if (message.role === 'system')
      return [{ role: 'system', content: message.content }];
    if (message.role === 'tool')
      return message.content.map((part) => ({
        role: 'tool',
        tool_call_id: part.toolCallId,
        content:
          part.output.type === 'text' || part.output.type === 'error-text'
            ? part.output.value
            : JSON.stringify(part.output.value),
      }));
    const content: Exclude<Message['content'], string | null> = [];
    const calls: NonNullable<Message['tool_calls']> = [];
    for (const part of message.content) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text });
      if (part.type === 'file') {
        if (!part.mediaType.startsWith('image/'))
          throw new Error('Only image attachments are supported');
        const url =
          part.data instanceof URL
            ? part.data.href
            : `data:${part.mediaType};base64,${typeof part.data === 'string' ? part.data : Buffer.from(part.data).toString('base64')}`;
        content.push({ type: 'image_url', image_url: { url } });
      }
      if (part.type === 'tool-call')
        calls.push({
          id: part.toolCallId,
          type: 'function',
          function: { name: part.toolName, arguments: JSON.stringify(part.input) },
        });
    }
    return [
      {
        role: message.role,
        content: content.every((p) => p.type === 'text')
          ? content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
          : content,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
    ];
  });
}

export function mastraModel(
  profiles: ModelProfile[],
  signal: AbortSignal,
  record: (event: Record<string, unknown>) => Promise<void>,
  call = complete,
): LanguageModelV2 {
  const failed = new Set<string>();
  const generate: LanguageModelV2['doGenerate'] = async (options) => {
    const messages = wireMessages(options.prompt);
    const tools: Tool[] = (options.tools ?? []).flatMap((tool) =>
      tool.type === 'function'
        ? [
            {
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description ?? '',
                parameters: tool.inputSchema as Record<string, unknown>,
              },
            },
          ]
        : [],
    );
    await record({
      kind: 'context_budget',
      framework: 'mastra',
      text_tokens: estimateTokens(messages),
      tool_tokens: estimateTokens(tools),
      tool_count: tools.length,
    });
    const result = await routedCompletion(
      profiles,
      messages,
      tools,
      options.abortSignal ? AbortSignal.any([signal, options.abortSignal]) : signal,
      record,
      call,
      failed,
      {
        maxTokens: options.maxOutputTokens ?? 3500,
        ...(options.toolChoice
          ? {
              toolChoice:
                options.toolChoice.type === 'tool'
                  ? {
                      type: 'function',
                      function: { name: options.toolChoice.toolName },
                    }
                  : options.toolChoice.type,
            }
          : {}),
      },
    );
    await record({
      kind: 'model',
      framework: 'mastra',
      model: result.model,
      usage: result.usage,
      elapsed_ms: result.elapsed_ms,
      tool_calls: (result.message.tool_calls ?? []).map((tool) => tool.function.name),
      tool_call_count: result.message.tool_calls?.length ?? 0,
    });
    const content: Awaited<ReturnType<LanguageModelV2['doGenerate']>>['content'] = [];
    if (typeof result.message.content === 'string' && result.message.content)
      content.push({ type: 'text', text: result.message.content });
    for (const tool of result.message.tool_calls ?? [])
      content.push({
        type: 'tool-call',
        toolCallId: tool.id,
        toolName: tool.function.name,
        input: tool.function.arguments,
      });
    return {
      content,
      finishReason: result.message.tool_calls?.length ? 'tool-calls' : 'stop',
      warnings: [],
      usage: {
        inputTokens: result.usage.prompt_tokens,
        outputTokens: result.usage.completion_tokens,
        totalTokens: result.usage.total_tokens,
      },
    };
  };
  return {
    specificationVersion: 'v2',
    provider: 'busagent-gateway',
    modelId: profiles[0]!.model,
    supportedUrls: {},
    doGenerate: generate,
    doStream: async (options) => {
      const result = await generate(options);
      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            for (const part of result.content) {
              if (part.type === 'text') {
                controller.enqueue({ type: 'text-start', id: 'answer' });
                controller.enqueue({
                  type: 'text-delta',
                  id: 'answer',
                  delta: part.text,
                });
                controller.enqueue({ type: 'text-end', id: 'answer' });
              } else if (part.type === 'tool-call') controller.enqueue(part);
            }
            controller.enqueue({
              type: 'finish',
              finishReason: result.finishReason,
              usage: result.usage,
            });
            controller.close();
          },
        }),
      };
    },
  };
}
