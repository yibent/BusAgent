import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntelligentDialogue } from '../src/modules/dialogue/intelligent-dialogue.js';
import * as client from '../src/apps/desktop-robot/intelligence/model-client.js';
import type { ModelConfig } from '../src/apps/desktop-robot/intelligence/model-config.js';
import type { ContextMemory } from '../src/modules/conversation/context-memory.js';
import { ConversationHub } from '../src/modules/conversation/conversation-hub.js';
import type { TtsAgent } from '../src/modules/tts/tts-agent.js';
import type { InProcessEventContext } from '../src/adapters/in-process/agent-classes.js';
import { makeEvent } from './helpers.js';

const answer = (text: string): client.ModelAnswer => ({
  message: { role: 'assistant', content: text },
  usage: {},
  elapsed_ms: 10,
  model: 'test',
});
const drain = () => new Promise((resolve) => setTimeout(resolve, 20));
function fixture() {
  const messages: Record<string, unknown>[] = [],
    bus: Record<string, unknown>[] = [];
  const hub = new ConversationHub();
  hub.subscribe('conversation', (m) => messages.push(m));
  const memory = {
    view: vi.fn().mockResolvedValue({
      working: { holding: { verified: true } },
      recent: [
        { kind: 'intent.created', text: '刚才的任务先别重试' },
        { kind: 'execution.failed', result: { ok: false, failure: 'slipped' } },
      ],
    }),
  };
  const tts = {
    startTurn: vi.fn(),
    append: vi.fn(),
    finishTurn: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    interrupt: vi.fn(),
  };
  const agent = new IntelligentDialogue(
    memory as unknown as ContextMemory,
    {
      dialogueProfiles: async () => [{ id: 'test', model: 'test' }],
    } as unknown as ModelConfig,
    hub,
    tts as unknown as TtsAgent,
  );
  const context = (
    id: string,
    type = 'intent.created',
    payload: Record<string, unknown> = {
      text: '我们刚才都干了啥',
      utterance_id: 'voice:1',
    },
  ) =>
    ({
      event: makeEvent({
        eventId: id,
        eventType: type,
        correlationId: 'conversation',
        payload,
      }),
      agentConfig: { config: {} },
      publish: async (input: Record<string, unknown>) => {
        bus.push(input);
      },
    }) as unknown as InProcessEventContext;
  return { agent, messages, bus, context, tts };
}
afterEach(() => vi.restoreAllMocks());
describe('parallel intelligent dialogue', () => {
  it('receives context, acknowledges once per utterance and speaks the planner result', async () => {
    const f = fixture();
    const call = vi
      .spyOn(client, 'complete')
      .mockResolvedValueOnce(answer('我看看刚才的记录。'))
      .mockResolvedValueOnce(answer('刚才抓取滑落了，没有完成；你要求先别重试。'));
    f.agent.handle(f.context('first'));
    f.agent.handle(f.context('replayed'));
    f.agent.handle(f.context('token', 'transcript.delta', { text: '刚才' }));
    await drain();
    expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(call.mock.calls[0]?.[1])).toContain('先别重试');
    f.agent.handle(
      f.context('result', 'intelligence.reply', {
        instruction_id: 'first',
        text: '抓取失败，没有重试',
        user_text: '我们刚才都干了啥',
      }),
    );
    await drain();
    expect(
      f.messages.filter((m) => m.type === 'reply.final').map((m) => m.text),
    ).toEqual(['我看看刚才的记录。', '刚才抓取滑落了，没有完成；你要求先别重试。']);
    expect(f.bus.map((e) => (e.payload as Record<string, unknown>).phase)).toEqual([
      'acknowledgement',
      'result',
    ]);
    expect(JSON.stringify(call.mock.calls[1]?.[1])).toContain('抓取失败');
    f.agent.onModuleDestroy();
  });
  it('suppresses a late acknowledgement when the planner result wins the race', async () => {
    const f = fixture();
    let finish!: (v: client.ModelAnswer) => void;
    vi.spyOn(client, 'complete')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(answer('刚才成功放好一个零件。'));
    f.agent.handle(f.context('first'));
    await drain();
    f.agent.handle(
      f.context('result', 'intelligence.reply', {
        instruction_id: 'first',
        text: '成功放好一个零件',
      }),
    );
    await drain();
    finish(answer('我看看。'));
    await drain();
    expect(
      f.messages.filter((m) => m.type === 'reply.final').map((m) => m.text),
    ).toEqual(['刚才成功放好一个零件。']);
    expect(f.messages.filter((m) => m.type === 'reply.start')).toHaveLength(1);
    f.agent.onModuleDestroy();
  });
  it('does not manufacture an acknowledgement if its result was delivered first', async () => {
    const f = fixture();
    const call = vi
      .spyOn(client, 'complete')
      .mockResolvedValue(answer('还没有开始动作。'));
    f.agent.handle(
      f.context('result', 'intelligence.reply', {
        instruction_id: 'first',
        text: '尚未执行',
      }),
    );
    f.agent.handle(f.context('first'));
    await drain();
    expect(call).toHaveBeenCalledTimes(1);
    f.agent.onModuleDestroy();
  });
  it('retains negative facts if reply models are unavailable', async () => {
    const f = fixture();
    vi.spyOn(client, 'complete').mockRejectedValue(new Error('offline'));
    f.agent.handle(
      f.context('result', 'intelligence.reply', { text: '抓取失败，物体未拿起。' }),
    );
    await drain();
    expect(f.messages.find((m) => m.type === 'reply.final')?.text).toBe(
      '抓取失败，物体未拿起。',
    );
    f.agent.onModuleDestroy();
  });
});
