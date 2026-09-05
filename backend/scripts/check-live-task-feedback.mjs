// Read-only speech checks: perception and an incomplete move request, no executable motion.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const socket = new WebSocket('ws://127.0.0.1:3100/v1/stt');
const conversation = `feedback-check-${randomUUID()}`;
let active;
socket.on('message', raw => {
  if (!active) return;
  const event = JSON.parse(raw.toString());
  if (event.type === 'error') return active.reject(new Error(event.message));
  if (event.type === 'reply.delta') active.firstTextMs ??= Date.now() - active.start;
  if (event.type === 'reply.final') active.replies.push({ text: event.text, turn: event.turn });
  if (event.type === 'speech.audio') active.audioTurns.add(event.turn);
  if (event.type === 'speech.done') active.doneTurns.add(event.turn);
  if (event.type === 'bus.event') {
    active.events.push(event.event_type);
    if (event.event_type === 'robot.execute.requested') return active.reject(new Error('Read-only check unexpectedly requested motion'));
    if (event.event_type === 'reply.created' && (Array.isArray(active.expected) ? active.expected : [active.expected]).includes(event.payload?.source_event)) active.resultText = event.payload.text;
    if (active.expected === 'interaction.classified' && event.event_type === active.expected) active.resultText = active.replies.at(-1)?.text;
  }
  const result = active.replies.find(r => r.text === active.resultText);
  if (result && active.audioTurns.has(result.turn) && active.doneTurns.has(result.turn)) active.resolve();
});
async function check(text, expected) {
  let timer;
  try {
    await new Promise((resolve, reject) => {
      active = { start: Date.now(), replies: [], events: [], audioTurns: new Set(), doneTurns: new Set(), resolve, reject, expected };
      timer = setTimeout(() => reject(new Error(`No spoken ${expected} result: ${JSON.stringify(active.replies)}`)), 45000);
      socket.send(JSON.stringify({ type: 'user.text', correlation_id: conversation, text }));
    });
    assert.ok(active.resultText && active.resultText !== '收到。');
    console.log(JSON.stringify({ input: text, first_text_ms: active.firstTextMs, replies: active.replies.map(r => r.text), result: active.resultText, spoken_result: true }));
  } finally { clearTimeout(timer); active = undefined; }
}
try {
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await check('请看一下有没有黄色螺栓。', ['observation.ready', 'clarification.requested']);
  await check('刚才识别结果怎么样？不用重新观察。', 'interaction.classified');
  await check('把机械臂移动到。', 'clarification.requested');
  console.log('LIVE TASK FEEDBACK PASSED (no motion)');
} finally { socket.close(); }
