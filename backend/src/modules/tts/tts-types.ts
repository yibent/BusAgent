export interface TtsHandlers {
  onReady: () => void;
  onAudio: (base64Pcm: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

export interface TtsConnection {
  appendText(text: string): void;
  finish(): void;
  close(): void;
}

export interface TtsConnectOptions {
  apiKey: string;
  wsUrl: string;
  model: string;
  voice: string;
  sampleRate: number;
  languageType: string;
  speechRate?: number | undefined;
}

export type TtsStreamFactory = (
  options: TtsConnectOptions,
  handlers: TtsHandlers,
) => TtsConnection;
