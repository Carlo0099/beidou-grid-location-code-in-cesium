/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TIANDITU_TOKEN?: string;
  readonly VITE_CESIUM_ION_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    CESIUM_BASE_URL?: string;
    BeidouGridAPI?: import('./api/BeidouGridApi').BeidouGridPublicApi;
  }
}

export {};
