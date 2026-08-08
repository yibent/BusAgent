function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const next = record[key];
      if (next !== undefined) {
        out[key] = sortValue(next);
      }
    }
    return out;
  }
  return value;
}

/** Canonical JSON serialization (sorted keys, stable across runs) used for snapshots and hashes. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2);
}
