/**
 * In-process delivery queue: one per app_id + agent_id.
 *
 * Replaces BullMQ/Redis. Jobs live in memory while the host is up; MySQL
 * delivery rows remain the source of truth for restart recovery.
 *
 * Semantics kept from the previous BullMQ worker:
 * - lower `priority` runs first (then FIFO);
 * - `concurrency` caps in-flight processors per queue;
 * - a thrown processor error retries up to `maxAttempts` with `backoffMs`;
 * - duplicate `job.id` is ignored while the job is still in this queue.
 */

export interface QueueJob<T> {
  readonly id: string;
  readonly data: T;
  /** Attempts already completed (0 on the first run). Incremented after a throw. */
  attemptsMade: number;
  readonly maxAttempts: number;
  readonly priority: number;
  readonly backoffMs: number;
}

interface Waiting<T> {
  job: QueueJob<T>;
  seq: number;
}

export type QueueProcessor<T> = (job: QueueJob<T>) => Promise<void>;
export type QueueFailedHandler<T> = (job: QueueJob<T>, error: Error) => Promise<void>;

export class InProcessQueue<T> {
  private waiting: Waiting<T>[] = [];
  private readonly delayed = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly known = new Set<string>();
  private processor: QueueProcessor<T> | undefined;
  private onFailed: QueueFailedHandler<T> | undefined;
  private active = 0;
  private seq = 0;
  private closed = false;
  private readonly idleWaiters: Array<() => void> = [];
  private readonly drainWaiters: Array<() => void> = [];

  constructor(
    readonly name: string,
    readonly concurrency: number,
  ) {}

  setProcessor(processor: QueueProcessor<T>, onFailed?: QueueFailedHandler<T>): void {
    this.processor = processor;
    this.onFailed = onFailed;
    this.pump();
  }

  /**
   * Enqueue a job. Returns false when the queue is closed or the id is already
   * waiting, delayed, or in flight.
   */
  enqueue(job: QueueJob<T>, delayMs = 0): boolean {
    if (this.closed || this.known.has(job.id)) {
      return false;
    }
    this.known.add(job.id);
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this.delayed.delete(job.id);
        this.pushWaiting(job);
        this.pump();
      }, delayMs);
      this.delayed.set(job.id, timer);
      return true;
    }
    this.pushWaiting(job);
    this.pump();
    return true;
  }

  has(id: string): boolean {
    return this.known.has(id);
  }

  /** Resolves when nothing is waiting, delayed, or in flight. */
  idle(): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /**
   * Stop accepting work, drop waiting/delayed jobs (they remain in MySQL for
   * recovery), and wait for in-flight processors to finish.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const [id, timer] of this.delayed) {
      clearTimeout(timer);
      this.known.delete(id);
    }
    this.delayed.clear();
    for (const item of this.waiting) {
      this.known.delete(item.job.id);
    }
    this.waiting = [];
    if (this.active === 0) {
      this.notifyIdle();
      return;
    }
    await new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  private pushWaiting(job: QueueJob<T>): void {
    this.waiting.push({ job, seq: ++this.seq });
    this.waiting.sort((a, b) => a.job.priority - b.job.priority || a.seq - b.seq);
  }

  private pump(): void {
    if (this.closed || this.processor === undefined) {
      this.notifyIdle();
      return;
    }
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next === undefined) {
        break;
      }
      this.active += 1;
      void this.run(next.job);
    }
    this.notifyIdle();
  }

  private async run(job: QueueJob<T>): Promise<void> {
    try {
      await this.processor!(job);
      this.release(job.id);
    } catch (error) {
      job.attemptsMade += 1;
      try {
        await this.onFailed?.(job, error as Error);
      } catch {
        // Recording failures must not hide the retry decision.
      }
      this.release(job.id);
      if (!this.closed && job.attemptsMade < job.maxAttempts) {
        this.enqueue(job, job.backoffMs);
      }
    } finally {
      this.active -= 1;
      this.pump();
      if (this.closed && this.active === 0) {
        const waiters = this.drainWaiters.splice(0);
        for (const resolve of waiters) {
          resolve();
        }
      }
    }
  }

  private release(id: string): void {
    this.known.delete(id);
  }

  private isIdle(): boolean {
    return this.active === 0 && this.waiting.length === 0 && this.delayed.size === 0;
  }

  private notifyIdle(): void {
    if (!this.isIdle()) {
      return;
    }
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }
}
