export interface PcmPlayer {
  configure(sampleRate: number): void;
  playBase64(base64: string): void;
  stop(): void;
}

export function createPcmPlayer(onEnded: () => void): PcmPlayer {
  let context: AudioContext | null = null;
  let sampleRate = 24_000;
  let nextTime = 0;
  let activeSources = 0;
  let endedTimer = 0;
  let generation = 0;

  const ensureContext = () => {
    if (context === null || context.state === 'closed') {
      context = new AudioContext({ sampleRate });
      nextTime = 0;
    }
    if (context.state === 'suspended') {
      void context.resume();
    }
    return context;
  };

  const scheduleEnded = (sourceGeneration: number) => {
    if (sourceGeneration !== generation || activeSources > 0) return;
    window.clearTimeout(endedTimer);
    endedTimer = window.setTimeout(() => {
      if (sourceGeneration === generation && activeSources === 0) onEnded();
    }, 100);
  };

  return {
    configure(nextSampleRate) {
      if (nextSampleRate <= 0 || nextSampleRate === sampleRate) return;
      sampleRate = nextSampleRate;
      generation += 1;
      if (context !== null && context.state !== 'closed') void context.close();
      context = null;
      nextTime = 0;
      activeSources = 0;
    },
    playBase64(base64) {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const sampleCount = Math.floor(bytes.byteLength / 2);
      if (sampleCount === 0) return;

      const audioContext = ensureContext();
      const pcm = new Float32Array(sampleCount);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let index = 0; index < sampleCount; index += 1) {
        pcm[index] = view.getInt16(index * 2, true) / 0x8000;
      }

      const buffer = audioContext.createBuffer(1, sampleCount, sampleRate);
      buffer.copyToChannel(pcm, 0);
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      const startsAt = Math.max(audioContext.currentTime, nextTime);
      const sourceGeneration = generation;
      source.start(startsAt);
      nextTime = startsAt + buffer.duration;
      activeSources += 1;
      source.onended = () => {
        if (sourceGeneration !== generation) return;
        activeSources -= 1;
        scheduleEnded(sourceGeneration);
      };
    },
    stop() {
      generation += 1;
      activeSources = 0;
      nextTime = 0;
      window.clearTimeout(endedTimer);
      if (context !== null && context.state !== 'closed') void context.close();
      context = null;
    },
  };
}
