import { complete, type Message, type Tool, type ModelAnswer } from './model-client.js';
import type { ModelProfile } from './model-config.js';

/** One request per eligible provider; failures never replay tool side effects. */
export async function routedCompletion(
  profiles: ModelProfile[],
  messages: Message[],
  tools: Tool[],
  signal: AbortSignal,
  record: (event: Record<string, unknown>) => Promise<void>,
  call: typeof complete = complete,
  failedProfiles = new Set<string>(),
): Promise<ModelAnswer> {
  const needsVision = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
  );
  let last: unknown = new Error('没有可用的模型。');
  for (const profile of profiles) {
    signal.throwIfAborted();
    if (failedProfiles.has(profile.id) || (needsVision && !profile.vision)) continue;
    const started = performance.now();
    try {
      return await call(profile, messages, tools, signal);
    } catch (error) {
      signal.throwIfAborted();
      last = error;
      failedProfiles.add(profile.id);
      await record({
        kind: 'provider_failure',
        model: profile.model,
        profile: profile.id,
        elapsed_ms: Math.round(performance.now() - started),
        reason: (error as Error).message,
      });
    }
  }
  throw last;
}
