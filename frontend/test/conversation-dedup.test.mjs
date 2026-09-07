import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationDedup } from '../src/lib/conversation-dedup.ts';
test('replayed voice packets and finals do not repeat; new utterances with the same words remain valid', () => {
  const d = new ConversationDedup();
  const packet = { type: 'transcript.delta', utterance_id: 'one', seq: 1 };
  assert.equal(d.accept(packet), true); assert.equal(d.accept(packet), false);
  assert.equal(d.accept({ type: 'transcript.final', utterance_id: 'one' }), true);
  assert.equal(d.accept({ type: 'transcript.final', utterance_id: 'one' }), false);
  assert.equal(d.accept({ ...packet, seq: 2 }), false);
  assert.equal(d.accept({ type: 'transcript.final', utterance_id: 'two' }), true);
});
test('one assistant bubble per turn; a reconnected backend may restart turn numbering', () => {
  const d = new ConversationDedup();
  for (const type of ['reply.start', 'reply.final']) { assert.equal(d.accept({ type, turn: 1 }), true); assert.equal(d.accept({ type, turn: 1 }), false); }
  d.resetReplies(); assert.equal(d.accept({ type: 'reply.start', turn: 1 }), true);
});
