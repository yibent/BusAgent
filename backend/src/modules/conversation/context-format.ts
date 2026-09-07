import {
  semanticEvidence,
  type QueueState,
} from '../../apps/desktop-robot/intelligence/types.js';
const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
const pick = (x: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => x[k] !== undefined).map((k) => [k, x[k]]));
export const MEMORY_TYPES = [
  'intent.created',
  'reply.created',
  'intelligence.reply',
  'execution.completed',
  'execution.failed',
  'execution.cancelled',
  'execution.unknown',
];

/** Conservative text estimate, including CJK; budgets never split a fact in half. */
export function estimateTokens(value: unknown): number {
  const text = JSON.stringify(value) ?? '';
  const ascii = [...text].filter((char) => char.charCodeAt(0) < 128).length;
  return Math.ceil(ascii / 3 + text.length - ascii);
}

export function memoryEntry(raw: unknown): Record<string, unknown> {
  const e = object(raw),
    p = object(e.payload),
    result = object(p.result ?? p);
  const rawType = e.eventType ?? e.event_type;
  const type = typeof rawType === 'string' ? rawType : '';
  return {
    ref: e.eventId ?? e.event_id,
    at: e.createdAt ?? e.created_at,
    kind: type,
    task_id: e.taskId ?? e.task_id,
    ...pick(p, [
      'text',
      'goal_id',
      'instruction_id',
      'phase',
      'user_text',
      'goal_state',
    ]),
    ...(type.startsWith('execution.')
      ? {
          // A reply is a statement, never an observed physical outcome.
          authority: 'execution_evidence',
          result: semanticEvidence(
            pick(result, [
              'ok',
              'state',
              'message',
              'failure',
              'holding',
              'evaluation',
              'postconditions',
              'review_required',
              'review_reason',
            ]),
          ),
        }
      : { authority: type === 'intent.created' ? 'user_request' : 'reported_speech' }),
  };
}

export function taskMemory(state: QueueState) {
  const goals = state.goals.filter((g) => g.steps.length || g.state !== 'completed');
  const brief = (g: (typeof goals)[number]) => ({
    ref: g.id,
    instruction_id: g.input_event_id,
    source: g.source,
    state: g.state,
    revision: g.revision,
    completion: g.completion,
    message: g.message,
    completed_steps: g.steps.filter((s) => s.state === 'completed').map((s) => s.title),
    remaining: g.steps
      .filter((s) => ['pending', 'running', 'dispatching', 'unknown'].includes(s.state))
      .map((s) => ({ title: s.title, state: s.state })),
    last_result: g.steps
      .filter((s) => s.result)
      .slice(-1)
      .map((s) =>
        memoryEntry({
          eventId: s.command_id,
          eventType: `execution.${s.state}`,
          createdAt: s.finished_at,
          payload: s.result,
        }),
      ),
    updated_at: g.updated_at,
  });
  return {
    total_task_count: state.goals.length,
    counts_by_state: state.goals.reduce<Record<string, number>>((counts, goal) => {
      counts[goal.state] = (counts[goal.state] ?? 0) + 1;
      return counts;
    }, {}),
    paused: state.paused,
    holding: semanticEvidence(state.scene.holding),
    active: goals
      .filter((g) => !['completed', 'cancelled'].includes(g.state))
      .sort(
        (a, b) =>
          ['running', 'planning', 'review', 'queued', 'paused', 'blocked'].indexOf(
            a.state,
          ) -
          ['running', 'planning', 'review', 'queued', 'paused', 'blocked'].indexOf(
            b.state,
          ),
      )
      .map(brief),
    recent_robot_tasks: goals
      .filter((g) => ['completed', 'cancelled'].includes(g.state))
      .slice(-8)
      .map(brief),
  };
}

/** Consolidate a turn's receipts/progress into an episode, retaining source refs.
 * Execution evidence lives in its own field, never inferred from assistant text. */
export function conversationEpisodes(entries: Record<string, unknown>[]) {
  const episodes = new Map<string, Record<string, unknown>>();
  for (const row of entries) {
    if (row.phase === 'acknowledgement') continue;
    const goalInput =
      typeof row.goal_id === 'string' ? row.goal_id.replace(/^goal_/, '') : undefined;
    const key = String(row.instruction_id ?? goalInput ?? row.task_id ?? row.ref);
    const episode = episodes.get(key) ?? { ref: key, at: row.at };
    if (row.kind === 'intent.created')
      episode.request = pick(row, ['ref', 'text', 'authority']);
    else if (row.authority === 'execution_evidence') {
      const evidence = Array.isArray(episode.evidence)
        ? (episode.evidence as unknown[])
        : [];
      evidence.push(row);
      episode.evidence = evidence;
    } else if (row.kind === 'intelligence.reply') {
      episode.planner_report = pick(row, ['ref', 'text', 'goal_state', 'authority']);
    } else episode.assistant_said = pick(row, ['ref', 'text', 'authority']);
    episode.at = row.at;
    episodes.set(key, episode);
  }
  return [...episodes.values()];
}

/** Extractive episodic compression: the archive remains exact and retrievable.
 * User constraints, negations and measured failures are never rewritten by a model.
 * Working state is supplied separately on every read and supersedes old speech. */
export function compactContext(
  entries: Record<string, unknown>[],
  working: unknown,
  budget = 4500,
) {
  const limit = Math.max(512, budget);
  const result = {
    policy:
      '当前工作状态优先于历史。用户要求不是执行证据，助手说法不是物理事实。省略部分可用 read_history 按 ref 查询。',
    working: {} as unknown,
    recent: [] as Record<string, unknown>[],
    episodes: [] as Record<string, unknown>[],
    omitted: 0,
    archive_available: true,
  };
  // Reserve space for the current exchange even with a very long task queue.
  const w = object(working);
  const active = Array.isArray(w.active) ? (w.active as unknown[]) : [];
  const pins = {
    total_task_count: w.total_task_count,
    counts_by_state: w.counts_by_state,
    paused: w.paused,
    holding: w.holding,
    active: [] as unknown[],
    active_count: active.length,
    executing_count: active.filter((g) => object(g).state === 'running').length,
    pending_count: active.filter((g) =>
      ['queued', 'planning', 'review'].includes(String(object(g).state)),
    ).length,
  };
  result.working = pins;
  for (const raw of Array.isArray(w.active) ? w.active : []) {
    const g = object(raw);
    const compact = pick(g, [
      'ref',
      'source',
      'state',
      'revision',
      'completion',
      'remaining',
      'last_result',
    ]);
    pins.active.push(compact);
    if (estimateTokens(result) > limit * 0.55) {
      pins.active.pop();
      result.omitted++;
    }
  }
  const select = (row: Record<string, unknown>, list: Record<string, unknown>[]) => {
    list.unshift(row);
    if (estimateTokens(result) > limit - 160) {
      list.shift();
      result.omitted++;
    }
  };
  // Near-term messages keep their full text, bounded by whole-message inclusion.
  const recent = entries.slice(-10);
  for (const entry of [...recent].reverse()) select(entry, result.recent);
  // Robot history also survives browser reconnection (new conversation id).
  for (const entry of [
    ...(Array.isArray(w.recent_robot_tasks) ? (w.recent_robot_tasks as unknown[]) : []),
  ].reverse())
    select(object(entry), result.episodes);
  for (const row of conversationEpisodes(entries.slice(0, -10)).reverse())
    select(row, result.episodes);
  return {
    ...result,
    budget_tokens: limit,
    estimated_tokens: estimateTokens(result) + 40,
  };
}
