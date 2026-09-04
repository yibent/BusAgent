import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeState } from '../src/app/runtime-state.service.js';
import { RobotControlProxy } from '../src/apps/desktop-robot/robot-control-proxy.js';

function runtimeState(controllerUrl: string): RuntimeState {
  return {
    isReady: () => true,
    current: {
      agents: new Map([
        [
          'robot.device_adapter',
          { runtimeConfig: { config: { controller_url: controllerUrl } } },
        ],
      ]),
    },
  } as unknown as RuntimeState;
}

describe('robot control status proxy', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads controller status through the configured server-side URL', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) => {
      void _input;
      void _init;
      return Promise.resolve(
        new Response(JSON.stringify({ prompt: 'red block', follow_enabled: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await new RobotControlProxy(
      runtimeState('http://gpu.local:7861'),
    ).status();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gpu.local:7861/api/status');
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body.toString())).toMatchObject({
      prompt: 'red block',
      follow_enabled: true,
    });
  });

  it('returns an explicit unavailable state while the host starts', async () => {
    const runtime = { isReady: () => false } as unknown as RuntimeState;
    const result = await new RobotControlProxy(runtime).status();
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body.toString())).toMatchObject({ connected: false });
  });
});
