import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InProcessQueue, type QueueJob } from './in-process-queue.js';
import { queueName } from './queue-names.js';

export interface DeliveryJobData {
  eventId: string;
  agentId: string;
  appId: string;
}

export type DeliveryJob = QueueJob<DeliveryJobData>;

const DEFAULT_CONCURRENCY = 4;

/** Owns the in-process queues; one per app_id + agent_id (spec §10). */
@Injectable()
export class QueueManager implements OnModuleDestroy {
  private readonly queues = new Map<string, InProcessQueue<DeliveryJobData>>();

  ensure(
    appId: string,
    agentId: string,
    concurrency = DEFAULT_CONCURRENCY,
  ): InProcessQueue<DeliveryJobData> {
    const name = queueName(appId, agentId);
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new InProcessQueue(name, Math.max(1, concurrency));
      this.queues.set(name, queue);
    }
    return queue;
  }

  async closeAll(): Promise<void> {
    const closers = [...this.queues.values()].map((q) => q.close());
    await Promise.allSettled(closers);
    this.queues.clear();
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeAll();
  }
}
