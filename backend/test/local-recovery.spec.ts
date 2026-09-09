import { describe, expect, it } from 'vitest';
import {
  recoveryObservation,
  resolveRecovery,
} from '../src/apps/desktop-robot/intelligence/local-recovery.js';
import {
  emptyQueue,
  type Action,
  type Goal,
  type QueueStep,
} from '../src/apps/desktop-robot/intelligence/types.js';
const makeStep = (action: Action): QueueStep => ({
  ...action,
  id: 'resumed',
  state: 'pending',
  task_id: 'task-resumed',
  command_id: 'command-resumed',
  attempt: 1,
});
const setup = () => {
  const first: QueueStep = {
    ...makeStep({
      title: '取零件',
      skill: 'grasp',
      params: { target: 'part' },
      review_after: false,
    }),
    id: 'parent',
    state: 'failed',
    result: { failure: { code: 'EMPTY_GRASP' }, holding: { verified: false } },
  };
  const pending = {
    ...makeStep({
      title: '放下',
      skill: 'place_held',
      params: { destination: { label: 'table' } },
      review_after: false,
    }),
    id: 'original-place',
  };
  const goal = {
    id: 'goal',
    state: 'review',
    review_kind: 'failure',
    steps: [first, pending],
  } as Goal;
  const state = emptyQueue();
  state.goals = [goal];
  state.scene.holding = { verified: false };
  return { goal, state, first, pending };
};

describe('cause-specific local recovery', () => {
  it('relocalizes once, changes target evidence and preserves the remaining queue', () => {
    const { goal, state, first, pending } = setup();
    const proposal = recoveryObservation(goal, state)!;
    expect(proposal.params).toMatchObject({ category: 'part', selection: 'one' });
    goal.local_recoveries = [proposal.recovery.key];
    const observed: QueueStep = {
      ...makeStep(proposal),
      recovery: proposal.recovery,
      state: 'completed',
      result: {
        vision: {
          semantic_status: 'detected',
          object_id: 'object:1',
          references: [
            { kind: 'object', ref: 'fresh-ref', label: 'part', track_id: 'object:1' },
          ],
        },
      },
    };
    goal.steps.splice(1, 0, observed);
    expect(resolveRecovery(goal, observed, state, makeStep)).toBe(true);
    expect(first.state).toBe('superseded');
    expect(goal.steps.find((s) => s.state === 'pending')?.params.target).toEqual({
      ref: 'fresh-ref',
      label: 'part',
    });
    expect(goal.steps.at(-1)).toBe(pending);
    const retry = goal.steps.find((s) => s.state === 'pending')!;
    retry.state = 'failed';
    retry.result = first.result!;
    expect(recoveryObservation(goal, state)).toBeUndefined();
  });

  it('does not resume on a different identity, unknown grip state or missing semantic evidence', () => {
    const { goal, state, first } = setup();
    const proposal = recoveryObservation(goal, state)!;
    const child = {
      ...makeStep(proposal),
      state: 'completed',
      recovery: { ...proposal.recovery, object_id: 'object:expected' },
      result: {
        vision: {
          semantic_status: 'detected',
          object_id: 'object:wrong',
          references: [{ kind: 'object', ref: 'other-ref', track_id: 'object:wrong' }],
        },
      },
    } as QueueStep;
    resolveRecovery(goal, child, state, makeStep);
    expect(first.state).toBe('failed');
    expect(goal.state).toBe('review');
    state.scene.holding = { unknown: true, verified: false };
    expect(recoveryObservation(goal, state)).toBeUndefined();
  });

  it('confirms a released part by the original cell identity without replaying placement', () => {
    const { goal, state, first } = setup();
    first.skill = 'pick_place';
    first.state = 'completed';
    first.params.destination = { ref: 'bin-ref', cell_ref: 'old-cell-ref' };
    first.result = {
      ok: true,
      evaluation: { physical_success: true },
      review_required: true,
    };
    goal.review_kind = 'verification';
    const proposal = recoveryObservation(goal, state)!;
    proposal.recovery.cell_id = 'grid:stable:2:3';
    const child = {
      ...makeStep(proposal),
      recovery: proposal.recovery,
      state: 'completed',
      result: {
        geometry: { cells: [{ cell_id: 'grid:other:2:3', occupancy: 'occupied' }] },
      },
    } as QueueStep;
    resolveRecovery(goal, child, state, makeStep);
    expect(goal.state).toBe('review');
    child.result = {
      geometry: { cells: [{ cell_id: 'grid:stable:2:3', occupancy: 'occupied' }] },
    };
    resolveRecovery(goal, child, state, makeStep);
    expect(goal.state).toBe('running');
    expect(first.state).toBe('completed');
    expect(first.result.review_required).toBe(true); // original evidence is immutable
    expect(goal.steps.filter((s) => s.skill === 'pick_place')).toHaveLength(1);
  });

  it('stows a held hard object on table and continues independent work without a model', () => {
    const { goal, state, first, pending } = setup();
    first.skill = 'place_held';
    first.stage = {
      id: 'hard-shaft', number: 2, title: '长轴装盘', depends_on: [],
      expected_state: '长轴位于托盘内',
    };
    first.result = {
      result: {
        failure: { code: 'NO_FREE_SPACE' },
        holding: { verified: true },
      },
    };
    state.scene.holding = { verified: true };
    const proposal = recoveryObservation(goal, state)!;
    expect(proposal).toMatchObject({
      skill: 'place_held',
      params: { destination: { label: 'table', selection: 'free_space' } },
      recovery: { kind: 'safe_stow' },
    });
    const stowed = {
      ...makeStep(proposal), recovery: proposal.recovery, state: 'completed',
      result: { evaluation: { physical_success: true, released: true } },
    } as QueueStep;
    goal.steps.splice(1, 0, stowed);
    expect(resolveRecovery(goal, stowed, state, makeStep)).toBe(true);
    expect(first.state).toBe('superseded');
    expect(goal).toMatchObject({ state: 'running', skipped_stages: ['hard-shaft'] });
    expect(pending.state).toBe('pending');
  });
});
