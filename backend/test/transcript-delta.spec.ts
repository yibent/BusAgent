import { describe, expect, it } from 'vitest';
import {
  TranscriptDeltaEncoder,
  splitFew,
  suffixAfter,
} from '../src/modules/stt/transcript-delta.js';

describe('splitFew', () => {
  it('splits CJK into small character groups', () => {
    expect(splitFew('帮我找到绿色咖啡杯', 4, 6)).toEqual(['帮我找到绿色', '咖啡杯']);
  });

  it('splits latin into small word groups', () => {
    expect(splitFew('find the green coffee cup please', 4, 6)).toEqual([
      'find the green coffee',
      'cup please',
    ]);
  });
});

describe('suffixAfter', () => {
  it('returns the new tail when the prefix matches', () => {
    expect(suffixAfter('帮我找到绿色', '帮我')).toBe('找到绿色');
  });

  it('returns the whole string when the hypothesis is rewritten', () => {
    expect(suffixAfter('请帮我找杯子', '帮我')).toBe('请帮我找杯子');
  });
});

describe('TranscriptDeltaEncoder', () => {
  it('emits uncommitted tails then committed few-character pieces', () => {
    const encoder = new TranscriptDeltaEncoder(4, 4);
    const interim = encoder.push('帮我找', false, false);
    expect(interim.deltas).toEqual([{ seq: 1, text: '帮我找', committed: false }]);

    const locked = encoder.push('帮我找到绿色咖啡杯', true, false);
    expect(locked.deltas.every((d) => d.committed)).toBe(true);
    expect(locked.deltas.map((d) => d.text).join('')).toBe('帮我找到绿色咖啡杯');
    expect(locked.finalText).toBeNull();
  });

  it('emits final text when speech ends', () => {
    const encoder = new TranscriptDeltaEncoder(4, 8);
    encoder.push('hello world', true, false);
    const done = encoder.push('hello world', true, true);
    expect(done.finalText).toBe('hello world');
  });

  it('only appends newly committed words', () => {
    const encoder = new TranscriptDeltaEncoder(2, 6);
    encoder.push('find the', true, false);
    const next = encoder.push('find the green cup', true, false);
    expect(next.deltas.map((d) => d.text)).toEqual(['green cup']);
  });

  it('clears in-flight text on reset', () => {
    const encoder = new TranscriptDeltaEncoder(4, 6);
    encoder.push('回声', true, false);
    encoder.reset();
    const next = encoder.push('你好', true, true);
    expect(next.finalText).toBe('你好');
  });
});
