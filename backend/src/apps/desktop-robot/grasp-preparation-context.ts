/** One short-lived, factual preparation question per conversation. */
export interface PreparationContext {
  id: string;
  description: string;
  assistant_question: string;
  expires: number;
}
const pending = new Map<string, PreparationContext>();
function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
}
export function rememberPreparation(conversation: string, payload: unknown, reply: string): void {
  const proposal = record(record(record(payload).result).result).preparation;
  const p = record(proposal);
  if (typeof p.id !== 'string' || p.requires_confirmation !== true) return;
  pending.set(conversation, { id: p.id, description: String(p.description ?? ''),
    assistant_question: reply, expires: Date.now() + 120_000 });
  for (const [id, value] of pending) if (value.expires <= Date.now()) pending.delete(id);
  while (pending.size > 500) pending.delete(pending.keys().next().value!);
}
export function preparationContext(conversation: string): PreparationContext | undefined {
  const p = pending.get(conversation);
  if (!p || p.expires <= Date.now()) { pending.delete(conversation); return undefined; }
  return { ...p };
}
export function clearPreparation(conversation: string): void { pending.delete(conversation); }
