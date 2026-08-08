import { Injectable } from '@nestjs/common';
import { TasksRepository } from '../../persistence/repositories/tasks.repository.js';
import { Clock } from '../../common/clock.js';

export type TaskVersionVerdict = 'current' | 'stale' | 'cancelled' | 'new';

/**
 * Task state checks (spec §10, §14): stale results never advance the current
 * task, and deliveries re-check task state before each attempt so cancelled
 * tasks are not retried.
 */
@Injectable()
export class TaskService {
  constructor(
    private readonly repo: TasksRepository,
    private readonly clock: Clock,
  ) {}

  async checkVersion(taskId: string, taskVersion: number): Promise<TaskVersionVerdict> {
    const task = await this.repo.get(taskId);
    if (!task) {
      return 'new';
    }
    if (task.state === 'cancelled') {
      return 'cancelled';
    }
    if (taskVersion < task.currentVersion) {
      return 'stale';
    }
    return 'current';
  }

  async ensureTask(taskId: string, appId: string, taskVersion: number): Promise<void> {
    const now = this.clock.now();
    const task = await this.repo.get(taskId);
    if (!task) {
      await this.repo.create(taskId, appId, taskVersion, now);
      return;
    }
    if (taskVersion > task.currentVersion) {
      await this.repo.advanceVersion(taskId, taskVersion, now);
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.repo.setState(taskId, 'cancelled', this.clock.now());
  }
}
