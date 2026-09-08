import type { Action, Goal, QueueStep } from './types.js';

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
