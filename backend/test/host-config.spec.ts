import { describe, expect, it } from 'vitest';
import { HostConfig } from '../src/config/host-config.js';

describe('HostConfig.fromEnv', () => {
  it('applies the spec defaults when nothing is set', () => {
    const config = HostConfig.fromEnv({});
    expect(config.eventIngressPath).toBe('/v1/events');
    expect(config.registrationPath).toBe('/internal/registrations');
    expect(config.registrationWaitTimeoutMs).toBe(30_000);
    expect(config.dashscopeApiKey).toBeUndefined();
    expect(config.qwenSttWsUrl).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/realtime');
    expect(config.qwenSttModel).toBe('qwen3-asr-flash-realtime');
    expect(config.qwenChatModel).toBe('qwen-plus');
    expect(config.qwenChatUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
    expect(config.qwenTtsModel).toBe('qwen3-tts-flash-realtime');
    expect(config.qwenTtsVoice).toBe('Cherry');
    expect(config.frontendDir.endsWith('frontend')).toBe(true);
  });

  it('honours explicit environment values', () => {
    const config = HostConfig.fromEnv({
      BUSAGENT_EVENT_INGRESS_PATH: '/ingest',
      BUSAGENT_PORT: '8080',
    });
    expect(config.eventIngressPath).toBe('/ingest');
    expect(config.port).toBe(8080);
  });

  it('rejects invalid environment values with a structured error', () => {
    expect(() => HostConfig.fromEnv({ BUSAGENT_PORT: 'not-a-port' })).toThrowError();
  });
});
