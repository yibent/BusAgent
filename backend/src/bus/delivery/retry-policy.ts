import type { EventKind } from '../event-kind.js';
import type { RetryPolicy } from '../../package/package-config.js';

export interface EffectiveRetry {
  maxAttempts: number;
  backoffMs: number;
  deadLetter: boolean;
}

/**
 * Resolves the effective retry policy for a delivery (spec §10). The App can
 * only tighten the Package maximum; physical side-effect events never
 * auto-retry and always dead-letter for manual recovery.
 */
export function resolveRetry(
  packagePolicy: RetryPolicy,
  override: { maxAttempts: number } | undefined,
  eventKind: EventKind,
): EffectiveRetry {
  let maxAttempts = packagePolicy.max_attempts;
  if (override) {
    maxAttempts = Math.min(override.maxAttempts, packagePolicy.max_attempts);
  }
  if (eventKind === 'physical') {
    maxAttempts = 1;
    return { maxAttempts, backoffMs: packagePolicy.backoff_ms, deadLetter: true };
  }
  return {
    maxAttempts,
    backoffMs: packagePolicy.backoff_ms,
    deadLetter: packagePolicy.dead_letter,
  };
}
