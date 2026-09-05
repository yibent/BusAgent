// Cancellation of pending interpretation/grounding, not just active joint motion.
const versions = new Map<string, number>();
let serial = 0;
const listeners = new Set<(conversation: string) => void>();
export function onIntentCancellation(
  listener: (conversation: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const intentVersion = (conversation: string): number =>
  versions.get(conversation) ?? 0;
export function cancelPendingIntent(conversation: string): void {
  versions.set(conversation, ++serial);
  for (const listener of listeners) listener(conversation);
  if (versions.size > 2000) versions.delete(versions.keys().next().value!);
}
