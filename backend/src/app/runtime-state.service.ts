import { Injectable } from '@nestjs/common';
import { BusAgentError } from '../common/errors.js';
import type { AppSnapshot } from './startup-snapshot.js';

/** Holds the single active AppSnapshot; routing refuses to run before readiness. */
@Injectable()
export class RuntimeState {
  private snapshot: AppSnapshot | undefined;

  set(snapshot: AppSnapshot): void {
    this.snapshot = snapshot;
  }

  get current(): AppSnapshot {
    if (!this.snapshot) {
      throw new BusAgentError(
        'NOT_READY',
        'Host is not ready; no app snapshot has been loaded',
      );
    }
    return this.snapshot;
  }

  isReady(): boolean {
    return this.snapshot !== undefined;
  }
}
