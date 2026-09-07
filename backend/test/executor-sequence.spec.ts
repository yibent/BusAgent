import { afterEach, expect, it, vi } from 'vitest';
import {
  HttpRobotAdapter,
  RobotAdapterNode,
} from '../src/apps/desktop-robot/executor-agent.js';
import type { InProcessEventContext } from '../src/adapters/in-process/agent-classes.js';

afterEach(() => vi.restoreAllMocks());
it('awaits each asynchronous physical command and completes the plan only after its last step', async () => {
  const calls: string[] = [];
  vi.spyOn(HttpRobotAdapter.prototype, 'execute').mockImplementation((commandId) => {
    calls.push(`send:${commandId}`);
    return Promise.resolve({ ok: true, message: '', commandId, state: 'accepted' });
  });
  vi.spyOn(HttpRobotAdapter.prototype, 'result').mockImplementation((commandId) => {
    calls.push(`result:${commandId}`);
    return Promise.resolve({ ok: true, message: '', commandId, state: 'completed' });
  });
  const publish = vi.fn().mockResolvedValue({});
  const context = {
    event: {
      eventId: 'command',
      correlationId: 'sequence-test',
      taskId: 'sequence-test',
      payload: {
        plan: {
          task_version: 1,
          intent: { intent: 'motion', target: { category: null } },
          steps: [
            { id: 1, skill: 'grasp', params: { target: 'block' } },
            { id: 2, skill: 'place_held', params: { destination: { label: 'table' } } },
          ],
        },
      },
    },
    agentConfig: { config: {} },
    publish,
  } as unknown as InProcessEventContext;
  const adapter = new RobotAdapterNode() as unknown as {
    executeNow(context: InProcessEventContext, submitted: () => void): Promise<string>;
  };
  expect(await adapter.executeNow(context, vi.fn())).toBe('completed');
  expect(calls).toEqual([
    'send:command:1',
    'result:command:1',
    'send:command:2',
    'result:command:2',
  ]);
  const events = publish.mock.calls.map(
    (c) => (c[0] as { event_type: string }).event_type,
  );
  expect(events.filter((e) => e === 'execution.completed')).toHaveLength(1);
  expect(events).toEqual([
    'execution.accepted',
    'execution.progress',
    'execution.accepted',
    'execution.completed',
  ]);
});
