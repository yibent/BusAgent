import type { Action, Goal, QueueStep, QueueState } from './types.js';
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const resultOf = (step: QueueStep) => {
  const wrapper = object(step.result);
  return object(wrapper.result ?? wrapper);
};

/** One cause-specific observation, carried by the same durable physical queue. */
export function recoveryObservation(
  goal: Goal,
  state: QueueState,
): (Action & { recovery: NonNullable<QueueStep['recovery']> }) | undefined {
  const parent = goal.steps.findLast((s) => s.result && !s.recovery);
  if (!parent || parent.state === 'unknown') return;
  const result = resultOf(parent);
  const code = object(result.failure).code;
  const root = parent.recovery_root ?? parent.id;
  const destination = object(parent.params.destination);
  const operation = object(result.operation);
  const held = object(state.scene.holding);
  if (
    parent.state === 'failed' &&
    held.verified === true &&
    ['NO_FREE_SPACE', 'NO_IK'].includes(String(code)) &&
    ['pick_place', 'place_held'].includes(parent.skill)
  ) {
    const key = `safe_stow:${root}`;
    if (goal.local_recoveries?.includes(key)) return;
    return {
      title: '将持物放到桌面空处后继续',
      skill: 'place_held',
      review_after: false,
      params: {
        destination: {
          label: 'table',
          selection: 'free_space',
          preference: 'nearest',
        },
        relation: 'on',
      },
      execution: {
        loop: 'fast_then_slow',
        max_attempts: 1,
        supervision: { kind: 'physical' },
      },
      recovery: { kind: 'safe_stow', parent_id: parent.id, key },
    };
  }
  if (
    parent.state === 'completed' &&
    goal.review_kind === 'verification' &&
    object(result.evaluation).physical_success === true &&
    typeof destination.cell_ref === 'string'
  ) {
    const ref = object(operation.destination).ref ?? destination.ref;
    if (typeof ref !== 'string') return;
    const key = `verify_cell:${root}`;
    if (goal.local_recoveries?.includes(key)) return;
    // The expected cell's stable ID is attached by the caller after reading its observation.
    return {
      title: '换视角确认已完成的放置',
      skill: 'perceive',
      review_after: false,
      params: {
        ref,
        inspect: 'grid',
        cameras: [ref.includes(':side_camera:') ? 'scene_camera' : 'side_camera'],
      },
      recovery: { kind: 'verify_cell', parent_id: parent.id, key },
    };
  }
  if (
    parent.state !== 'failed' ||
    !['TARGET_NOT_FOUND', 'REFERENCE_STALE', 'EMPTY_GRASP'].includes(String(code))
  )
    return;
  if (parent.params.orientation || destination.cell_ref) return;
  if (held.unknown === true || typeof held.verified !== 'boolean') return;
  const field = held.verified ? 'destination' : 'target';
  const target = parent.params[field];
  const selected = object(target);
  if (!target || !['grasp', 'pick_place', 'place_held'].includes(parent.skill)) return;
  const key = `relocalize:${root}:${field}`;
  if (goal.local_recoveries?.includes(key)) return;
  const ref = selected.ref;
  return {
    title: held.verified ? '保持持物，重新定位放置区域' : '重新定位抓取目标',
    skill: 'perceive',
    review_after: false,
    params: {
      selection: 'one',
      ...(typeof ref === 'string'
        ? {
            ref,
            cameras: [ref.includes(':side_camera:') ? 'scene_camera' : 'side_camera'],
          }
        : {
            scope: 'target',
            category: typeof target === 'string' ? target : selected.label,
            vision_mode: 'slow',
            slow_provider: 'sam3',
          }),
    },
    recovery: {
      kind: 'relocalize',
      parent_id: parent.id,
      key,
      field,
      ...(typeof object(result.vision).object_id === 'string'
        ? { object_id: String(object(result.vision).object_id) }
        : {}),
    },
  };
}

