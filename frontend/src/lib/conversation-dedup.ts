/** Identity-based deduplication: repeating the same words in a NEW utterance is valid. */
export class ConversationDedup {
  private seen = new Set<string>();
  accept(message: { type?: string; utterance_id?: string; seq?: number; turn?: number }) {
    const { type, utterance_id: utterance, seq, turn } = message;
    let key: string | undefined;
    if (type === 'transcript.final' && utterance) key = `final:${utterance}`;
    if (type === 'transcript.delta' && utterance) {
      if (this.seen.has(`final:${utterance}`)) return false;
      if (seq !== undefined) key = `delta:${utterance}:${seq}`;
    }
    if (['reply.start', 'reply.final'].includes(type ?? '') && turn !== undefined)
      key = `${type}:${turn}`;
    if (!key) return true;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    return true;
  }
  resetReplies() {
    for (const key of this.seen) if (key.startsWith('reply.')) this.seen.delete(key);
  }
}
