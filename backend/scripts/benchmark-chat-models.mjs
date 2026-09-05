// Read-only: measure provider first visible token, not ASR/routing/TTS latency.
import { HostConfig } from '../dist/config/host-config.js';
const host = HostConfig.fromEnv();
// Generic public test text only; never send project prompts to candidate models.
const system = '用简短中文回答，只说一句。问候只答你好，致谢只答不客气。';
const models = ['qwen3.8-flash', 'qwen-flash', 'qwen-turbo', 'qwen3.7-flash'];
const samples = Object.fromEntries(models.map((model) => [model, []]));
for (const text of ['你好', '谢谢', '你是谁']) {
  for (const model of models) {
    const started = performance.now();
    try {
      const response = await fetch(host.qwenChatUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${host.dashscopeApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text },
          ],
          stream: true,
          enable_thinking: false,
          temperature: 0.2,
          max_tokens: 192,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let buffer = '',
        content = '',
        firstMs,
        reasoningChars = 0;
      const decoder = new TextDecoder();
      for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
          const delta = JSON.parse(line.slice(5)).choices?.[0]?.delta;
          reasoningChars += delta?.reasoning_content?.length ?? 0;
          if (delta?.content) {
            firstMs ??= Math.round(performance.now() - started);
            content += delta.content;
          }
        }
      }
      if (firstMs === undefined) throw new Error('No visible content');
      samples[model].push(firstMs);
      console.log(
        JSON.stringify({
          model,
          text,
          first_ms: firstMs,
          total_ms: Math.round(performance.now() - started),
          reasoning_chars: reasoningChars,
          content,
        }),
      );
    } catch (error) {
      console.log(JSON.stringify({ model, error: error.message }));
    }
  }
}
for (const [model, values] of Object.entries(samples)) {
  values.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      model,
      samples: values.length,
      median_first_ms: values[Math.floor(values.length / 2)],
    }),
  );
}
