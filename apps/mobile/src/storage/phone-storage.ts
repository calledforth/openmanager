/**
 * The phone's environment registry and device storage, kept where a phone
 * should keep them: the registry (environments, labels, routes, route health,
 * the selection) in AsyncStorage, and each environment's credential in
 * SecureStore under its environment ID. Never a credential in AsyncStorage.
 *
 * The seam. The shared registry functions (`readEnvironmentRegistry`,
 * `writeEnvironmentRegistry`, `clearEnvironmentRegistry`) take a synchronous
 * `RegistryStorage`, and the connection code reads it synchronously while it
 * renders and between socket reports. AsyncStorage and SecureStore are async.
 * So both are read once, at boot (`hydrate`), into memory; every read after
 * that is answered from memory, and every write changes memory at once and is
 * then carried out in the background, in order (`write-queue.ts`). Until
 * `hydrate` has finished every call throws, which the shared functions read
 * as an empty registry that is not saved, so nothing written before then can
 * overwrite what is on the device.
 *
 * The split. The shared registry document embeds each environment's
 * `credential`. At `ENVIRONMENT_STORAGE_KEY` this adapter takes the
 * credentials out before the document reaches AsyncStorage, keeps them in
 * SecureStore, and puts them back when the document is read, so the shared
 * code sees exactly what it wrote. One implementation of the registry logic;
 * only the storage differs.
 *
 * Order and crashes. For a new or changed credential: the credential index
 * names the environment, then SecureStore takes the credential, then the
 * registry is written. For a removed environment or a dropped credential:
 * SecureStore forgets the credential first, then the registry is written, and
 * the index forgets the environment once SecureStore has. Each step is tried
 * whether or not the one before it worked. So:
 *
 * - A credential is never left where nothing will find it: whatever is in
 *   SecureStore is named in the index, and an indexed environment the registry
 *   no longer lists is forgotten at the next write or the next boot.
 * - If the registry write fails after its environment's credential was
 *   deleted, the registry still lists the environment, without a credential:
 *   it reads as needing to pair again. The reverse (a credential for an
 *   environment the registry dropped) is the first case.
 * - If a credential could not be saved, it works until the app restarts and
 *   is tried again with the next registry write.
 *
 * Reinstalls. AsyncStorage is wiped on uninstall; on iOS a Keychain entry is
 * not. Only environments named in the index (in AsyncStorage) are ever read
 * from SecureStore, so a reinstalled app starts with nothing, whatever an
 * earlier install left in the Keychain.
 */
import {
  ENVIRONMENT_STORAGE_KEY,
  LEGACY_ENVIRONMENT_STORAGE_KEY,
  parseEnvironmentCredential,
  type EnvironmentRegistry,
  type EnvironmentRoute,
  type RegistryStorage,
  type StoredEnvironment,
} from '@openmanager/environment-client/connection'
import { credentialStoreKey } from './credential-key'
import type {
  AsyncKeyValueStore,
  SecureKeyValueStore,
  StorageErrorReporter,
  SyncKeyValueStore,
} from './ports'
import { createWriteQueue } from './write-queue'

/** The environments that may have a credential in SecureStore. IDs only. */
export const CREDENTIAL_INDEX_KEY = 'openmanager-credential-index'
/** AsyncStorage keys the device storage (`PhoneStorage.device`) owns. */
export const DEVICE_KEY_PREFIX = 'openmanager.device:'

/**
 * The fields this adapter knows the registry stores. A field added to the
 * shared records may be another secret, so this stops compiling until
 * someone decides where it belongs on the phone.
 */
type AssertNone<T extends never> = T
export type ReviewedRegistryFields = AssertNone<
  | Exclude<keyof EnvironmentRegistry, 'selectedId' | 'environments'>
  | Exclude<keyof StoredEnvironment, 'environmentId' | 'label' | 'routes' | 'credential'>
  | Exclude<keyof EnvironmentRoute, 'type' | 'endpoint' | 'priority' | 'health'>
>

/** Shorter values could turn up in a label by chance; real credentials are long and random. */
const LEAK_CHECK_MIN_LENGTH = 16

export class PhoneStorageNotReadyError extends Error {
  constructor() {
    super('Phone storage was used before it loaded. Await phoneStorage.hydrate() first.')
    this.name = 'PhoneStorageNotReadyError'
  }
}

