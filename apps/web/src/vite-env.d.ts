/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean
  readonly PROD: boolean
  readonly MODE: string
  readonly VITE_OPENMANAGER_LOCAL_OWNER_CLAIM_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
