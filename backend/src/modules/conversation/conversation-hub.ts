import { Injectable } from '@nestjs/common';
import { Logger } from '../../common/logger.js';

export type ConversationListener = (message: Record<string, unknown>) => void;

/** In-process fan-out from agents to a live browser session, keyed by correlation id. */
@Injectable()
export class ConversationHub {
  private readonly logger = new Logger('ConversationHub');
  private readonly listeners = new Map<string, Set<ConversationListener>>();

  subscribe(correlationId: string, listener: ConversationListener): () => void {
    let set = this.listeners.get(correlationId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(correlationId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(correlationId);
      }
    };
  }

  publish(correlationId: string, message: Record<string, unknown>): void {
    const set = this.listeners.get(correlationId);
    if (set === undefined || set.size === 0) {
      this.logger.debug(`no live session for ${correlationId} (${String(message.type)})`);
      return;
    }
    for (const listener of set) {
      listener(message);
    }
  }
}
