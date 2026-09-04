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
});
