/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly CONVEX_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
