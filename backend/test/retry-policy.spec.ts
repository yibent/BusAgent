import { describe, expect, it } from 'vitest';
import { resolveRetry } from '../src/bus/delivery/retry-policy.js';

describe('resolveRetry', () => {
  it('applies the package policy when there is no App override', () => {
    expect(
      resolveRetry(
        { max_attempts: 3, backoff_ms: 1000, dead_letter: true },
        undefined,
        'normal',
      ),
    ).toEqual({ maxAttempts: 3, backoffMs: 1000, deadLetter: true });
  });

  it('only tightens with an App override', () => {
    expect(
      resolveRetry(
        { max_attempts: 3, backoff_ms: 1000, dead_letter: true },
        { maxAttempts: 2 },
        'normal',
      ),
    ).toEqual({ maxAttempts: 2, backoffMs: 1000, deadLetter: true });
  });

  it('never lets an App override exceed the package cap', () => {
    const effective = resolveRetry(
      { max_attempts: 3, backoff_ms: 1000, dead_letter: true },
      { maxAttempts: 5 },
      'normal',
    );
    expect(effective.maxAttempts).toBe(3);
  });

  it('physical side-effect events never auto-retry and always dead-letter', () => {
    expect(
      resolveRetry(
        { max_attempts: 3, backoff_ms: 1000, dead_letter: false },
        { maxAttempts: 2 },
        'physical',
      ),
    ).toEqual({ maxAttempts: 1, backoffMs: 1000, deadLetter: true });
  });
});
