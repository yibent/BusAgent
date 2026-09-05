// Read-only live check: no motion inputs, no saved/played audio.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

async function check(text) {
  const before = text === '现在机械臂在做什么？'
    ? (await (await fetch('http://127.0.0.1:7861/api/status')).json()).motion
    : undefined;
  const socket = new WebSocket('ws://127.0.0.1:3100/v1/stt');
  const conversation = `parallel-check-${randomUUID()}`;
  let timer, started, firstTextMs, firstAudioMs, semanticMs, speechDone = false;
  const replies = [], events = [];
  try {
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const done = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Parallel check timeout')), 45000);
      socket.on('error', reject);
      socket.on('message', raw => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'error') return reject(new Error(event.message));
        if (event.type === 'reply.delta') firstTextMs ??= Date.now() - started;
        if (event.type === 'reply.final') replies.push(event.text);
        if (event.type === 'speech.audio') firstAudioMs ??= Date.now() - started;
        if (event.type === 'speech.done') speechDone = true;
        if (event.type === 'bus.event') {
          events.push(event.event_type);
          if (event.event_type === 'interaction.classified') semanticMs = Date.now() - started;
        }
        if (semanticMs !== undefined && speechDone) resolve();
      });
    });
    started = Date.now();
    socket.send(JSON.stringify({ type: 'user.text', correlation_id: conversation, text }));
    await done;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(replies.length, 1, 'Interaction must not be answered twice');
    assert.ok(!events.includes('robot.execute.requested'), 'Read-only interaction must not enter device lane');
    assert.ok(!events.includes('conversation.requested'), 'NLU must not repeat dialogue');
    assert.ok(firstAudioMs !== undefined, 'TTS must deliver streamed audio');
    if (text === '你有什么能力？') assert.ok(replies[0].length <= 80, 'Default capabilities must stay concise');
    if (before?.mode === 'hold' && !before.active_command_id) {
      const after = (await (await fetch('http://127.0.0.1:7861/api/status')).json()).motion;
      if (after?.mode === 'hold' && !after.active_command_id && after.last_command?.command_id === before.last_command?.command_id)
        assert.ok(!/正在复位|正在移动|正在执行|正在运动/.test(replies[0]), 'Do not report a historical command as current motion');
    }
    return { conversation, input: text, reply: replies[0], first_text_ms: firstTextMs, first_audio_ms: firstAudioMs, semantic_ms: semanticMs, interaction_before_semantics: firstTextMs < semanticMs };
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}

const results = [];
for (const text of ['你好。', '你有什么能力？', '现在机械臂在做什么？']) {
  const result = await check(text);
  results.push(result);
  console.log(JSON.stringify(result));
}
assert.ok(results.some(result => result.interaction_before_semantics), 'Expected interaction to start before semantic classification');
console.log('LIVE PARALLEL INTERACTION PASSED');
