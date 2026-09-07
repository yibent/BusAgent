import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function observeScene(
  base: string,
  params: Record<string, unknown>,
  correlationId: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const commandId = `vision_${randomUUID()}`;
  const response = await fetch(`${base}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      command_id: commandId,
      skill: 'perceive',
      params,
      correlation_id: correlationId,
    }),
  });
  if (!response.ok) throw new Error(`观察请求未接收: ${await response.text()}`);
  for (;;) {
    signal.throwIfAborted();
    const reply = await fetch(`${base}/api/commands/${commandId}`, { signal });
    if (!reply.ok) throw new Error('观察结果暂不可用');
    const result = (await reply.json()) as Record<string, unknown>;
    if (!['accepted', 'running'].includes(String(result.state))) return result;
    await delay(100, undefined, { signal });
  }
}

export async function readObservation(
  base: string,
  id: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!/^[a-f0-9]{32}$/.test(id))
    throw new Error('请使用实际 observation_ref/request_id');
  const response = await fetch(`${base}/api/observations/${id}`, { signal });
  if (!response.ok) throw new Error('观察不存在或属于旧场景，请重新观察');
  return (await response.json()) as Record<string, unknown>;
}
