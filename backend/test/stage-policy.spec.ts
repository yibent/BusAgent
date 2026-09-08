import { describe, expect, it } from 'vitest';
import { applyStageVerificationFailure } from '../src/apps/desktop-robot/intelligence/stage-policy.js';
import type {
  Action,
  Goal,
  QueueStep,
} from '../src/apps/desktop-robot/intelligence/types.js';

let sequence = 0;
const step = (id: string, stageId: string, depends: string[] = []): QueueStep => ({
  id,
  task_id: `task-${id}`,
  command_id: `command-${id}`,
  title: id,
  skill: 'pick_place',
  params: { target: 'part', destination: 'tray' },
  review_after: false,
  execution: {
    loop: 'fast_then_slow',
    supervision: { kind: 'florence', target_label: 'part', region_label: 'tray' },
  },
  stage: {
    id: stageId,
    number: Number(stageId.slice(-1)),
    title: id,
    depends_on: depends,
    expected_state: 'part位于tray内',
  },
  state: 'completed',
  attempt: 1,
});
const goal = (...steps: QueueStep[]): Goal => ({
  id: 'goal',
  conversation_id: 'conversation',
  input_event_id: 'event',
  source: '整理零件',
  architecture: 'staged',
  state: 'running',
  mode: 'complex',
  summary: '整理零件',
  completion: '全部归位',
  steps,
  message: '',
  review_reason: '',
  recovery_count: 0,
  created_at: '',
  updated_at: '',
  model_calls: 0,
  revision: 1,
});
const makeStep = (action: Action): QueueStep => ({
  ...action,
  id: `retry-${++sequence}`,
  task_id: `retry-task-${sequence}`,
  command_id: `retry-command-${sequence}`,
  state: 'pending',
  attempt: 1,
});

describe('stage verification policy', () => {
  it('inserts an independent retry before later pending work', () => {
    const first = step('first', 'stage-1');
    const next = step('next', 'stage-2');
    next.state = 'pending';
    const task = goal(first, next);
    expect(applyStageVerificationFailure(task, first, 'failed', 2, makeStep)).toBe(
      'retry',
    );
    expect(task.steps.map((item) => item.id)).toEqual([
      'first',
      expect.stringMatching(/^retry-/),
      'next',
    ]);
    expect(task.steps[1]?.attempt).toBe(2);
  });

  it('replans a repeatedly failed stage when a later stage depends on it', () => {
    const first = step('first', 'stage-1');
    first.attempt = 2;
    const dependent = step('dependent', 'stage-2', ['stage-1']);
    dependent.state = 'pending';
    const task = goal(first, dependent);
    expect(applyStageVerificationFailure(task, first, 'uncertain', 2, makeStep)).toBe(
      'replan',
    );
    expect(task).toMatchObject({ state: 'review', review_kind: 'failure' });
  });

  it('skips a repeatedly failed independent stage and preserves final review', () => {
    const first = step('first', 'stage-1');
    first.attempt = 2;
    const task = goal(first);
    expect(applyStageVerificationFailure(task, first, 'uncertain', 2, makeStep)).toBe(
      'skip',
    );
    expect(task).toMatchObject({
      state: 'running',
      final_review: true,
      skipped_stages: ['stage-1'],
    });
  });
});
