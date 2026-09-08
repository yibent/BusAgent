import { describe, expect, it, vi } from 'vitest';
import { planGoal } from '../src/apps/desktop-robot/intelligence/planning.js';
import type { ModelProfile } from '../src/apps/desktop-robot/intelligence/model-config.js';
import {
  immediateAction,
  isAcknowledgement,
  isSceneQuestion,
  relevantGoals,
  statusReply,
  hasMeaningfulInput,
} from '../src/apps/desktop-robot/intelligence/interaction-routing.js';
import { emptyQueue, type Goal } from '../src/apps/desktop-robot/intelligence/types.js';

describe('immediate interaction routes', () => {
  it('drops punctuation-only recognition without dropping Chinese, numbers or mixed instructions', () => {
    for (const text of ['。', '……', '！？', '  ', '🎤'])
      expect(hasMeaningfulInput(text)).toBe(false);
    for (const text of ['嗯', '2', '现在在干啥', '先放下，再说。'])
      expect(hasMeaningfulInput(text)).toBe(true);
  });
  it('answers spoken status and queue questions from live task records including intake', () => {
    const state = emptyQueue();
    state.goals.push({
      id: 'intake',
      source: '把其他方块放进蓝色容器',
      summary: '',
      conversation_id: 'c',
      state: 'planning',
      interaction: true,
      steps: [],
      created_at: '',
    } as unknown as Goal);
    for (const text of [
      '现在在干啥？',
      '你现在在做什么？',
      '嗯，我后面的任务呢。',
      '后续任务有哪些？',
    ]) {
      const reply = statusReply(state, text, 'c');
      expect(reply?.text).toContain('把其他方块');
      expect(reply?.text).toContain('规划');
    }
    for (const text of [
      '现在把红块放好',
      '你现在在干啥，先把方块拿起来',
      '后面的任务取消',
    ])
      expect(statusReply(state, text, 'c')).toBeUndefined();
  });
  it('answers explicit scene questions with one local observation and no remote model', async () => {
    const readState = vi.fn().mockResolvedValue({});
    const readImage = vi.fn();
    const observe = vi.fn().mockResolvedValue({
      command_id: 'scene-query',
      vision: {
        views: [{ objects: [{ label: 'block' }], caption: 'A block and a tray.' }],
      },
    });
    const call = vi.fn();
    const record = vi.fn().mockResolvedValue(undefined);
    const profile = {
      id: 'vision-test',
      vision: true,
      model: 'vision',
    } as ModelProfile;
    const result = await planGoal(
      profile,
      'planner',
      { source: '你能看到桌面上有什么吗？', steps: [] } as unknown as Goal,
      emptyQueue(),
      { readState, readImage, observe, record, images: true },
      new AbortController().signal,
      call,
    );
    expect(result).toMatchObject({ outcome: 'chat', actions: [] });
    expect(readState).not.toHaveBeenCalled();
    expect(readImage).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalled();
    expect(result.message).toContain('方块');
    expect(
      record.mock.calls.map(([event]) => (event as { kind: string }).kind),
    ).toEqual(['operation_started', 'operation_completed', 'vision_tool']);
  });
  it('recognizes the real spoken reset request without accepting negations or mixed tasks', () => {
    expect(immediateAction('嗯，那你。先把机械臂复位吧。')?.skill).toBe('home');
    expect(immediateAction('张开夹爪')?.params).toEqual({ opening: 1 });
    for (const text of [
      '不要复位',
      '机械臂复位了吗',
      '先复位再抓起零件',
      '等零件放好后复位',
      '复位时不要放开夹爪',
    ])
      expect(immediateAction(text)).toBeUndefined();
  });
  it('reads an image only for an explicit simple scene question', () => {
    expect(isSceneQuestion('嗯。你能看到桌面上有什么吗？')).toBe(true);
    expect(isSceneQuestion('嗯。嗯。现在画面中可以看到什么？')).toBe(true);
    expect(isSceneQuestion('嗯。现在可以看到什么呢？')).toBe(true);
    for (const text of [
      '先看桌面再把零件收好',
      '你刚才看到桌面有什么',
      '机械臂复位吧',
      '桌面上有什么适合先抓的零件',
    ])
      expect(isSceneQuestion(text)).toBe(false);
  });
  it('keeps acknowledgement and result followups out of motion planning', () => {
    expect(isAcknowledgement('嗯。')).toBe(true);
    expect(isAcknowledgement('嗯，那就把红块拿起来')).toBe(false);
    expect(statusReply(emptyQueue(), '还没有得到结果吗？', 'current')?.text).toContain(
      '没有',
    );
    expect(
      statusReply(emptyQueue(), '嗯，现在正在做什么？', 'current')?.text,
    ).toContain('没有');
    expect(statusReply(emptyQueue(), '现在把红块拿起来', 'current')).toBeUndefined();
  });
  it('reports the exact paused home task, not an older completed task or a query failure', () => {
    const state = emptyQueue();
    state.paused = true;
    const home = {
      id: 'home',
      source: '复位',
      summary: '机械臂复位',
      conversation_id: 'current',
      state: 'queued',
      created_at: '2026-09-07',
      interaction: false,
      steps: [{ title: '机械臂复位', skill: 'home', state: 'pending' }],
    } as Goal;
    state.goals = [
      {
        ...home,
        id: 'old',
        conversation_id: 'previous',
        state: 'completed',
        steps: [{ ...home.steps[0]!, state: 'completed' }],
      },
      home,
      { ...home, id: 'query', interaction: true, state: 'blocked', steps: [] },
    ];
    const reply = statusReply(state, '机械臂复位任务执行的怎么样了？', 'current');
    expect(reply?.goal?.id).toBe('home');
    expect(reply?.text).toContain('尚未开始');
    expect(reply?.text).toContain('暂停');
    expect(relevantGoals(state, 'current').map((g) => g.id)).toEqual(['home', 'old']);
    expect(statusReply(state, '复位后抓起零件', 'current')).toBeUndefined();
    state.goals.push({
      ...home,
      id: 'pack',
      summary: '把异形铸件装箱',
      source: '把异形铸件装箱',
      steps: [],
    });
    expect(
      statusReply(state, '把异形铸件装箱任务执行的怎么样了？', 'current')?.goal?.id,
    ).toBe('pack');
    expect(
      statusReply(state, '搬运新料箱任务执行的怎么样了？', 'current'),
    ).toBeUndefined();
  });
});
