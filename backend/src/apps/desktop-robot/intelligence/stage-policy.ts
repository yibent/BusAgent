import type { Action, Goal, QueueStep } from './types.js';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Keep an independent hard object from blocking the rest of a batch. */
export function skipRepeatedIndependentFailure(
  goal: Goal,
  attemptLimit: number,
): boolean {
  if (goal.architecture !== 'staged') return false;
  const failed = goal.steps.findLast((step) => step.state === 'failed');
  const stage = failed?.stage;
  if (!failed || !stage) return false;
  const dependent = goal.steps.some(
    (candidate) =>
      candidate.state === 'pending' && candidate.stage?.depends_on.includes(stage.id),
  );
  if (dependent) return false;
  const code = String(
    object(object(object(failed.result).result ?? failed.result).failure).code ?? '',
  );
  if (!['NO_FREE_SPACE', 'TARGET_NOT_FOUND', 'CAPABILITY_MISSING'].includes(code))
    return false;
  const target = object(failed.params.target);
  const targetLabel = String(
    typeof failed.params.target === 'string'
      ? failed.params.target
      : target.label ?? target.category ?? '',
  );
  const attempts = goal.steps.filter((candidate) => {
    const candidateTarget = object(candidate.params.target);
    const candidateLabel = String(
      typeof candidate.params.target === 'string'
        ? candidate.params.target
        : candidateTarget.label ?? candidateTarget.category ?? '',
    );
    const sameStage =
      candidate.stage?.id === stage.id ||
      (candidate.stage?.number === stage.number &&
        candidate.skill === failed.skill &&
        candidateLabel === targetLabel);
    if (!sameStage) return false;
    const result = object(object(candidate.result).result ?? candidate.result);
    return String(object(result.failure).code ?? '') === code;
  }).length;
  if (attempts < attemptLimit) return false;
  failed.state = 'superseded';
  goal.skipped_stages = [...new Set([...(goal.skipped_stages ?? []), stage.id])];
  goal.final_review = true;
  goal.state = 'running';
  delete goal.review_kind;
  goal.review_reason = '';
  goal.message = `阶段 ${stage.number} 连续 ${attempts} 次因 ${code} 失败，已跳过并继续独立阶段。`;
  return true;
}

/** Resolve a failed/uncertain stage check without interrupting an unrelated
 * physical command already in flight. */
export function applyStageVerificationFailure(
  goal: Goal,
  step: QueueStep,
  verdict: 'failed' | 'uncertain',
  attemptLimit: number,
  makeStep: (action: Action) => QueueStep,
): 'retry' | 'skip' | 'replan' {
  const stage = step.stage;
  if (!stage || goal.architecture !== 'staged') {
    goal.state = 'review';
    goal.review_kind = 'failure';
    goal.review_reason = `局部监督${verdict}，保留已完成动作并重新规划。`;
    return 'replan';
  }
  const dependent = goal.steps.some(
    (candidate) =>
      candidate.state === 'pending' && candidate.stage?.depends_on.includes(stage.id),
  );
  if (step.attempt < attemptLimit) {
    const retry = makeStep({
      title: step.title,
      skill: step.skill,
      params: structuredClone(step.params),
      review_after: step.review_after,
      ...(step.execution ? { execution: structuredClone(step.execution) } : {}),
      stage: structuredClone(stage),
    });
    retry.attempt = step.attempt + 1;
    const pending = goal.steps.findIndex((candidate) => candidate.state === 'pending');
    goal.steps.splice(pending < 0 ? goal.steps.length : pending, 0, retry);
    goal.state = 'running';
    delete goal.review_kind;
    goal.review_reason = '';
    goal.message = `阶段 ${stage.number} 的局部验收${verdict}，已安排第 ${retry.attempt} 次执行。`;
    return 'retry';
  }
  if (!dependent) {
    goal.skipped_stages = [...new Set([...(goal.skipped_stages ?? []), stage.id])];
    goal.final_review = true;
    goal.state = 'running';
    delete goal.review_kind;
    goal.review_reason = '';
    goal.message = `阶段 ${stage.number} 多次未通过局部验收，已暂时跳过；列表结束后集中复查。`;
    return 'skip';
  }
  goal.state = 'review';
  goal.review_kind = 'failure';
  goal.review_reason =
    '阶段局部监督未通过，后续阶段存在依赖；保留已完成动作并重新规划。';
  return 'replan';
}
