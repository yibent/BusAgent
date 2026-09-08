import { z } from 'zod';
import type { Goal, QueueState, QueueStep } from './types.js';
export const supervisionSchema = z.object({
  kind: z.enum(['none', 'physical', 'florence']),
  camera: z.enum(['scene', 'side', 'wrist']).optional(),
  box_2d: z.array(z.number().min(0).max(1000)).length(4).optional(),
  target_label: z.string().optional(),
  predicate: z.enum(['present', 'upright']).optional(),
  wait: z.boolean().optional(),
});
export const executionPolicySchema = z.object({
  loop: z.enum(['fast_only', 'fast_then_slow', 'slow']),
  max_attempts: z.number().int().min(1).optional(),
  supervision: supervisionSchema.optional(),
});
export const executionPolicyJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    loop: { type: 'string', enum: ['fast_only', 'fast_then_slow', 'slow'] },
    max_attempts: { type: 'integer', minimum: 1 },
    supervision: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['none', 'physical', 'florence'] },
        camera: { type: 'string', enum: ['scene', 'side', 'wrist'] },
        box_2d: {
          type: 'array',
          items: { type: 'number', minimum: 0, maximum: 1000 },
          minItems: 4,
          maxItems: 4,
        },
        target_label: { type: 'string' },
        predicate: { type: 'string', enum: ['present', 'upright'] },
        wait: { type: 'boolean' },
      },
      required: ['kind'],
    },
  },
  required: ['loop'],
};
const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
export function policyParams(step: Pick<QueueStep, 'skill' | 'params' | 'execution'>) {
  const params = { ...step.params };
  const loop = step.execution?.loop;
  if (!loop) return params;
  if (['grasp', 'place_held', 'pick_place'].includes(step.skill))
    params.mode = { fast_only: 'basic', fast_then_slow: 'auto', slow: 'enhanced' }[
      loop
    ];
  if (step.skill === 'perceive')
    params.vision_mode = { fast_only: 'fast', fast_then_slow: 'auto', slow: 'slow' }[
      loop
    ];
  return params;
}
/** Retry a known failed command, never replay an uncertain or already released transfer. */
export function retryByPolicy(
  goal: Goal,
  state: QueueState,
  makeStep: (old: QueueStep) => QueueStep,
): boolean {
  const failed = goal.steps.findLast((s) => s.state === 'failed');
  if (!failed?.execution) return false;
  const result = object(object(failed.result).result ?? failed.result);
  const evaluation = object(result.evaluation);
  // These failures need new inputs/evidence; replaying the same command cannot
  // repair an ambiguous target, stale reference or missing argument.
  if (
    [
      'REFERENCE_STALE',
      'TARGET_AMBIGUOUS',
      'TARGET_NOT_FOUND',
      'NO_FREE_SPACE',
      'NO_CANDIDATE',
      'MODEL_UNAVAILABLE',
      'CAPABILITY_MISSING',
      'WRONG_ORIENTATION',
      'WRONG_CELL',
      'NOT_SEATED',
      'REGRASP_REQUIRED',
    ].includes(String(object(result.failure).code))
  )
    return false;
  if (['ValueError', 'FileNotFoundError'].includes(String(result.error_type)))
    return false;
  const holding =
    object(state.scene.holding).verified || object(result.holding).verified;
  if (
    result.released ||
    evaluation.released ||
    (failed.skill === 'place_held' ? !holding : holding)
  )
    return false;
  if (failed.attempt >= (failed.execution.max_attempts ?? 1)) return false;
  const next = makeStep(failed);
  for (const key of [
    'result',
    'started_at',
    'finished_at',
    'runtime_id',
    'delivery_attempts',
    'last_dispatched_at',
    'cancel_requested',
  ] as const)
    delete next[key];
  next.attempt = failed.attempt + 1;
  failed.state = 'superseded';
  goal.steps.splice(goal.steps.indexOf(failed) + 1, 0, next);
  goal.state = 'running';
  delete goal.review_kind;
  goal.review_reason = '';
  return true;
}
export function physicalVerdict(
  result: Record<string, unknown>,
  skill: string,
): 'passed' | 'failed' | 'uncertain' {
  const value = object(result.result ?? result);
  const evaluation = object(value.evaluation);
  if (
    value.ok === false ||
    evaluation.physical_success === false ||
    value.review_required
  )
    return 'uncertain';
  if (['place_held', 'pick_place'].includes(skill)) {
    if (object(value.holding).verified) return 'failed';
    return evaluation.physical_success === true &&
      (evaluation.released === true || value.released === true)
      ? 'passed'
      : 'uncertain';
  }
  if (skill === 'grasp')
    return object(value.holding).verified === true ? 'passed' : 'uncertain';
  return value.ok === true ? 'passed' : 'uncertain';
}
