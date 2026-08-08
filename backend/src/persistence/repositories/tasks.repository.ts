import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseConnection } from '../db/client.js';
import { tasks } from '../db/schema.js';
import { toMysqlDatetime } from '../db/mysql-datetime.js';

export type TaskState = 'active' | 'cancelled' | 'completed';

export interface TaskRecord {
  taskId: string;
  appId: string;
  currentVersion: number;
  state: TaskState;
}

@Injectable()
export class TasksRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async get(taskId: string): Promise<TaskRecord | null> {
    const rows = await this.db.db
      .select()
      .from(tasks)
      .where(eq(tasks.task_id, taskId))
      .limit(1)
      .execute();
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      taskId: row.task_id,
      appId: row.app_id,
      currentVersion: row.current_version,
      state: row.state as TaskState,
    };
  }

  async create(
    taskId: string,
    appId: string,
    version: number,
    nowIso: string,
  ): Promise<void> {
    try {
      await this.db.db
        .insert(tasks)
        .values({
          task_id: taskId,
          app_id: appId,
          current_version: version,
          state: 'active',
          created_at: toMysqlDatetime(nowIso),
          updated_at: toMysqlDatetime(nowIso),
        })
        .execute();
    } catch (error) {
      // Concurrent first events for the same brand-new task can both see
      // "no row" and race on the primary key; the loser is a benign no-op
      // because the winning row already carries the requested version.
      if ((error as { errno?: number }).errno === 1062) {
        return;
      }
      throw error;
    }
  }

  async advanceVersion(taskId: string, version: number, nowIso: string): Promise<void> {
    await this.db.db
      .update(tasks)
      .set({ current_version: version, updated_at: toMysqlDatetime(nowIso) })
      .where(eq(tasks.task_id, taskId))
      .execute();
  }

  async setState(taskId: string, state: TaskState, nowIso: string): Promise<void> {
    await this.db.db
      .update(tasks)
      .set({ state, updated_at: toMysqlDatetime(nowIso) })
      .where(eq(tasks.task_id, taskId))
      .execute();
  }
}
