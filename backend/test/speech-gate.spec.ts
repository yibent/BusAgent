import { describe, expect, it } from 'vitest';
import { pcm16MonoDurationMs, SpeechGate } from '../src/modules/conversation/speech-gate.js';

describe('pcm16MonoDurationMs', () => {
  it('converts 24 kHz 16-bit mono bytes to milliseconds', () => {
    expect(pcm16MonoDurationMs(48_000, 24_000)).toBe(1000);
  });
});

describe('SpeechGate', () => {
  it('blocks a conversation after speaking begins', () => {
    const gate = new SpeechGate();
    expect(gate.isBlocked('c1')).toBe(false);
    gate.beginSpeaking('c1');
    gate.extendPlayback('c1', 5_000);
    expect(gate.isBlocked('c1')).toBe(true);
    expect(gate.isBlocked('c2')).toBe(false);
  });

  it('unblocks shortly after playbackEnded', () => {
    const gate = new SpeechGate();
    gate.beginSpeaking('c1');
    gate.extendPlayback('c1', 30_000);
    expect(gate.isBlocked('c1')).toBe(true);
    gate.playbackEnded('c1', 0);
    expect(gate.isBlocked('c1')).toBe(false);
  });

  it('recognizes assistant text while allowing unrelated human speech', () => {
    const gate = new SpeechGate();
    gate.startAssistantTurn('c1');
    gate.appendAssistantText('c1', '今天下午可以先去开会，然后整理材料。');

    expect(gate.isLikelyEcho('c1', '先去开会然后整理资料')).toBe(true);
    expect(gate.isLikelyEcho('c1', '等一下')).toBe(false);
  });
});
