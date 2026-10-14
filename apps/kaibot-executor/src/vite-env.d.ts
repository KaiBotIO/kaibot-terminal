/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IS_DESKTOP: boolean;
  readonly VITE_KAIBOT_EDITION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
