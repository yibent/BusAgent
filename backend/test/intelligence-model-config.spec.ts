import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ModelConfig,
  completionsUrl,
} from '../src/apps/desktop-robot/intelligence/model-config.js';
import { complete } from '../src/apps/desktop-robot/intelligence/model-client.js';
import type { HostConfig } from '../src/config/host-config.js';

describe('private model profiles', () => {
  let directory: string;
  let models: ModelConfig;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'busagent-profiles-test-'));
    vi.stubEnv('BUSAGENT_INTELLIGENCE_CONFIG', join(directory, 'settings.json'));
    vi.stubEnv('QWEN_CHAT_API_KEY', 'dialogue-test-key');
    vi.stubEnv('GEMINI_PRIMARY_API_KEY', 'private-test-key');
    vi.stubEnv('GEMINI_SECONDARY_API_KEY', 'secondary-test-key');
    vi.stubEnv('QWEN_CHAT_URL', 'https://model.test/v1');
    models = new ModelConfig({} as HostConfig);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  it('preserves keys without returning them to the browser', async () => {
    const publicSettings = await models.publicSettings();
    expect(JSON.stringify(publicSettings)).not.toContain('private-test-key');
    const saved = await models.save(publicSettings);
    expect(JSON.stringify(saved)).not.toContain('private-test-key');
    expect((await models.profile('planner')).apiKey).toBe('private-test-key');
    expect((await stat(models.path)).mode & 0o777).toBe(0o600);
    expect((await new ModelConfig({} as HostConfig).profile('planner')).apiKey).toBe(
      'private-test-key',
    );
    const draft = await models.publicSettings();
    draft.fallbacks.planner = [];
    draft.fallbacks.task = [];
    draft.fallbacks.supervisor = [];
    draft.fallbacks.visual = [];
    await models.save(draft, false, ['gemini-38-flash']);
    expect(
      (await models.settings()).profiles.find(
        (profile) => profile.id === 'gemini-38-flash',
      )?.apiKey,
    ).toBe('');
  });
  it('persists an independently selectable dialogue profile and shares settings updates immediately', async () => {
    const settings = await models.publicSettings();
    settings.roles.dialogue = 'qwen3-8-flash';
    await models.save(settings);
    expect((await models.dialogueProfiles())[0]?.id).toBe('qwen3-8-flash');
    expect((await new ModelConfig({} as HostConfig).settings()).roles.dialogue).toBe(
      'qwen3-8-flash',
    );
  });
  it('isolates Gemini and GLM thinking parameters and does not log remote error bodies', async () => {
    const profile = await models.profile('planner');
    const request = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'OK' } }],
          }),
        ),
      ),
    );
    vi.stubGlobal('fetch', request);
    await complete(profile, [{ role: 'user', content: 'test' }], []);
    let body = JSON.parse(
      (request.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBe('low');
    expect(body.thinking).toBeUndefined();
    await complete(
      { ...profile, provider: 'glm', thinking: true },
      [{ role: 'user', content: 'test' }],
      [],
    );
    body = JSON.parse(
      (request.mock.calls[1]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.enable_thinking).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'enabled' });
    request.mockResolvedValueOnce(
      new Response('sensitive remote diagnostics', { status: 401 }),
    );
    await expect(complete(profile, [], [])).rejects.toThrow('HTTP 401');
  });
  it('uses the supported GLM 5.3 thinking mode even with a previously disabled setting', async () => {
    const request = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'OK' } }],
          }),
        ),
      ),
    );
    vi.stubGlobal('fetch', request);
    const profile = {
      ...(await models.profile('planner')),
      provider: 'glm' as const,
      model: 'glm-5.3-flash',
      thinking: false,
    };
    await complete(profile, [{ role: 'user', content: 'test' }], []);
    const body = JSON.parse(
      (request.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'enabled', clear_thinking: false });
    expect(body.reasoning_effort).toBe('low');
    expect(body.enable_thinking).toBeUndefined();
    await complete({ ...profile, reasoningEffort: 'high' }, [], []);
    expect(
      (
        JSON.parse((request.mock.calls[1]![1] as RequestInit).body as string) as Record<
          string,
          unknown
        >
      ).reasoning_effort,
    ).toBe('high');
  });
  it('uses only the explicitly ordered fallback chain and supports visual routing timeouts', async () => {
    const settings = await models.publicSettings();
    settings.roles.planner = 'gemini-38-flash';
    settings.fallbacks.planner = ['gemini-37-flash'];
    settings.roles.visual = 'gemini-37-flash';
    settings.fallbacks.visual = ['gemini-38-flash'];
    settings.nodeTimeouts.visual = 5000;
    settings.nodeFirstTokenTimeouts.visual = 5000;
    settings.performance.providerCooldownEnabled = false;
    await models.save(settings);
    expect((await models.profilesFor('planner')).map((p) => p.id)).toEqual([
      'gemini-38-flash',
      'gemini-37-flash',
    ]);
    expect((await models.profilesFor('visual')).map((p) => p.id)).toEqual([
      'gemini-37-flash',
      'gemini-38-flash',
    ]);
    expect(
      (await models.profilesFor('visual')).every((p) => p.timeoutMs === 5000),
    ).toBe(true);
    expect(
      (await models.profilesFor('visual')).every((p) => p.cooldownEnabled === false),
    ).toBe(true);
    expect((await models.dialogueProfiles()).map((p) => p.id)).toEqual([
      'qwen3-8-flash',
    ]);
    expect(completionsUrl('https://model.test/')).toBe(
      'https://model.test/v1/chat/completions',
    );
    expect(completionsUrl('https://model.test/custom/v1/')).toBe(
      'https://model.test/custom/v1/chat/completions',
    );
  });
  it('supports disabled, same-capability and compatible ordered fallbacks', async () => {
    const settings = await models.publicSettings();
    settings.roles.planner = 'gemini-37-flash';
    settings.fallbacks.planner = ['deepseek-v4-flash-0731', 'gemini-38-flash'];
    settings.fallbackPolicies.planner = 'same_capability';
    await models.save(settings);
    expect((await models.profilesFor('planner')).map((p) => p.id)).toEqual([
      'gemini-37-flash',
      'gemini-38-flash',
    ]);
    const compatible = await models.publicSettings();
    compatible.fallbackPolicies.planner = 'ordered_compatible';
    await models.save(compatible);
    expect((await models.profilesFor('planner')).map((p) => p.id)).toEqual([
      'gemini-37-flash',
      'deepseek-v4-flash-0731',
      'gemini-38-flash',
    ]);
    const disabled = await models.publicSettings();
    disabled.fallbackPolicies.planner = 'disabled';
    await models.save(disabled);
    expect((await models.profilesFor('planner')).map((p) => p.id)).toEqual([
      'gemini-37-flash',
    ]);
  });
  it('gives image planning a longer configurable first-token window than fast routing', async () => {
    expect((await models.profile('task')).firstTokenTimeoutMs).toBe(8000);
    expect((await models.profile('planner')).firstTokenTimeoutMs).toBe(30000);
    expect((await models.profile('planner')).timeoutMs).toBeGreaterThanOrEqual(30000);
    const settings = await models.publicSettings();
    settings.nodeFirstTokenTimeouts.planner = 18000;
    await models.save(settings);
    expect((await models.profile('planner')).firstTokenTimeoutMs).toBe(18000);
  });
  it('preserves provider tool signature metadata when continuing an inference', async () => {
    const message = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'read_state', arguments: '{}' },
          extra_content: { google: { thought_signature: 'opaque-signature' } },
        },
      ],
    };
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ choices: [{ message }] }));
    vi.stubGlobal('fetch', request);
    const profile = await models.profile('planner');
    const first = await complete(profile, [], []);
    request.mockResolvedValue(
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'ready' } }],
      }),
    );
    await complete(
      profile,
      [first.message, { role: 'tool', tool_call_id: 'call-1', content: '{}' }],
      [],
    );
    const sent = JSON.parse(
      (request.mock.calls[1]![1] as RequestInit).body as string,
    ) as { messages: unknown[] };
    expect(sent.messages[0]).toEqual(message);
  });
  it('disables DeepSeek reasoning for immediate dialogue without using Qwen parameters', async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        choices: [{ message: { role: 'assistant', content: '你好' } }],
      }),
    );
    vi.stubGlobal('fetch', request);
    const profile = (await models.settings()).profiles.find(
      (p) => p.provider === 'deepseek',
    )!;
    await complete(profile, [{ role: 'user', content: '你好' }], []);
    const body = JSON.parse(
      (request.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('enable_thinking');
  });
  it('uses a real streaming request and reconstructs streamed tool arguments', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"submit_","arguments":"{\\"ok\\":"}}]}}]}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"plan","arguments":"true}"}}]}}],"usage":{"total_tokens":9}}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    });
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      );
    vi.stubGlobal('fetch', request);
    const answer = await complete(await models.profile('planner'), [], []);
    expect(answer.message.tool_calls?.[0]?.function).toEqual({
      name: 'submit_plan',
      arguments: '{"ok":true}',
    });
    expect(answer.usage.total_tokens).toBe(9);
    expect(answer.first_token_ms).toBeTypeOf('number');
    expect(
      JSON.parse((request.mock.calls[0]![1] as RequestInit).body as string),
    ).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });
  it('aborts a provider that does not produce its first streamed token in time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = (init as RequestInit).signal!;
            signal.addEventListener(
              'abort',
              () =>
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error(String(signal.reason)),
                ),
              { once: true },
            );
          }),
      ),
    );
    await expect(
      complete(
        { ...(await models.profile('planner')), firstTokenTimeoutMs: 10 },
        [],
        [],
      ),
    ).rejects.toThrow('模型首字响应超时');
  });
});
