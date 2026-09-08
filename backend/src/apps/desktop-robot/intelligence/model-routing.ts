import { complete, type Message, type Tool, type ModelAnswer } from './model-client.js';
import type { ModelProfile } from './model-config.js';
import { createHash } from 'node:crypto';

const cooling = new Map<string, { until: number; failures: number }>();
const providerKey = (p: ModelProfile) =>
  createHash('sha256').update(`${p.baseUrl}\n${p.model}\n${p.apiKey}`).digest('hex');
export function clearModelCooldowns() {
  cooling.clear();
}

/** One request per eligible provider; failures never replay tool side effects. */
export async function routedCompletion(
  profiles: ModelProfile[],
  messages: Message[],
  tools: Tool[],
  signal: AbortSignal,
  record: (event: Record<string, unknown>) => Promise<void>,
  call: typeof complete = complete,
  failedProfiles = new Set<string>(),
  options: Parameters<typeof complete>[4] = {},
): Promise<ModelAnswer> {
  const needsVision = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
  );
  let last: unknown = new Error('没有可用的模型。');
  for (const profile of profiles) {
    signal.throwIfAborted();
    if (failedProfiles.has(profile.id) || (needsVision && !profile.vision)) continue;
    const key = providerKey(profile);
    const health = cooling.get(key);
    if (profile.cooldownEnabled === false) cooling.delete(key);
    if (profile.cooldownEnabled !== false && health && health.until > Date.now()) {
      last = new Error(`模型 ${profile.model} 的接口暂时处于故障冷却期，请稍后重试。`);
      await record({
        kind: 'provider_cooldown',
        profile: profile.id,
        model: profile.model,
        retry_after_ms: health.until - Date.now(),
      });
      continue;
    }
    const started = performance.now();
    try {
      const answer = await call(profile, messages, tools, signal, options);
      cooling.delete(key);
      return answer;
    } catch (error) {
      signal.throwIfAborted();
      last = error;
      failedProfiles.add(profile.id);
      const failures = (health?.failures ?? 0) + 1;
      if (profile.cooldownEnabled !== false)
        cooling.set(key, {
          failures,
          until: Date.now() + Math.min(600000, failures * 120000),
        });
      if (cooling.size > 128) cooling.delete(cooling.keys().next().value!);
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
