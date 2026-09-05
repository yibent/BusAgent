import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtsAgent } from '../src/modules/tts/tts-agent.js';
import type { TtsConnection, TtsHandlers } from '../src/modules/tts/tts-types.js';
import { ConversationHub } from '../src/modules/conversation/conversation-hub.js';
import { SpeechGate } from '../src/modules/conversation/speech-gate.js';
import { HostConfig } from '../src/config/host-config.js';
import { RuntimeState } from '../src/app/runtime-state.service.js';

describe('TtsAgent', () => {
  afterEach(() => vi.useRealTimers());
  it.each([
    [1.15, 1.15],
    [undefined, undefined],
    [NaN, undefined],
    [3, 2],
    [0.1, 0.5],
  ])(
    'forwards speech rate %s as %s without changing PCM sample rate',
    (input, expected) => {
      const runtime = new RuntimeState();
      vi.spyOn(runtime, 'isReady').mockReturnValue(true);
      vi.spyOn(runtime, 'current', 'get').mockReturnValue({
        agents: new Map([
          ['robot.tts', { runtimeConfig: { config: { speech_rate: input } } }],
        ]),
      } as unknown as RuntimeState['current']);
      const connect = vi.fn(() => ({
        appendText: vi.fn(),
        finish: vi.fn(),
        close: vi.fn(),
      }));
      const agent = new TtsAgent(
        HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test' }),
        runtime,
        new ConversationHub(),
        new SpeechGate(),
        connect,
      );
      agent.startTurn('rate', 1);
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({ speechRate: expected, sampleRate: 24000 }),
        expect.any(Object),
      );
      agent.cancel('rate');
    },
  );
  it('commits full sentences and only flushes an unfinished tail when the turn ends', async () => {
    vi.useFakeTimers();
    let handlers!: TtsHandlers;
    const appendText = vi.fn();
    const finish = vi.fn();
    const agent = new TtsAgent(
      HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test' }),
      new RuntimeState(),
      new ConversationHub(),
      new SpeechGate(),
      (_options, h) => {
        handlers = h;
        return { appendText, finish, close: vi.fn() };
      },
    );
    agent.startTurn('c', 1);
    handlers.onReady();
    agent.append('c', 1, '正在移动，目标距离为2.');
    await vi.advanceTimersByTimeAsync(1000);
    expect(appendText).not.toHaveBeenCalled();
    agent.append('c', 1, '5厘米；尚未到位');
    await vi.advanceTimersByTimeAsync(1000);
    expect(appendText).not.toHaveBeenCalled();
    agent.append('c', 1, '。第二句。下一句');
    await vi.advanceTimersByTimeAsync(0);
    expect(appendText.mock.calls).toEqual([
      ['正在移动，目标距离为2.5厘米；尚未到位。'],
      ['第二句。'],
    ]);
    agent.append('c', 1, '没有句号');
    await vi.advanceTimersByTimeAsync(1000);
    expect(appendText).toHaveBeenCalledTimes(2);
    await agent.finishTurn('c', 1);
    expect(appendText.mock.calls).toEqual([
      ['正在移动，目标距离为2.5厘米；尚未到位。'],
      ['第二句。'],
      ['下一句没有句号'],
    ]);
    expect(finish).toHaveBeenCalledOnce();
    expect(appendText.mock.invocationCallOrder.at(-1)).toBeLessThan(
      finish.mock.invocationCallOrder[0]!,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(appendText).toHaveBeenCalledTimes(3);
    agent.cancel('c');
  });

  it('drops buffered text and queued writes on cancellation before ready', async () => {
    vi.useFakeTimers();
    let handlers!: TtsHandlers;
    const appendText = vi.fn();
    const finish = vi.fn();
    const agent = new TtsAgent(
      HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test' }),
      new RuntimeState(),
      new ConversationHub(),
      new SpeechGate(),
      (_options, h) => {
        handlers = h;
        return { appendText, finish, close: vi.fn() };
      },
    );
    agent.startTurn('c', 1);
    agent.append('c', 1, '这是一段说明。');
    agent.append('c', 1, '尾巴');
    const finished = agent.finishTurn('c', 1);
    agent.interrupt('c');
    await finished;
    handlers.onError(new Error('late close after intentional cancellation'));
    handlers.onReady();
    await vi.advanceTimersByTimeAsync(500);
    expect(appendText).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });
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
    agent.append('c1', 1, '你好。');
    await vi.waitFor(() => {
      expect(appendText.mock.calls).toEqual([['你好。']]);
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
