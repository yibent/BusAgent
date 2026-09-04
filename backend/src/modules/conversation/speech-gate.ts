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
  private readonly assistantText = new Map<string, string>();

  startAssistantTurn(conversationId: string): void {
    this.assistantText.set(conversationId, '');
  }

  appendAssistantText(conversationId: string, text: string): void {
    const current = this.assistantText.get(conversationId) ?? '';
    this.assistantText.set(conversationId, `${current}${text}`.slice(-1000));
  }

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

  /** Immediately opens the STT gate once a human barge-in has been confirmed. */
  interrupt(conversationId: string): void {
    this.until.delete(conversationId);
  }

  /** Rejects playback echo by comparing ASR text with the current assistant reply. */
  isLikelyEcho(conversationId: string, transcript: string): boolean {
    const candidate = normalizeSpeechText(transcript);
    const assistant = normalizeSpeechText(this.assistantText.get(conversationId) ?? '');
    if (candidate.length === 0 || assistant.length === 0) return false;
    if (assistant.includes(candidate)) return true;
    return bestWindowDice(candidate, assistant) >= 0.58;
  }

  isBlocked(conversationId: string): boolean {
    const deadline = this.until.get(conversationId);
    if (deadline === undefined) {
      return false;
    }
    if (Date.now() >= deadline) {
      this.until.delete(conversationId);
      this.assistantText.delete(conversationId);
      return false;
    }
    return true;
  }
}

export function speechContentLength(text: string): number {
  return [...normalizeSpeechText(text)].length;
}

function normalizeSpeechText(text: string): string {
  return text.toLocaleLowerCase().replace(/[^a-z0-9\u3400-\u9fff\uf900-\ufaff]/g, '');
}

function bigramDice(left: string, right: string): number {
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
  const leftPairs = bigramCounts(left);
  const rightPairs = bigramCounts(right);
  let intersection = 0;
  for (const [pair, count] of leftPairs) {
    intersection += Math.min(count, rightPairs.get(pair) ?? 0);
  }
  const leftCount = [...leftPairs.values()].reduce((sum, count) => sum + count, 0);
  const rightCount = [...rightPairs.values()].reduce((sum, count) => sum + count, 0);
  return (2 * intersection) / (leftCount + rightCount);
}

function bestWindowDice(candidate: string, assistant: string): number {
  if (assistant.length <= candidate.length + 2) return bigramDice(candidate, assistant);
  const characters = [...assistant];
  const windowSize = Math.min(characters.length, [...candidate].length + 2);
  let best = 0;
  for (let index = 0; index <= characters.length - windowSize; index += 1) {
    best = Math.max(best, bigramDice(candidate, characters.slice(index, index + windowSize).join('')));
  }
  return best;
}

function bigramCounts(text: string): Map<string, number> {
  const characters = [...text];
  const counts = new Map<string, number>();
  for (let index = 0; index < characters.length - 1; index += 1) {
    const pair = `${characters[index]}${characters[index + 1]}`;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

export function pcm16MonoDurationMs(byteLength: number, sampleRate: number): number {
  if (byteLength <= 0 || sampleRate <= 0) {
    return 0;
  }
  return Math.ceil((byteLength / 2 / sampleRate) * 1000);
}
