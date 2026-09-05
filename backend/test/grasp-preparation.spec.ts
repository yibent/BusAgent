import { afterEach, describe, expect, it, vi } from 'vitest';
import { preparationContext, rememberPreparation, clearPreparation } from '../src/apps/desktop-robot/grasp-preparation-context.js';
import { semanticFrame } from '../src/apps/desktop-robot/semantic-understanding.js';
import { buildPlan } from '../src/apps/desktop-robot/planner-agent.js';

describe('dialogue-authorized initial preparation', () => {
  afterEach(() => { clearPreparation('a'); clearPreparation('b'); vi.useRealTimers(); });
  it('remembers only real offers in the same conversation, with expiry', () => {
    vi.useFakeTimers();
    rememberPreparation('a', { result: { result: { preparation: {
      id: 'offer-1', requires_confirmation: true, description: '回初始准备姿态，不抓取',
    } } } }, '当前视角不可用，是否先回初始准备姿态？');
    expect(preparationContext('a')?.id).toBe('offer-1');
    expect(preparationContext('b')).toBeUndefined();
    vi.advanceTimersByTime(120_001);
    expect(preparationContext('a')).toBeUndefined();
    rememberPreparation('b', { message: '建议复位' }, '是否复位？');
    expect(preparationContext('b')).toBeUndefined();
  });
  it('cannot plan preparation without a factual proposal id', () => {
    const parsed = semanticFrame({ intent:'pick', prepare_last_grasp:true }, '同意，先回去');
    expect(parsed.needs_clarification).toBe(false);
    expect(buildPlan(parsed, 'i')).toBeNull();
    parsed.grasp_preparation_id = 'offer-1';
    const plan = buildPlan(parsed, 'i')!;
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.params).toMatchObject({prepare_last:true, proposal_id:'offer-1'});
    expect(plan.steps[0]!.params.retry_last).toBeUndefined();
    expect(plan.steps[0]!.verify).toContain('no grasp');
  });
  it('does not combine approval to prepare with approval to retry', () => {
    const parsed = semanticFrame({ intent:'pick', prepare_last_grasp:true, retry_last_grasp:true }, '好');
    expect(parsed.needs_clarification).toBe(true);
    expect(buildPlan(parsed, 'i')).toBeNull();
    const chat = semanticFrame({intent:'chat'}, '知道了');
    expect(buildPlan(chat, 'i')).toBeNull();
  });
});
