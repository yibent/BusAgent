import type { Action, Decision, Goal, QueueStep } from './types.js';

const data = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
const label = (x: unknown): string => {
  const value = typeof x === 'string' ? x : (data(x).label ?? data(x).category);
  return typeof value === 'string' ? value : '';
};
const normalized = (x: string) =>
  x
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const overlaps = (a: string, b: string) => a && b && (a.includes(b) || b.includes(a));

export function canPrepareAhead(current: Goal, flight: QueueStep, next: Goal): boolean {
  return (
    current.mode === 'simple' &&
    !flight.review_after &&
    ['pick_place', 'place_held'].includes(flight.skill) &&
    current.steps.every(
      (s) => s.id === flight.id || ['completed', 'superseded'].includes(s.state),
    ) &&
    next.state === 'queued' &&
    !next.interaction &&
    next.source.length < 180 &&
    !/收拾|整理|装满|最多|所有|观察|检查|如果|inspect|tidy|all |if /i.test(next.source)
  );
}

/** Only independent, explicit manipulation can skip a foreground planning call. */
export function independentAhead(decision: Decision, current: Action): boolean {
  const dirty = [label(current.params.target), label(current.params.destination)]
    .map(normalized)
    .filter(Boolean);
  return (
    decision.mode === 'simple' &&
    decision.outcome === 'continue' &&
    decision.actions.length > 0 &&
    decision.actions.every((action) => {
      if (!['grasp', 'pick_place'].includes(action.skill)) return false;
      const target = normalized(label(action.params.target));
      const destination = normalized(label(action.params.destination));
      if (!target || (action.skill === 'pick_place' && !destination)) return false;
      if (data(action.params.destination).region_ref) return false;
      if (
        /\b(left|right|nearest|behind|between|inside|in|on)\b|左|右|旁边|里面/.test(
          target,
        )
      )
        return false;
      return !dirty.some((d) => overlaps(target, d) || overlaps(destination, d));
    })
  );
}
