import { afterEach, describe, expect, it, vi } from 'vitest';
import { InProcessQueue, type QueueJob } from '../src/bus/queue/in-process-queue.js';

function job(id: string, data: string, overrides: Partial<QueueJob<string>> = {}): QueueJob<string> {
  return {
    id,
    data,
    attemptsMade: 0,
    maxAttempts: 1,
    priority: 5,
    backoffMs: 0,
    ...overrides,
  };
}

describe('InProcessQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs jobs in priority order, then FIFO', async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new InProcessQueue<string>('q', 1);
    queue.setProcessor(async (item) => {
      if (item.data === 'block') {
        await gate;
      }
      seen.push(item.data);
    });
    queue.enqueue(job('block', 'block', { priority: 5 }));
    await Promise.resolve();
    queue.enqueue(job('low', 'low', { priority: 9 }));
    queue.enqueue(job('high', 'high', { priority: 1 }));
    queue.enqueue(job('high-later', 'high-later', { priority: 1 }));
    release();
    await queue.idle();
    expect(seen).toEqual(['block', 'high', 'high-later', 'low']);
    await queue.close();
  });

  it('caps in-flight work at the concurrency limit', async () => {
    let inflight = 0;
    let peak = 0;
    const queue = new InProcessQueue<string>('q', 2);
    queue.setProcessor(async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inflight -= 1;
    });
    queue.enqueue(job('a', 'a'));
    queue.enqueue(job('b', 'b'));
    queue.enqueue(job('c', 'c'));
    await queue.idle();
    expect(peak).toBe(2);
    await queue.close();
  });

  it('retries a thrown job up to maxAttempts with backoff', async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const queue = new InProcessQueue<string>('q', 1);
    queue.setProcessor((item) => {
      attempts.push(item.attemptsMade);
      if (item.attemptsMade < 2) {
        return Promise.reject(new Error('fail'));
      }
      return Promise.resolve();
    });
    queue.enqueue(job('r', 'r', { maxAttempts: 3, backoffMs: 50 }));
    await Promise.resolve();
    expect(attempts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(50);
    expect(attempts).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(50);
    expect(attempts).toEqual([0, 1, 2]);
    await queue.idle();
    await queue.close();
  });

  it('does not retry after maxAttempts', async () => {
    const seen: number[] = [];
    const failures: number[] = [];
    const queue = new InProcessQueue<string>('q', 1);
    queue.setProcessor(
      (item) => {
        seen.push(item.attemptsMade);
        return Promise.reject(new Error('always'));
      },
      (item) => {
        failures.push(item.attemptsMade);
        return Promise.resolve();
      },
    );
    queue.enqueue(job('x', 'x', { maxAttempts: 2, backoffMs: 0 }));
    await queue.idle();
    expect(seen).toEqual([0, 1]);
    expect(failures).toEqual([1, 2]);
    await queue.close();
  });

  it('ignores a duplicate job id while the original is still queued', async () => {
    const seen: string[] = [];
    const queue = new InProcessQueue<string>('q', 1);
    queue.setProcessor((item) => {
      seen.push(item.data);
      return Promise.resolve();
    });
    expect(queue.enqueue(job('same', 'first'))).toBe(true);
    expect(queue.enqueue(job('same', 'second'))).toBe(false);
    await queue.idle();
    expect(seen).toEqual(['first']);
    await queue.close();
  });

  it('delays a job until delayMs has elapsed', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const queue = new InProcessQueue<string>('q', 1);
    queue.setProcessor((item) => {
      seen.push(item.data);
      return Promise.resolve();
    });
    queue.enqueue(job('d', 'delayed'), 100);
    await Promise.resolve();
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(99);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual(['delayed']);
    await queue.close();
  });

  it('drops waiting jobs on close and waits for in-flight work', async () => {
    let finished = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new InProcessQueue<string>('q', 1);
    queue.setProcessor(async (item) => {
      if (item.data === 'active') {
        await gate;
        finished = true;
      }
    });
    queue.enqueue(job('active', 'active'));
    await Promise.resolve();
    queue.enqueue(job('waiting', 'waiting'));
    const closing = queue.close();
    release();
    await closing;
    expect(finished).toBe(true);
    expect(queue.has('waiting')).toBe(false);
  });
});
