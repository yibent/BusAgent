import { Injectable } from '@nestjs/common';

/** Default per-task derivation/event budget (spec §12 check #4). */
const DEFAULT_TASK_EVENT_BUDGET = 64;

/**
 * Tracks how many events a single task has already spawned. When the budget is
 * exceeded, further routing for that task is refused to stop runaway derivation.
 */
@Injectable()
export class TaskBudgetTracker {
  private readonly counts = new Map<string, number>();

  allow(taskId: string): boolean {
    const current = this.counts.get(taskId) ?? 0;
    if (current >= DEFAULT_TASK_EVENT_BUDGET) {
      return false;
    }
    this.counts.set(taskId, current + 1);
    return true;
  }
}
