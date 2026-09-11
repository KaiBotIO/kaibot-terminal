/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IS_DESKTOP: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
