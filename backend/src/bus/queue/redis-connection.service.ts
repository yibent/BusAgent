import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { HostConfig } from '../../config/host-config.js';

/**
 * Shared Redis connection for BullMQ queues and workers (spec §10). Redis holds
 * short-lived queue state only; MySQL is the source of truth for recovery.
 */
@Injectable()
export class RedisConnection implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: HostConfig) {
    this.client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
