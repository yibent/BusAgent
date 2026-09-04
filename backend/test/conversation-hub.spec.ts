import { describe, expect, it } from 'vitest';
import { ConversationHub } from '../src/modules/conversation/conversation-hub.js';

describe('ConversationHub', () => {
  it('fans out to live subscribers and ignores missing sessions', () => {
    const hub = new ConversationHub();
    const seen: unknown[] = [];
    const off = hub.subscribe('c1', (message) => {
      seen.push(message);
    });
    hub.publish('c1', { type: 'reply.delta', text: '你' });
    hub.publish('missing', { type: 'reply.delta', text: 'x' });
    off();
    hub.publish('c1', { type: 'reply.delta', text: '好' });
    expect(seen).toEqual([{ type: 'reply.delta', text: '你' }]);
  });
});
