// Opt-in live acceptance: text-only status/noise probes; optional simulated motion.
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const base = process.env.WORKBENCH_URL ?? 'http://127.0.0.1:3100';
const socket = new WebSocket(base.replace(/^http/, 'ws') + '/v1/stt');
const conversation = 'latency-acceptance-' + randomUUID();
const replies = [];
let waiting;
socket.on('message', raw => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply.final') {
    replies.push({ text: m.text, at: performance.now() });
    waiting?.(m.text);
  }
  if (m.type === 'speech.end') socket.send(JSON.stringify({type: 'speech.ended', correlation_id: conversation}));
});
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
const tasks = async () => (await (await fetch(base + '/v1/tasks')).json()).goals;
const send = text => socket.send(JSON.stringify({type:'user.text', text, correlation_id:conversation}));
const pause = ms => new Promise(r => setTimeout(r, ms));
const results = { conversation, queries: [] };
try {
  const before = await tasks();
  send('。');
  await pause(1500);
  assert.equal(replies.length, 0, 'Punctuation must not produce dialogue');
  assert.equal((await tasks()).length, before.length, 'Punctuation must not create a goal');
  results.noise = { replies: 0, new_goals: 0 };
  for (const text of ['现在在干啥？','你现在在做什么？','嗯，我后面的任务呢。']) {
    const start = performance.now();
    const reply = new Promise((resolve,reject)=> {
      const timeout = setTimeout(()=>reject(Error('Status reply timed out')),5000);
      waiting = value => {clearTimeout(timeout);resolve(value);waiting=undefined;};
    });
    send(text);
    const value = await reply;
    results.queries.push({text, reply:value, elapsed_ms:Math.round(performance.now()-start)});
  }
  assert.equal((await tasks()).length,before.length,'Queries must not create planning goals');
  if (process.argv.includes('--motion')) {
    const instruction = process.env.MOTION_INSTRUCTION ?? '把红色方块放到桌面空处';
    const start = performance.now();
    send(instruction);
    let goal;
    while (performance.now()-start<180000) {
      goal=(await tasks()).find(g=>g.conversation_id===conversation && g.source===instruction);
      if (goal && ['completed','blocked','cancelled'].includes(goal.state)) break;
      await pause(500);
    }
    results.motion={instruction,elapsed_ms:Math.round(performance.now()-start),goal_id:goal?.id,state:goal?.state,model_calls:goal?.model_calls,message:goal?.message,steps:goal?.steps.map(s=>({skill:s.skill,state:s.state,message:s.result?.message}))};
  }
  console.log(JSON.stringify(results,null,2));
  if(process.env.REPORT_PATH)writeFileSync(process.env.REPORT_PATH,JSON.stringify(results,null,2));
} finally {socket.close();}
