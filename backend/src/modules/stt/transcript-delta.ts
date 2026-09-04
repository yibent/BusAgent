/**
 * Turns a cumulative STT hypothesis into small pieces for downstream agents.
 *
 * Uncommitted (interim) text is the current unstable tail and replaces the
 * previous uncommitted tail. Committed text is split into a few words or CJK
 * characters so listeners can start work before the utterance ends.
 */

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

export interface TranscriptDelta {
  seq: number;
  text: string;
  committed: boolean;
}

export interface TranscriptTick {
  deltas: TranscriptDelta[];
  finalText: string | null;
}

export class TranscriptDeltaEncoder {
  private committedPrefix = '';
  private lastUncommitted = '';
  private seq = 0;

  constructor(
    private readonly wordGroup = 4,
    private readonly charGroup = 6,
  ) {}

  push(cumulative: string, isFinal: boolean, speechFinal: boolean): TranscriptTick {
    const text = cumulative;
    const deltas: TranscriptDelta[] = [];

    if (!isFinal) {
      const suffix = suffixAfter(text, this.committedPrefix);
      if (suffix !== this.lastUncommitted) {
        this.lastUncommitted = suffix;
        if (suffix.length > 0) {
          this.seq += 1;
          deltas.push({ seq: this.seq, text: suffix, committed: false });
        }
      }
      return { deltas, finalText: null };
    }

    this.lastUncommitted = '';
    const suffix = suffixAfter(text, this.committedPrefix);
    if (suffix.length > 0) {
      for (const piece of splitFew(suffix, this.wordGroup, this.charGroup)) {
        this.seq += 1;
        deltas.push({ seq: this.seq, text: piece, committed: true });
      }
      this.committedPrefix = text;
    }

    if (!speechFinal) {
      return { deltas, finalText: null };
    }

    const finalText = this.committedPrefix.length > 0 ? this.committedPrefix : text;
    this.committedPrefix = '';
    this.lastUncommitted = '';
    return { deltas, finalText };
  }

  reset(): void {
    this.committedPrefix = '';
    this.lastUncommitted = '';
    this.seq = 0;
  }
}

export function suffixAfter(cumulative: string, prefix: string): string {
  if (prefix.length === 0) {
    return cumulative;
  }
  if (cumulative.startsWith(prefix)) {
    return cumulative.slice(prefix.length);
  }
  return cumulative;
}

export function splitFew(text: string, wordGroup: number, charGroup: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (CJK_RE.test(trimmed)) {
    const chars = [...trimmed];
    const pieces: string[] = [];
    for (let i = 0; i < chars.length; i += charGroup) {
      pieces.push(chars.slice(i, i + charGroup).join(''));
    }
    return pieces;
  }
  const words = trimmed.split(/\s+/);
  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += wordGroup) {
    pieces.push(words.slice(i, i + wordGroup).join(' '));
  }
  return pieces;
}
