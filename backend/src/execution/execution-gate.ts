import type { RobotPlan } from '../apps/desktop-robot/instruction-types.js';

export interface ExecutionGrant {
  credential: string;
  laneKey: string;
}

/**
 * Fixed framework boundary between validated skill proposals and a device
 * adapter. This intentionally performs only small deterministic checks; the
 * robot controller remains responsible for real-time safety.
 */
export class ExecutionGate {
  static authorize(
    taskId: string,
    taskVersion: number,
    plan: RobotPlan,
    validationStatus: unknown,
  ): ExecutionGrant {
    if (validationStatus !== 'approved') {
      throw new Error('execution gate rejected a plan that was not validated');
    }
    if (plan.task_version !== taskVersion) {
      throw new Error('execution gate rejected a task-version mismatch');
    }
    return {
      credential: `gate:${taskId}:v${taskVersion}`,
      laneKey: 'arm-01',
    };
  }
}
