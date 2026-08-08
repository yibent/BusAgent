import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisConnection } from './redis-connection.service.js';
import { queueName } from './queue-names.js';

/** Owns the BullMQ queues; one per app_id + agent_id (spec §10). */
@Injectable()
export class QueueManager implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly redis: RedisConnection) {}

  ensure(appId: string, agentId: string): Queue {
    const name = queueName(appId, agentId);
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.redis.client,
        defaultJobOptions: {
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  queueNames(): string[] {
    return [...this.queues.keys()];
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