export function resolveRecovery(
  goal: Goal,
  child: QueueStep,
  state: QueueState,
  makeStep: (a: Action) => QueueStep,
): boolean {
  const recovery = child.recovery;
  if (!recovery) return false;
  const parent = goal.steps.find((s) => s.id === recovery.parent_id);
  const result = resultOf(child);
  const vision = object(result.vision);
  const recoveryHolding = object(result.holding);
  const gripperCleared =
    recoveryHolding.verified === false && result.held_object == null;
  if (
    parent &&
    recovery.kind === 'safe_stow' &&
    (child.state === 'completed' || gripperCleared)
  ) {
    if (child.state !== 'completed') child.state = 'superseded';
    parent.state = 'superseded';
    if (parent.stage) {
      goal.skipped_stages = [
        ...new Set([...(goal.skipped_stages ?? []), parent.stage.id]),
      ];
      goal.final_review = true;
    }
    goal.state = 'running';
    delete goal.review_kind;
    goal.review_reason = '';
    goal.message = gripperCleared
      ? '难件未完成装盘，但夹爪已清空；保留失败证据并继续其余独立阶段。'
      : '难件已安全放到桌面空处，继续执行其余独立阶段。';
    return true;
  }
  if (child.state === 'completed' && parent && recovery.kind === 'verify_cell') {
    const grid = object(result.geometry ?? vision.geometry);
    const cell = (Array.isArray(grid.cells) ? grid.cells : [])
      .map(object)
      .find((c) =>
        recovery.cell_id
          ? c.cell_id === recovery.cell_id
          : c.row === recovery.row && c.column === recovery.column,
      );
    if (cell?.occupancy === 'occupied') {
      goal.state = 'running';
      delete goal.review_kind;
      goal.review_reason = '';
      goal.message = '已从新视角确认原格位占用，继续剩余队列。';
      return true;
    }
  }
  if (child.state === 'completed' && parent && recovery.kind === 'relocalize') {
    const refs = (Array.isArray(vision.references) ? vision.references : [])
      .map(object)
      .filter((r) => r.kind === 'object');
    const identity = vision.object_id;
    const same = !recovery.object_id || recovery.object_id === identity;
    const confirmed =
      vision.semantic_status === 'detected' || !!(recovery.object_id && same);
    const identities = new Set(refs.map((r) => r.track_id ?? r.ref));
    if (refs.length && identities.size === 1 && same && confirmed) {
      const held = object(state.scene.holding);
      if (
        held.unknown === true ||
        typeof held.verified !== 'boolean' ||
        (recovery.field === 'target' && held.verified) ||
        (recovery.field === 'destination' && !held.verified)
      ) {
        goal.state = 'review';
        goal.review_kind = 'failure';
        goal.review_reason = '恢复观察期间持物状态改变，需要核对。';
        return true;
      }
      const params = structuredClone(parent.params);
      params[recovery.field!] = {
        ...object(params[recovery.field!]),
        ref: refs[0]!.ref,
        label: refs[0]!.label,
      };
      const skill = held.verified ? 'place_held' : parent.skill;
      if (skill === 'place_held') delete params.target;
      const resumed = makeStep({
        title: parent.title,
        skill,
        params,
        review_after: parent.review_after,
      });
      resumed.recovery_root = parent.recovery_root ?? parent.id;
      parent.state = 'superseded';
      // Resume before unrelated pending actions, preserving their existing IDs.
      const next = goal.steps.findIndex((s) => s.state === 'pending');
      goal.steps.splice(next < 0 ? goal.steps.length : next, 0, resumed);
      goal.state = 'running';
      delete goal.review_kind;
      goal.review_reason = '';
      goal.message = '已获得新的目标证据，从当前持物状态恢复执行。';
      return true;
    }
  }
  goal.state = 'review';
  goal.review_kind = recovery.kind === 'verify_cell' ? 'verification' : 'failure';
  goal.review_reason =
    '本地补充观察未能解决原问题，已保留原动作和新证据；不重复相同恢复。';
  return true;
}
