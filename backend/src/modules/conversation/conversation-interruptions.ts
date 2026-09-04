import { Injectable } from '@nestjs/common';
import { ConversationHub } from './conversation-hub.js';

export type ConversationInterruptListener = (conversationId: string) => void;

/** Coordinates a human barge-in across dialogue generation, TTS, and the browser player. */
@Injectable()
export class ConversationInterruptions {
  private readonly listeners = new Set<ConversationInterruptListener>();

  constructor(private readonly hub: ConversationHub) {}

  subscribe(listener: ConversationInterruptListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  interrupt(conversationId: string): void {
    this.hub.publish(conversationId, { type: 'speech.interrupted' });
    for (const listener of this.listeners) {
      listener(conversationId);
    }
  }
}