export type PhoneStorage = {
  /**
   * For the shared registry functions. The same object for the life of the
   * app, as the connection code requires.
   */
  readonly registry: RegistryStorage
  /** For `EnvironmentApplicationOptions.storage`: what this phone remembers for itself. */
  readonly device: SyncKeyValueStore
  /**
   * Load both stores into memory. Call once at boot and wait for it before
   * anything reads the registry. Calling it again returns the same load; if a
   * load failed, the next call tries again.
   */
  hydrate(): Promise<void>
  readonly hydrated: boolean
  /** Resolves once every write asked for so far is on the device, or has failed. */
  flush(): Promise<void>
  /**
   * Environments whose credential SecureStore refused to read during
   * `hydrate` (an iOS Keychain read before the first unlock, an Android
   * Keystore that lost its key). They read as needing to pair; their stored
   * credential is kept unless the environment is removed or paired again.
   */
  readonly unreadableCredentials: readonly string[]
}

export type PhoneStorageOptions = {
  asyncStore: AsyncKeyValueStore
  secureStore: SecureKeyValueStore
  /** Told about every write that failed. Never given a value. */
  onError?: StorageErrorReporter
}

type SplitDocument = {
  /** The document as AsyncStorage keeps it: no credentials. */
  stripped: string
  credentials: Map<string, string>
  environmentIds: Set<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Take the credentials out of a registry document. Null for anything else. */
export function splitRegistryDocument(raw: string): SplitDocument | null {
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(document) || !Array.isArray(document.environments)) return null
  const credentials = new Map<string, string>()
  const environmentIds = new Set<string>()
  const environments = document.environments.map((item: unknown) => {
    if (!isRecord(item)) return item
    const { credential, ...rest } = item
    if (typeof rest.environmentId === 'string') {
      environmentIds.add(rest.environmentId)
      const parsed = typeof credential === 'string' ? parseEnvironmentCredential(credential) : ''
      if (parsed) credentials.set(rest.environmentId, parsed)
    }
    return rest
  })
  return { stripped: JSON.stringify({ ...document, environments }), credentials, environmentIds }
}

