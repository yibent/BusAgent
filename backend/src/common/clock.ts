/** Injectable time source so the host can be deterministic in tests. */
export abstract class Clock {
  abstract now(): string;
  abstract nowMs(): number;
}

export class SystemClock extends Clock {
  override now(): string {
    return new Date().toISOString();
  }

  override nowMs(): number {
    return Date.now();
  }
}
