/**
 * The two device stores the phone keeps its environments in, as the subsets
 * this module uses. `@react-native-async-storage/async-storage` and
 * `expo-secure-store` satisfy them as they are (see `index.ts`); the tests
 * hand in in-memory fakes. Nothing here imports React Native, so the logic
 * runs under Node.
 */

/** Unencrypted, async string storage: AsyncStorage. Wiped on uninstall. */
export interface AsyncKeyValueStore {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  getAllKeys(): Promise<readonly string[]>
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>
}

/**
 * Encrypted, async string storage: the iOS Keychain or the Android Keystore,
 * through `expo-secure-store`. Keys may only use `[A-Za-z0-9._-]`. On iOS an
 * entry outlives an uninstall, so this module only ever reads keys it wrote
 * during this install (see the credential manifest in `phone-storage.ts`).
 */
export interface SecureKeyValueStore {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string): Promise<void>
  deleteItemAsync(key: string): Promise<void>
}

/** Synchronous string storage in Web Storage's shape, as the shared code takes it. */
export interface SyncKeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Where a write that could not be carried out is reported. Never given a value. */
export type StorageErrorReporter = (error: StorageWriteError) => void

export type StorageWriteError = {
  /** Which store refused. */
  store: 'async' | 'secure'
  /** What was being done: `set`, `remove`, or `read` during hydration. */
  operation: 'set' | 'remove' | 'read'
  /** The store key. For SecureStore this names an environment, never a credential. */
  key: string
  cause: unknown
}
