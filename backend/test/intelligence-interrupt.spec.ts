import { afterEach, expect, it, vi } from 'vitest';
import {
  InterruptMonitorNode,
  isPandaImmediateInterrupt,
} from '../src/apps/desktop-robot/interrupt-monitor-node.js';
import type { InProcessEventContext } from '../src/adapters/in-process/agent-classes.js';

afterEach(() => vi.unstubAllEnvs());
it('does not stop Panda for holding, conditional stops, or cancelling a waiting task', async () => {
  vi.stubEnv('BUSAGENT_ROBOT', 'franka_panda');
  vi.stubEnv('BUSAGENT_INTELLIGENCE', '1');
  const publish = vi.fn();
  const node = new InterruptMonitorNode();
  for (const text of [
    '拿起青色圆环，保持拿着',
    '取消后面那个还没开始的任务',
    '如果失败就停止',
    '保持物体正面朝上放进去',
  ]) {
    await node.handle({
      event: {
        eventType: 'transcript.final',
        eventId: text,
        correlationId: 'test',
        payload: { text },
      },
      publish,
    } as unknown as InProcessEventContext);
  }
  expect(publish).not.toHaveBeenCalled();
  for (const text of [
    '停',
    '停止，先不要抓',
    '立即停止机械臂',
    '暂停当前任务',
    '请停一下',
  ])
    expect(isPandaImmediateInterrupt(text)).toBe(true);
});
