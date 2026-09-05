// Read-only WebSocket conversation check; never plays/stores PCM or moves the arm.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
const socket = new WebSocket('ws://127.0.0.1:3100/v1/stt');
const conversation = `stream-check-${randomUUID()}`;
const started = Date.now();
let firstDeltaMs, firstAudioMs, finalMs, finalText, packets = 0;
const deltas = [];
let timer;
try {
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const completed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Streaming conversation timeout')), 45000);
    socket.on('error', reject);
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'error') reject(new Error(event.message));
      if (event.type === 'reply.delta') { firstDeltaMs ??= Date.now() - started; deltas.push(event.text); }
      if (event.type === 'reply.final') { finalMs = Date.now() - started; finalText = event.text; }
      if (event.type === 'speech.audio') { firstAudioMs ??= Date.now() - started; packets++; }
      if (event.type === 'speech.done') resolve();
    });
  });
  socket.send(JSON.stringify({ type: 'user.text', correlation_id: conversation, text: '用三句话说明简洁表达的好处。' }));
  await completed;
  assert.ok(deltas.length > 1, 'Expected multiple live text deltas');
  assert.equal(deltas.join(''), finalText);
  assert.ok(firstDeltaMs < finalMs, 'Text must arrive before the final response');
  assert.ok(packets > 0, 'Expected streamed PCM');
  console.log(JSON.stringify({ result: 'LIVE STREAMING PASSED', first_delta_ms: firstDeltaMs, final_ms: finalMs, first_audio_ms: firstAudioMs, deltas: deltas.length, packets, text: finalText }));
} finally {
  clearTimeout(timer);
  socket.close();
}
