// Opt-in end-to-end smoke test: sends real commands to the simulated arm.
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
const socket = new WebSocket(process.env.MOTION_WS_URL ?? 'ws://127.0.0.1:3100/v1/stt');
const conversation = 'motion-check-' + randomUUID();
let pending;
socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === 'error') pending?.reject(new Error(message.message));
  if (message.type === 'reply.final') {
    console.log(JSON.stringify({ reply: message.text }));
    if (!message.text.includes('控制器已开始执行动作')) pending?.resolve(message.text);
  }
  if (message.type === 'speech.end')
    socket.send(JSON.stringify({ type: 'speech.ended', correlation_id: conversation }));
});
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
console.log(JSON.stringify({ conversation }));
try {
  const inputs = process.argv.slice(2);
  for (const text of inputs.length ? inputs : [
    '查询能力', '底座顺时针旋转10度', '底座顺时针旋转10度',
    '底座转到0度', '向上移动5毫米', '打开夹爪', '闭合夹爪',
    '旋转九十度', '绕绕z轴旋转', '顺时针旋转', '机械臂跳个舞', '归位',
  ]) {
    console.log(JSON.stringify({ command: text }));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Reply timeout: ' + text)), 45000);
      pending = { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } };
      socket.send(JSON.stringify({ type: 'user.text', text, correlation_id: conversation }));
    });
    pending = undefined;
  }
  console.log('END-TO-END CHECK FINISHED');
} finally { socket.close(); }