function parseIndex(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

export function createPhoneStorage(options: PhoneStorageOptions): PhoneStorage {
  const { asyncStore, secureStore } = options
  const report: StorageErrorReporter = options.onError ?? (() => undefined)
  const queue = createWriteQueue()

  let ready = false
  let loading: Promise<void> | null = null

  /** The registry document as AsyncStorage has it (or will): never a credential. */
  let registryRaw: string | null = null
  /** `registryRaw` with the credentials put back; `undefined` until asked for. */
  let joinedCache: string | null | undefined
  let legacyRaw: string | null = null
  /** The credential each environment has, as the registry last said. */
  let credentials = new Map<string, string>()
  /** Environments that may have a SecureStore entry, written or about to be. */
  const secretIds = new Set<string>()
  /** Credentials SecureStore would not read at boot; kept, never deleted implicitly. */
  const unreadable = new Set<string>()
  /** Credentials whose last save failed, to save again with the next write. */
  const unsaved = new Set<string>()
  /** The last SecureStore operation queued per environment, until it has run. */
  const secureTail = new Map<string, { op: 'set' | 'delete'; seq: number }>()
  let secureSeq = 0
  /** The index value last queued, so an unchanged index is not written again. */
  let indexValue: string | null = null
  const device = new Map<string, string>()

  const requireReady = () => {
    if (!ready) throw new PhoneStorageNotReadyError()
  }

  // --- background writes ----------------------------------------------------

  const asyncWrite = (key: string, value: string | null) => {
    queue.enqueue({
      key: `async:${key}`,
      coalesce: true,
      run: () => (value === null ? asyncStore.removeItem(key) : asyncStore.setItem(key, value)),
      onError: (cause) =>
        report({ store: 'async', operation: value === null ? 'remove' : 'set', key, cause }),
    })
  }

  const writeIndex = () => {
    const ids = [...secretIds].sort()
    const value = ids.length > 0 ? JSON.stringify(ids) : null
    if (value === indexValue) return
    indexValue = value
    asyncWrite(CREDENTIAL_INDEX_KEY, value)
  }

  const secureJob = (environmentId: string, op: 'set' | 'delete', credential = '') => {
    const seq = ++secureSeq
    secureTail.set(environmentId, { op, seq })
    const key = credentialStoreKey(environmentId)
    const settle = () => {
      if (secureTail.get(environmentId)?.seq === seq) secureTail.delete(environmentId)
    }
    queue.enqueue({
      key: `secure:${key}`,
      // Every SecureStore write runs, so each one's outcome is seen.
      coalesce: false,
      run: () =>
        op === 'set' ? secureStore.setItemAsync(key, credential) : secureStore.deleteItemAsync(key),
      onDone: () => {
        settle()
        if (op === 'set') {
          unsaved.delete(environmentId)
          return
        }
        // Forgotten for good, unless the registry has given it a credential since.
        if (!credentials.has(environmentId) && !unreadable.has(environmentId)) {
          secretIds.delete(environmentId)
          writeIndex()
        }
      },
      onError: (cause) => {
        settle()
        if (op === 'set' && credentials.get(environmentId) === credential) {
          unsaved.add(environmentId)
        }
        report({ store: 'secure', operation: op === 'set' ? 'set' : 'remove', key, cause })
      },
    })
  }

  /** Forget every credential the registry no longer gives an environment. */
  const deleteUnwanted = (listed: ReadonlySet<string>) => {
    for (const environmentId of secretIds) {
      if (credentials.has(environmentId)) continue
      // A credential that could not be read is kept while its environment is.
      if (unreadable.has(environmentId) && listed.has(environmentId)) continue
      unreadable.delete(environmentId)
      if (secureTail.get(environmentId)?.op === 'delete') continue
      secureJob(environmentId, 'delete')
    }
  }

  // --- the registry document ------------------------------------------------

  /**
   * Make `split` the registry: memory first, then the writes that put the
   * device in the same state, in the order the file comment gives. `stored`
   * is what AsyncStorage holds now, so an unchanged document is not rewritten.
   */
  const applyRegistry = (split: SplitDocument | null, stored: string | null) => {
    const previous = credentials
    credentials = split ? new Map(split.credentials) : new Map()
    registryRaw = split ? split.stripped : null
    joinedCache = undefined

    const changed: Array<[string, string]> = []
    for (const [environmentId, credential] of credentials) {
      unreadable.delete(environmentId)
      if (previous.get(environmentId) !== credential || unsaved.has(environmentId)) {
        changed.push([environmentId, credential])
      }
    }
    for (const environmentId of unsaved) {
      if (!credentials.has(environmentId)) unsaved.delete(environmentId)
    }

    // The index names an environment before SecureStore holds its credential.
    let named = false
    for (const [environmentId] of changed) {
      if (!secretIds.has(environmentId)) {
        secretIds.add(environmentId)
        named = true
      }
    }
    if (named) writeIndex()
    deleteUnwanted(split ? split.environmentIds : new Set())
    for (const [environmentId, credential] of changed) secureJob(environmentId, 'set', credential)
    if (registryRaw !== stored) asyncWrite(ENVIRONMENT_STORAGE_KEY, registryRaw)
  }

  const writeRegistryDocument = (raw: string) => {
    const split = splitRegistryDocument(raw)
    // Never store what cannot be split: it might carry a credential.
    if (!split) throw new Error('Not an environment registry document; not stored.')
    for (const credential of [...split.credentials.values(), ...credentials.values()]) {
      if (credential.length >= LEAK_CHECK_MIN_LENGTH && split.stripped.includes(credential)) {
        throw new Error('A credential is still in the registry document; not stored.')
      }
    }
    applyRegistry(split, registryRaw)
  }

  const joinedRegistry = (): string | null => {
    if (registryRaw === null) return null
    if (joinedCache !== undefined) return joinedCache
    let document: unknown
    try {
      document = JSON.parse(registryRaw)
    } catch {
      document = null
    }
    if (!isRecord(document) || !Array.isArray(document.environments)) {
      joinedCache = registryRaw
      return joinedCache
    }
    const environments = document.environments.map((item: unknown) =>
      isRecord(item) && typeof item.environmentId === 'string'
        ? { ...item, credential: credentials.get(item.environmentId) ?? '' }
        : item,
    )
    joinedCache = JSON.stringify({ ...document, environments })
    return joinedCache
  }

  const registry: RegistryStorage = {
    getItem(key) {
      requireReady()
      if (key === ENVIRONMENT_STORAGE_KEY) return joinedRegistry()
      if (key === LEGACY_ENVIRONMENT_STORAGE_KEY) return legacyRaw
      throw new Error(`Not a registry key: ${key}`)
    },
    setItem(key, value) {
      requireReady()
      // The shared code only ever writes the current document; the legacy
      // key is read once and removed.
      if (key !== ENVIRONMENT_STORAGE_KEY) throw new Error(`Not a registry key: ${key}`)
      writeRegistryDocument(value)
    },
    removeItem(key) {
      requireReady()
      if (key === ENVIRONMENT_STORAGE_KEY) {
        // Clearing the registry forgets every credential, unreadable ones too.
        unreadable.clear()
        applyRegistry(null, registryRaw)
        return
      }
      if (key === LEGACY_ENVIRONMENT_STORAGE_KEY) {
        // Removed on every registry write; only a real change is a write.
        if (legacyRaw === null) return
        legacyRaw = null
        asyncWrite(LEGACY_ENVIRONMENT_STORAGE_KEY, null)
        return
      }
      throw new Error(`Not a registry key: ${key}`)
    },
  }

  // --- device storage -------------------------------------------------------

  const deviceStorage: SyncKeyValueStore = {
    getItem(key) {
      requireReady()
      return device.get(key) ?? null
    },
    setItem(key, value) {
      requireReady()
      if (device.get(key) === value) return
      device.set(key, value)
      asyncWrite(DEVICE_KEY_PREFIX + key, value)
    },
    removeItem(key) {
      requireReady()
      if (!device.has(key)) return
      device.delete(key)
      asyncWrite(DEVICE_KEY_PREFIX + key, null)
    },
  }

  // --- boot -----------------------------------------------------------------

  const readSecret = async (environmentId: string) => {
    const key = credentialStoreKey(environmentId)
    try {
      return { environmentId, credential: await secureStore.getItemAsync(key) }
    } catch (cause) {
      report({ store: 'secure', operation: 'read', key, cause })
      return { environmentId, credential: undefined }
    }
  }

  const load = async () => {
    const [stored, allKeys] = await Promise.all([
      asyncStore.multiGet([
        ENVIRONMENT_STORAGE_KEY,
        LEGACY_ENVIRONMENT_STORAGE_KEY,
        CREDENTIAL_INDEX_KEY,
      ]),
      asyncStore.getAllKeys(),
    ])
    const value = (key: string) => stored.find(([name]) => name === key)?.[1] ?? null
    const deviceKeys = allKeys.filter((key) => key.startsWith(DEVICE_KEY_PREFIX))
    const deviceEntries = deviceKeys.length > 0 ? await asyncStore.multiGet(deviceKeys) : []
    const indexRaw = value(CREDENTIAL_INDEX_KEY)
    const reads = await Promise.all(parseIndex(indexRaw).map(readSecret))

    // Nothing above changed any state, so a load that threw can be retried.
    indexValue = indexRaw
    /** What SecureStore holds now. */
    const saved = new Map<string, string>()
    for (const { environmentId, credential } of reads) {
      secretIds.add(environmentId)
      if (credential === undefined) unreadable.add(environmentId)
      else if (credential !== null) {
        const parsed = parseEnvironmentCredential(credential)
        if (parsed) saved.set(environmentId, parsed)
      }
    }
    for (const [key, item] of deviceEntries) {
      if (item !== null) device.set(key.slice(DEVICE_KEY_PREFIX.length), item)
    }
    legacyRaw = value(LEGACY_ENVIRONMENT_STORAGE_KEY)
    credentials = saved
    ready = true

    const raw = value(ENVIRONMENT_STORAGE_KEY)
    registryRaw = raw
    if (raw === null) {
      // No registry: every indexed credential is left over from a clear or a
      // removal cut short, so it goes.
      applyRegistry(null, null)
      return
    }
    const split = splitRegistryDocument(raw)
    // A document that cannot be read is left as it is: the shared code reads
    // it as empty, and its next write replaces it.
    if (!split) return
    // Each listed environment gets what SecureStore holds. A credential found
    // in AsyncStorage (it should never be there) moves to SecureStore when
    // SecureStore has none, and is taken out of AsyncStorage either way.
    const listed = new Map<string, string>()
    for (const environmentId of split.environmentIds) {
      const credential = saved.get(environmentId) ?? split.credentials.get(environmentId)
      if (credential) listed.set(environmentId, credential)
    }
    applyRegistry({ ...split, credentials: listed }, raw)
  }

  return {
    registry,
    device: deviceStorage,
    hydrate() {
      if (ready) return Promise.resolve()
      if (!loading) {
        loading = load().catch((error: unknown) => {
          loading = null
          throw error
        })
      }
      return loading
    },
    get hydrated() {
      return ready
    },
    flush: () => queue.drained(),
    get unreadableCredentials() {
      return [...unreadable]
    },
  }
}
