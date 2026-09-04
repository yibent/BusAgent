/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUSAGENT_WS_URL?: string;
  readonly VITE_BUSAGENT_HTTP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
