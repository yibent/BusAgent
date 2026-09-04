import { describe, expect, it, vi } from 'vitest';
import { TtsAgent } from '../src/modules/tts/tts-agent.js';
import type { TtsConnection, TtsHandlers } from '../src/modules/tts/tts-types.js';
import { ConversationHub } from '../src/modules/conversation/conversation-hub.js';
import { SpeechGate } from '../src/modules/conversation/speech-gate.js';
import { HostConfig } from '../src/config/host-config.js';
import { RuntimeState } from '../src/app/runtime-state.service.js';

describe('TtsAgent', () => {
  it('streams PCM to the conversation hub and blocks STT', async () => {
    const hub = new ConversationHub();
    const gate = new SpeechGate();
    const seen: Array<Record<string, unknown>> = [];
    hub.subscribe('c1', (message) => {
      seen.push(message);
    });

    let handlers: TtsHandlers | undefined;
    const appendText = vi.fn();
    const finish = vi.fn();
    const connection: TtsConnection = {
      appendText,
      finish,
      close: vi.fn(),
    };

    const agent = new TtsAgent(
      HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test-key' }),
      new RuntimeState(),
      hub,
      gate,
      (_opts, next) => {
        handlers = next;
        return connection;
      },
    );

    agent.startTurn('c1', 1);
    handlers?.onReady();
    agent.append('c1', 1, '你好');
    await vi.waitFor(() => {
      expect(appendText.mock.calls).toEqual([['你好']]);
    });

    const pcm = Buffer.alloc(4800, 0).toString('base64');
    handlers?.onAudio(pcm);
    expect(gate.isBlocked('c1')).toBe(true);
    expect(seen.some((m) => m.type === 'speech.start')).toBe(true);
    expect(seen.some((m) => m.type === 'speech.audio' && m.audio === pcm)).toBe(true);

    await agent.finishTurn('c1', 1);
    expect(finish.mock.calls.length).toBe(1);
  });

  it('cancels playback by closing without flushing buffered speech', () => {
    const hub = new ConversationHub();
    const close = vi.fn();
    const finish = vi.fn();
    const agent = new TtsAgent(
      HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test-key' }),
      new RuntimeState(),
      hub,
      new SpeechGate(),
      () => ({ appendText: vi.fn(), finish, close }),
    );

    agent.startTurn('c1', 1);
    agent.cancel('c1');

    expect(close).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
  });

  it('opens the speech gate immediately when playback is interrupted', () => {
    const hub = new ConversationHub();
    const gate = new SpeechGate();
    let handlers: TtsHandlers | undefined;
    const agent = new TtsAgent(
      HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test-key' }),
      new RuntimeState(),
      hub,
      gate,
      (_options, nextHandlers) => {
        handlers = nextHandlers;
        return { appendText: vi.fn(), finish: vi.fn(), close: vi.fn() };
      },
    );

    agent.startTurn('c1', 1);
    handlers?.onAudio(Buffer.alloc(4800).toString('base64'));
    expect(gate.isBlocked('c1')).toBe(true);
    gate.interrupt('c1');
    agent.interrupt('c1');

    expect(gate.isBlocked('c1')).toBe(false);
  });
});
