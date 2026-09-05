// Read-only audio test. No robot calls; generated PCM is counted, not played/stored.
import assert from 'node:assert/strict';
import { HostConfig } from '../dist/config/host-config.js';
import { RuntimeState } from '../dist/app/runtime-state.service.js';
import { ConversationHub } from '../dist/modules/conversation/conversation-hub.js';
import { SpeechGate } from '../dist/modules/conversation/speech-gate.js';
import { TtsAgent, defaultTtsStreamFactory } from '../dist/modules/tts/tts-agent.js';
const hub = new ConversationHub();
const submitted = [];
const agent = new TtsAgent(
  HostConfig.fromEnv(),
  new RuntimeState(),
  hub,
  new SpeechGate(),
  (options, handlers) => {
    const connection = defaultTtsStreamFactory(options, handlers);
    return {
      ...connection,
      appendText(text) { submitted.push(text); connection.appendText(text); },
    };
  },
);
let finishRequested = false,
  packets = 0,
  firstAudioMs;
const started = Date.now();
let firstAudio, complete;
const heard = new Promise((resolve) => {
  firstAudio = resolve;
});
const done = new Promise((resolve, reject) => {
  complete = resolve;
  hub.subscribe('streaming-tts-check', (message) => {
    if (message.type === 'error') reject(new Error(message.message));
    if (message.type === 'speech.audio') {
      packets++;
      firstAudioMs ??= Date.now() - started;
      firstAudio();
    }
    if (message.type === 'speech.done') complete();
  });
});
let timer;
const timeout = new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error('Streaming audio timeout')), 20000);
});
try {
  agent.startTurn('streaming-tts-check', 1);
  agent.append('streaming-tts-check', 1, '这是一段测试，距离为2.');
  agent.append('streaming-tts-check', 1, '5厘米');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(submitted, [], 'No short chunks or decimal fragments before a sentence ends');
  assert.equal(packets, 0);
  agent.append('streaming-tts-check', 1, '。');
  // A complete sentence can speak before the rest of the reply is generated.
  await Promise.race([heard, done, timeout]);
  assert.ok(packets > 0, 'Must hear audio before final text');
  assert.equal(finishRequested, false);
  const earlyPackets = packets;
  console.log(
    JSON.stringify({ first_audio_ms: firstAudioMs, audio_before_finish: true }),
  );
  agent.append('streaming-tts-check', 1, '第二句保持连贯。最后一句没有句号');
  finishRequested = true;
  await agent.finishTurn('streaming-tts-check', 1);
  await Promise.race([done, timeout]);
  assert.deepEqual(submitted, ['这是一段测试，距离为2.5厘米。', '第二句保持连贯。', '最后一句没有句号']);
  assert.ok(packets > earlyPackets, 'Must also hear subsequent queued text');
  console.log(JSON.stringify({ result: 'SENTENCE TTS PASSED', packets, submitted }));
} finally {
  clearTimeout(timer);
  agent.cancel('streaming-tts-check');
}
