/** Compact executed-task facts, separate from language history and live authority. */
export const MEMORY_TTL_MS = 2 * 60 * 60_000;
export const INSTRUCTION_MEMORY_LIMIT = 24;
interface Outcome {
  task_id: string;
  event: string;
  instruction: unknown;
  message: unknown;
  command_id: unknown;
  at: number;
}
const outcomes = new Map<string, Map<string, Outcome>>();
export function rememberOutcome(
  conversation: string,
  task: string,
  event: string,
  payload: Record<string, unknown>,
  instruction: unknown,
): void {
  if (
    ![
      'execution.queued',
      'execution.started',
      'execution.completed',
      'execution.failed',
      'execution.cancelled',
      'execution.unknown',
    ].includes(event)
  )
    return;
  const history = outcomes.get(conversation) ?? new Map<string, Outcome>();
  const previous = history.get(task);
  if (
    previous &&
    ['execution.completed', 'execution.failed', 'execution.cancelled'].includes(
      String(previous.event),
    )
  )
    return;
  history.set(task, {
    task_id: task,
    event,
    instruction,
    message: payload.message,
    command_id: payload.command_id,
    at: Date.now(),
  });
  for (const [id, item] of history)
    if (Date.now() - Number(item.at) > MEMORY_TTL_MS) history.delete(id);
  while (history.size > 24) history.delete(history.keys().next().value!);
  outcomes.set(conversation, history);
  while (outcomes.size > 500) outcomes.delete(outcomes.keys().next().value!);
}
export function recentOutcomes(conversation: string): unknown[] {
  return [...(outcomes.get(conversation)?.values() ?? [])].filter(
    (v) => Date.now() - Number(v.at) < MEMORY_TTL_MS,
  );
}
