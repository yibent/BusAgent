const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Converts an ISO-8601 string to the `YYYY-MM-DD HH:MM:SS.mmm` MySQL DATETIME(3) form. */
export function toMysqlDatetime(iso: string): string {
  const d = new Date(iso);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
  );
}

/** Converts a `YYYY-MM-DD HH:MM:SS.mmm` MySQL DATETIME value back to ISO-8601. */
export function fromMysqlDatetime(value: string): string {
  return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
}
