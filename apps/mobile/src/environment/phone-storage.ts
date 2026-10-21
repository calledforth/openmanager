import type { DeviceStorage } from '@openmanager/app-core/logic'
import type { RegistryStorage } from '@openmanager/environment-client/connection'

/**
 * Where this phone keeps an environment's client token, by environment ID.
 * Its own store, apart from the registry, so a token never lands in plain
 * key-value storage. Asynchronous, as the phone's secure store is.
 */
export interface CredentialStore {
  getCredential(environmentId: string): Promise<string | null>
  setCredential(environmentId: string, credential: string): Promise<void>
  deleteCredential(environmentId: string): Promise<void>
}

/**
 * Everything the phone keeps between launches, in the shapes the shared code
 * takes.
 *
 * - `registry` is the `RegistryStorage` the shared registry functions in
 *   `@openmanager/environment-client/connection` read and write: environments,
 *   labels, routes, route health and the selected environment. It is
 *   synchronous, as those functions are, so a store that is asynchronous
 *   underneath (AsyncStorage) serves it from a copy filled by `ready()` and
 *   writes through. The controller only ever hands it registries with every
 *   credential blanked. The same store also keeps the phone's own record of
 *   each environment beside the registry, under `PHONE_APP_ORIGINS_STORAGE_KEY`
 *   (`app-origin.ts`): its app origin, the origin of the pairing link it was
 *   paired from, which the socket sends as `Origin`. An environment saved
 *   without one dials with the route's own origin and says so in the
 *   controller's `socketOrigin`.
 * - `credentials` holds the tokens the registry leaves out.
 * - `device` is app-core's `DeviceStorage`: what this device remembers for
 *   itself (folded sidebar rows, where a sent draft's address leads). Never
 *   anything the environment owns.
 *
 * `ready()` resolves once `registry` and `device` can be read. It is called
 * once, before the controller reads anything.
 *
 * The phone's real stores (AsyncStorage for `registry` and `device`,
 * SecureStore for `credentials`) plug in at `phone-storage-instance.ts`.
 * Until they do, the app runs on `createMemoryPhoneStorage()`, which forgets
 * everything when the app closes.
 */
export interface PhoneStorage {
  ready(): Promise<void>
  registry: RegistryStorage
  device: DeviceStorage
  credentials: CredentialStore
}

export function createMemoryKeyValueStorage(
  initial: Record<string, string> = {},
): RegistryStorage & DeviceStorage & { snapshot(): Record<string, string> } {
  const items = new Map(Object.entries(initial))
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, String(value))
    },
    removeItem: (key) => {
      items.delete(key)
    },
    snapshot: () => Object.fromEntries(items),
  }
}

export function createMemoryCredentialStore(
  initial: Record<string, string> = {},
): CredentialStore & { snapshot(): Record<string, string> } {
  const items = new Map(Object.entries(initial))
  return {
    getCredential: async (environmentId) => items.get(environmentId) ?? null,
    setCredential: async (environmentId, credential) => {
      items.set(environmentId, credential)
    },
    deleteCredential: async (environmentId) => {
      items.delete(environmentId)
    },
    snapshot: () => Object.fromEntries(items),
  }
}

/** Keeps everything in memory for the life of the process. */
export function createMemoryPhoneStorage(
  initial: {
    registry?: Record<string, string>
    device?: Record<string, string>
    credentials?: Record<string, string>
  } = {},
) {
  return {
    ready: async () => undefined,
    registry: createMemoryKeyValueStorage(initial.registry),
    device: createMemoryKeyValueStorage(initial.device),
    credentials: createMemoryCredentialStore(initial.credentials),
  } satisfies PhoneStorage
}
