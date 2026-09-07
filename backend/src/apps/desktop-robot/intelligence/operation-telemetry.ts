import { randomUUID } from 'node:crypto';

/** Metadata-only logical Bus operation; inference and frame bytes stay local. */
export async function observeOperation<T>(
  record: (event: Record<string, unknown>) => Promise<void>,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  const operation_id = randomUUID(),
    started_at_ms = Date.now();
  const base = { operation_id, operation, domain: 'vision', started_at_ms };
  await record({ ...base, kind: 'operation_started' });
  try {
    const result = await run();
    const row = result as Record<string, unknown>;
    const vision = (row.vision ?? row) as Record<string, unknown>;
    await record({
      ...base,
      kind: 'operation_completed',
      finished_at_ms: Date.now(),
      command_id: row.command_id,
      request_id:
        vision.request_id ??
        (row.metadata as Record<string, unknown> | undefined)?.snapshot_ref,
      ok: row.ok,
      loop: operation === 'visual_fallback' ? 'slow' : vision.loop,
      models: Array.isArray(vision.views)
        ? [
            ...new Set(
              vision.views.flatMap((view: Record<string, unknown>) =>
                Array.isArray(view.stages)
                  ? view.stages
                      .map((s: Record<string, unknown>) => s.model)
                      .filter(Boolean)
                  : [],
              ),
            ),
          ]
        : [],
    });
    return result;
  } catch (error) {
    await record({
      ...base,
      kind: 'operation_failed',
      finished_at_ms: Date.now(),
      error: (error as Error).message,
    });
    throw error;
  }
}
