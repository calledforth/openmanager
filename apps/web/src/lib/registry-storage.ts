import type { RegistryStorage } from '@openmanager/environment-client/connection'

/**
 * The browser's `localStorage`, as the environment registry's storage. It is
 * looked up on every call rather than once: reading `window.localStorage`
 * itself throws where storage is blocked (a sandboxed frame, some private
 * modes), and that throw has to land inside the registry functions, which
 * read it as an empty or unsaved registry.
 */
export const browserRegistryStorage: RegistryStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
}
