export interface SttPartial {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
}

export interface SttHandlers {
  onReady: () => void;
  onPartial: (partial: SttPartial) => void;
  onDone: (text: string) => void;
  onError: (error: Error) => void;
}

export interface SttConnection {
  sendAudio(chunk: Buffer): void;
  finalize(): void;
  done(): void;
  close(): void;
}

export interface SttConnectOptions {
  apiKey: string;
  wsUrl: string;
  model: string;
  sampleRate: number;
  encoding: string;
  language?: string;
  endpointingMs: number;
}

export type SttStreamFactory = (
  options: SttConnectOptions,
  handlers: SttHandlers,
) => SttConnection;
