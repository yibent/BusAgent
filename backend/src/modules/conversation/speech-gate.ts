import { Injectable } from '@nestjs/common';

const DEFAULT_HANGOVER_MS = 800;

/**
 * Blocks STT transcripts from entering a conversation while the assistant
 * is speaking, plus a short hangover so residual echo is not treated as
 * a user turn. Recording itself is left running.
 */
@Injectable()
export class SpeechGate {
  private readonly until = new Map<string, number>();

  beginSpeaking(conversationId: string): void {
    const floor = Date.now() + 400;
    const current = this.until.get(conversationId) ?? 0;
    this.until.set(conversationId, Math.max(current, floor));
  }

  /** Extend the blocked window by the playback duration of one audio chunk. */
  extendPlayback(conversationId: string, durationMs: number): void {
    if (durationMs <= 0) {
      return;
    }
    const now = Date.now();
    const current = this.until.get(conversationId) ?? now;
    this.until.set(conversationId, Math.max(current, now) + durationMs);
  }

  /** Browser reports that queued audio has finished playing. */
  playbackEnded(conversationId: string, hangoverMs = DEFAULT_HANGOVER_MS): void {
    this.until.set(conversationId, Date.now() + hangoverMs);
  }

  isBlocked(conversationId: string): boolean {
    const deadline = this.until.get(conversationId);
    if (deadline === undefined) {
      return false;
    }
    if (Date.now() >= deadline) {
      this.until.delete(conversationId);
      return false;
    }
    return true;
  }
}

export function pcm16MonoDurationMs(byteLength: number, sampleRate: number): number {
  if (byteLength <= 0 || sampleRate <= 0) {
    return 0;
  }
  return Math.ceil((byteLength / 2 / sampleRate) * 1000);
}
