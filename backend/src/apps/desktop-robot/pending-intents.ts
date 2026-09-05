// Cancellation of pending interpretation/grounding, not just active joint motion.
const versions = new Map<string, number>();
let serial = 0;
export const intentVersion = (conversation: string): number =>
  versions.get(conversation) ?? 0;
export function cancelPendingIntent(conversation: string): void {
  versions.set(conversation, ++serial);
  if (versions.size > 2000) versions.delete(versions.keys().next().value!);
}
