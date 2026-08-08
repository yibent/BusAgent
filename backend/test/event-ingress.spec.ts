import { describe, expect, it } from 'vitest';
import { EventIngressService } from '../src/bus/event-ingress.service.js';
import type { EventBus } from '../src/bus/event-bus.service.js';
import { BusAgentError } from '../src/common/errors.js';
import { makeEvent } from './helpers.js';

function busReturning(eventId: string): EventBus {
  return {
    publishFromAgent: () => Promise.resolve(makeEvent({ eventId })),
  } as unknown as EventBus;
}

function busRejecting(code: string): EventBus {
  return {
    publishFromAgent: () =>
      Promise.reject(new BusAgentError(code as never, 'rejected')),
  } as unknown as EventBus;
}

describe('EventIngressService.handle', () => {
  it('accepts a valid publish with 202', async () => {
    const service = new EventIngressService(busReturning('evt_9'));
    const result = await service.handle({
      event_type: 'plan.created',
      source_agent_id: 'planner',
      payload: {},
    });
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ event_id: 'evt_9' });
  });

  it('rejects a malformed envelope with 400', async () => {
    const service = new EventIngressService(busReturning('evt_9'));
    const result = await service.handle({ foo: 'bar' });
    expect(result.status).toBe(400);
  });

  it('maps contract violations to 400', async () => {
    const service = new EventIngressService(busRejecting('AGENT_CONTRACT_VIOLATION'));
    const result = await service.handle({
      event_type: 'x',
      source_agent_id: 'planner',
      payload: {},
    });
    expect(result.status).toBe(400);
  });

  it('maps unknown sources to 404', async () => {
    const service = new EventIngressService(busRejecting('AGENT_NOT_INSTALLED'));
    const result = await service.handle({
      event_type: 'x',
      source_agent_id: 'ghost',
      payload: {},
    });
    expect(result.status).toBe(404);
  });
});
