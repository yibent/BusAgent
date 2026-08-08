import { describe, expect, it } from 'vitest';
import { eventKindOf, hasExecutionCredential } from '../src/bus/event-kind.js';
import { RegistryService } from '../src/registry/registry.service.js';
import { makeEvent, makeLoadedPackage, makePackageAgent } from './helpers.js';

describe('eventKindOf', () => {
  it('classifies physical side-effect events declared in permissions', () => {
    const registry = new RegistryService();
    registry.installPackage(
      makeLoadedPackage('exec', [
        makePackageAgent({
          agent_id: 'executor',
          permissions: {
            context: ['task.*'],
            side_effects: ['robot.execute.requested'],
          },
        }),
      ]),
    );
    const event = makeEvent({
      eventType: 'robot.execute.requested',
      taskId: 'task_1',
      taskVersion: 1,
    });
    expect(eventKindOf(event, registry)).toBe('physical');
  });

  it('classifies task events by task_id + task_version', () => {
    const registry = new RegistryService();
    const event = makeEvent({
      eventType: 'plan.created',
      taskId: 'task_1',
      taskVersion: 1,
    });
    expect(eventKindOf(event, registry)).toBe('task');
  });

  it('classifies everything else as normal', () => {
    const registry = new RegistryService();
    expect(eventKindOf(makeEvent({ eventType: 'reply.created' }), registry)).toBe(
      'normal',
    );
  });
});

describe('hasExecutionCredential', () => {
  it('accepts snake_case and camelCase credentials', () => {
    expect(hasExecutionCredential({ execution_credential: 'tok' })).toBe(true);
    expect(hasExecutionCredential({ executionCredential: 'tok' })).toBe(true);
  });

  it('rejects missing or empty credentials', () => {
    expect(hasExecutionCredential({})).toBe(false);
    expect(hasExecutionCredential({ execution_credential: '' })).toBe(false);
    expect(hasExecutionCredential(null)).toBe(false);
  });
});
