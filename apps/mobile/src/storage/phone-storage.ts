/**
 * The phone's environment registry and device storage, kept where a phone
 * should keep them: the registry (environments, labels, routes, route health,
 * the selection) in AsyncStorage, and each environment's credential in
 * SecureStore. Never a credential in AsyncStorage.
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
 * The manifest. Every credential write goes to a new SecureStore slot
 * (`credential-key.ts`). The manifest in AsyncStorage (`CREDENTIAL_MANIFEST_KEY`,
 * keys and environment IDs only) says which slot is each environment's
 * credential (`active`), which slot its current credential is being written
 * to (`pending`), and which other slots may exist and are to be deleted
 * (`retired`). It is the only thing boot reads SecureStore from:
 *
 * - A slot is written only after a saved manifest names it, so nothing in
 *   SecureStore is ever unfindable. A manifest write that fails is tried again
 *   with the next write, and the slot waits for it.
 * - A slot becomes `active` only after its credential is saved. Until then it
 *   is `pending`; boot makes a pending slot active if SecureStore has it, so a
 *   confirmation that failed or was cut short does not lose the credential.
 *   Only the current credential is ever pending. A credential
 *   the registry drops (removed, or refused by the environment) leaves
 *   `active` at once: it is never read again, whether or not deleting its
 *   slot worked. A failed delete is tried again at the next write or boot.
 * - A changed credential leaves the old slot `retired` straight away, so a
 *   crash before the new one is saved reads as needing to pair, never as the
 *   old credential.
 * - Slots no manifest names (an earlier install's, since on iOS a Keychain
 *   entry outlives an uninstall while AsyncStorage does not) are never read.
 *   A reinstall starts clean.
 *
 * If the registry write fails, the device keeps the previous registry; the
 * credential state follows the manifest. An environment the registry lists
 * whose credential the manifest does not reads as needing to pair again.
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
import { credentialSlotKey, isCredentialSlotKey } from './credential-key'
import type {
  AsyncKeyValueStore,
  SecureKeyValueStore,
  StorageErrorReporter,
  SyncKeyValueStore,
} from './ports'
import { createWriteQueue } from './write-queue'

/** Which SecureStore slot holds which environment's credential. Keys and IDs only. */
export const CREDENTIAL_MANIFEST_KEY = 'openmanager-credential-manifest'
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
  // `appOrigin`: the pairing link's web app origin, sent as the socket's
  // Origin. Public (any page on that origin names it); kept in AsyncStorage.
  | Exclude<
      keyof StoredEnvironment,
      'environmentId' | 'label' | 'routes' | 'credential' | 'appOrigin'
    >
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
   * Write again what AsyncStorage last refused (the registry, device
   * storage). Also done at every registry or device write; call it when the
   * app leaves the foreground (`subscribePhonePageExit` does).
   */
  retryFailedWrites(): void
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
  /** Told about every write that failed, and about anything boot removed. Never given a value. */
  onError?: StorageErrorReporter
}

type SplitDocument = {
  /** The document as AsyncStorage keeps it: no credentials. */
  stripped: string
  credentials: Map<string, string>
  environmentIds: Set<string>
}

type Manifest = {
  version: 1
  /** Environment ID to the slot holding its credential. */
  active: Record<string, string>
  /**
   * Environment ID to the slot its current credential is being written to,
   * not yet confirmed. Boot makes it active if SecureStore has it, so a
   * failed or cut-short confirmation does not lose a saved credential.
   */
  pending: Record<string, string>
  /** Slots that may exist and are not anyone's credential: to be deleted. */
  retired: string[]
}

type Slot = {
  environmentId: string
  /** What the slot holds or is to hold; empty for one read back unreadable or retired. */
  credential: string
  /** SecureStore has confirmed the write (or boot read it back). */
  written: boolean
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

const EMPTY_MANIFEST: Manifest = { version: 1, active: {}, pending: {}, retired: [] }

function slotsByEnvironment(raw: unknown): Record<string, string> {
  const slots: Record<string, string> = {}
  if (!isRecord(raw)) return slots
  for (const [environmentId, key] of Object.entries(raw)) {
    if (isCredentialSlotKey(key)) slots[environmentId] = key
  }
  return slots
}

const sortedByEnvironment = (slots: Record<string, string>) =>
  Object.fromEntries(Object.entries(slots).sort(([left], [right]) => (left < right ? -1 : 1)))

function parseManifest(raw: string | null): Manifest | null {
  if (raw === null) return EMPTY_MANIFEST
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.active)) return null
  if (!Array.isArray(parsed.retired)) return null
  return {
    version: 1,
    active: slotsByEnvironment(parsed.active),
    pending: slotsByEnvironment(parsed.pending),
    retired: parsed.retired.filter(isCredentialSlotKey),
  }
}

function namedIn(manifest: Manifest, key: string): boolean {
  return (
    manifest.retired.includes(key) ||
    Object.values(manifest.active).includes(key) ||
    Object.values(manifest.pending).includes(key)
  )
}

/** Whether `text` holds any of `credentials`. */
function holdsCredential(text: string, credentials: Iterable<string>): boolean {
  for (const credential of credentials) {
    if (credential.length >= LEAK_CHECK_MIN_LENGTH && text.includes(credential)) return true
  }
  return false
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
  /** Every SecureStore slot that may exist, by key, until its delete is confirmed. */
  const slots = new Map<string, Slot>()
  /** The slot holding, or about to hold, each environment's credential. */
  const current = new Map<string, string>()
  /** Active slots SecureStore would not read at boot: kept while their environment is. */
  const unreadable = new Map<string, string>()
  /** Slots with a SecureStore write queued or running. */
  const busy = new Set<string>()
  /** Slots whose last SecureStore write failed: tried again at the next registry write or boot. */
  const failed = new Set<string>()
  /** The manifest AsyncStorage holds, as far as this run has seen confirmed. */
  let persisted: Manifest = EMPTY_MANIFEST
  /** The manifest last queued; `undefined` when the last attempt failed. */
  let manifestQueued: string | null | undefined = null
  /** The last manifest write failed: wait for the next registry write before trying again. */
  let manifestFailed = false
  const device = new Map<string, string>()

  const requireReady = () => {
    if (!ready) throw new PhoneStorageNotReadyError()
  }

  // --- background writes ----------------------------------------------------

  /** The newest write asked for, per AsyncStorage key, so only its outcome counts. */
  const latestAsync = new Map<string, number>()
  let asyncSeq = 0
  /** AsyncStorage keys whose newest write failed, with the value it was to write. */
  const unsavedAsync = new Map<string, string | null>()

  const asyncWrite = (key: string, value: string | null) => {
    const seq = ++asyncSeq
    latestAsync.set(key, seq)
    unsavedAsync.delete(key)
    queue.enqueue({
      key: `async:${key}`,
      coalesce: true,
      run: () => (value === null ? asyncStore.removeItem(key) : asyncStore.setItem(key, value)),
      onDone: () => {
        if (latestAsync.get(key) === seq) latestAsync.delete(key)
      },
      onError: (cause) => {
        // Kept for the next write, or the app leaving the foreground; never
        // retried from here, so a disk that keeps refusing is not a loop.
        if (latestAsync.get(key) === seq) {
          latestAsync.delete(key)
          unsavedAsync.set(key, value)
        }
        report({ store: 'async', operation: value === null ? 'remove' : 'set', key, cause })
      },
    })
  }

  const retryFailedWrites = () => {
    for (const [key, value] of [...unsavedAsync]) asyncWrite(key, value)
  }

  const desiredManifest = (): Manifest => {
    const active: Record<string, string> = {}
    const pending: Record<string, string> = {}
    for (const [environmentId, key] of current) {
      if (slots.get(key)?.written) active[environmentId] = key
      else pending[environmentId] = key
    }
    for (const [environmentId, key] of unreadable) active[environmentId] = key
    const inUse = new Set([...Object.values(active), ...Object.values(pending)])
    const retired = [...slots.keys()].filter((key) => !inUse.has(key)).sort()
    return {
      version: 1,
      active: sortedByEnvironment(active),
      pending: sortedByEnvironment(pending),
      retired,
    }
  }

  const syncManifest = () => {
    const manifest = desiredManifest()
    const empty =
      Object.keys(manifest.active).length === 0 &&
      Object.keys(manifest.pending).length === 0 &&
      manifest.retired.length === 0
    const value = empty ? null : JSON.stringify(manifest)
    if (value === manifestQueued || manifestFailed) return
    manifestQueued = value
    queue.enqueue({
      key: `async:${CREDENTIAL_MANIFEST_KEY}`,
      coalesce: true,
      run: () =>
        value === null
          ? asyncStore.removeItem(CREDENTIAL_MANIFEST_KEY)
          : asyncStore.setItem(CREDENTIAL_MANIFEST_KEY, value),
      onDone: () => {
        persisted = manifest
        // A newer manifest got through: an older failure no longer holds
        // anything back, and whatever it held back (a slot becoming active)
        // is written now.
        manifestFailed = false
        reconcile()
      },
      onError: (cause) => {
        // Not saved. Only the newest manifest's failure counts: a newer one
        // already queued is tried anyway. Otherwise the next registry write
        // asks again, and slots wait for it.
        if (manifestQueued === value) {
          manifestQueued = undefined
          manifestFailed = true
        }
        report({
          store: 'async',
          operation: value === null ? 'remove' : 'set',
          key: CREDENTIAL_MANIFEST_KEY,
          cause,
        })
      },
    })
  }

  const secureJob = (key: string, op: 'set' | 'delete') => {
    const slot = slots.get(key)!
    busy.add(key)
    queue.enqueue({
      key: `secure:${key}`,
      // Every SecureStore write runs, so each one's outcome is seen.
      coalesce: false,
      run: async () => {
        if (op === 'delete') return secureStore.deleteItemAsync(key)
        // Superseded while it waited: the delete queued after it is all that is left to do.
        if (current.get(slot.environmentId) !== key) return
        // Nothing goes into SecureStore that a saved manifest does not name.
        if (!namedIn(persisted, key)) {
          throw new Error('The credential manifest was not saved, so the credential was not.')
        }
        return secureStore.setItemAsync(key, slot.credential)
      },
      onDone: () => {
        busy.delete(key)
        failed.delete(key)
        if (op === 'delete') slots.delete(key)
        else slot.written = true
        reconcile()
      },
      onError: (cause) => {
        busy.delete(key)
        failed.add(key)
        report({ store: 'secure', operation: op === 'set' ? 'set' : 'remove', key, cause })
        reconcile()
      },
    })
  }

  /**
   * Queue whatever brings the device to memory's state: the manifest first,
   * then each slot's write or delete. Slots that just failed wait for the next
   * registry write or boot, so a store that keeps refusing is not retried in
   * a loop.
   */
  const reconcile = () => {
    syncManifest()
    for (const [key, slot] of slots) {
      if (busy.has(key) || failed.has(key)) continue
      const inUse =
        current.get(slot.environmentId) === key || unreadable.get(slot.environmentId) === key
      if (!inUse) secureJob(key, 'delete')
      else if (!slot.written) secureJob(key, 'set')
    }
  }

  // --- the registry document ------------------------------------------------

  /**
   * Make `split` the registry: memory first, then the writes that put the
   * device in the same state. `stored` is what AsyncStorage holds now, so an
   * unchanged document is not rewritten.
   */
  const applyRegistry = (split: SplitDocument | null, stored: string | null) => {
    retryFailedWrites()
    credentials = split ? new Map(split.credentials) : new Map()
    const listed = split ? split.environmentIds : new Set<string>()
    registryRaw = split ? split.stripped : null
    joinedCache = undefined

    for (const [environmentId] of unreadable) {
      if (!listed.has(environmentId) || credentials.has(environmentId)) {
        unreadable.delete(environmentId)
      }
    }
    for (const [environmentId] of current) {
      if (!credentials.has(environmentId)) current.delete(environmentId)
    }
    for (const [environmentId, credential] of credentials) {
      const key = current.get(environmentId)
      if (key && slots.get(key)?.credential === credential) continue
      const next = credentialSlotKey(environmentId)
      slots.set(next, { environmentId, credential, written: false })
      current.set(environmentId, next)
    }
    // A registry write is when anything that failed is tried again.
    failed.clear()
    manifestFailed = false
    reconcile()
    if (registryRaw !== stored) asyncWrite(ENVIRONMENT_STORAGE_KEY, registryRaw)
  }

  const writeRegistryDocument = (raw: string) => {
    const split = splitRegistryDocument(raw)
    // Never store what cannot be split: it might carry a credential.
    if (!split) throw new Error('Not an environment registry document; not stored.')
    if (holdsCredential(split.stripped, [...split.credentials.values(), ...credentials.values()])) {
      throw new Error('A credential is still in the registry document; not stored.')
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
      retryFailedWrites()
      asyncWrite(DEVICE_KEY_PREFIX + key, value)
    },
    removeItem(key) {
      requireReady()
      if (!device.has(key)) return
      device.delete(key)
      retryFailedWrites()
      asyncWrite(DEVICE_KEY_PREFIX + key, null)
    },
  }

  // --- boot -----------------------------------------------------------------

  const readSlot = async (environmentId: string, key: string) => {
    try {
      return { environmentId, key, credential: await secureStore.getItemAsync(key) }
    } catch (cause) {
      report({ store: 'secure', operation: 'read', key, cause })
      return { environmentId, key, credential: undefined }
    }
  }

  const removedAtBoot = (key: string, why: string) =>
    report({ store: 'async', operation: 'read', key, cause: new Error(why) })

  const load = async () => {
    const [stored, allKeys] = await Promise.all([
      asyncStore.multiGet([
        ENVIRONMENT_STORAGE_KEY,
        LEGACY_ENVIRONMENT_STORAGE_KEY,
        CREDENTIAL_MANIFEST_KEY,
      ]),
      asyncStore.getAllKeys(),
    ])
    const value = (key: string) => stored.find(([name]) => name === key)?.[1] ?? null
    const deviceKeys = allKeys.filter((key) => key.startsWith(DEVICE_KEY_PREFIX))
    const deviceEntries = deviceKeys.length > 0 ? await asyncStore.multiGet(deviceKeys) : []
    const manifestRaw = value(CREDENTIAL_MANIFEST_KEY)
    const manifest = parseManifest(manifestRaw)
    const reads = await Promise.all(
      Object.entries(manifest?.active ?? {}).map(([environmentId, key]) =>
        readSlot(environmentId, key),
      ),
    )
    const pendingReads = await Promise.all(
      Object.entries(manifest?.pending ?? {}).map(([environmentId, key]) =>
        readSlot(environmentId, key),
      ),
    )

    // Nothing above changed any state, so a load that threw can be retried.
    if (!manifest) {
      // Its slots cannot be found again; their environments read as needing to pair.
      removedAtBoot(CREDENTIAL_MANIFEST_KEY, 'The credential manifest could not be read.')
    }
    persisted = manifest ?? EMPTY_MANIFEST
    manifestQueued = manifest ? manifestRaw : undefined
    /** What SecureStore holds now, for the environments the manifest names. */
    const saved = new Map<string, string>()
    for (const { environmentId, key, credential } of reads) {
      if (credential === undefined) {
        slots.set(key, { environmentId, credential: '', written: true })
        unreadable.set(environmentId, key)
        continue
      }
      const parsed = credential === null ? '' : parseEnvironmentCredential(credential)
      // A slot that is gone, or holds nothing usable, is retired.
      slots.set(key, { environmentId, credential: parsed, written: true })
      if (!parsed) continue
      saved.set(environmentId, parsed)
      current.set(environmentId, key)
    }
    // A pending slot SecureStore has is the newer credential: its write
    // landed and only the confirmation did not. One it does not have is
    // retired, and the active one, if any, stays. One it will not read is kept.
    for (const { environmentId, key, credential } of pendingReads) {
      if (credential === undefined) {
        // SecureStore would not say: kept, as an unreadable active slot is.
        // It is newer than any active slot the environment has.
        slots.set(key, { environmentId, credential: '', written: true })
        current.delete(environmentId)
        saved.delete(environmentId)
        unreadable.set(environmentId, key)
        continue
      }
      const parsed = credential === null ? '' : parseEnvironmentCredential(credential)
      slots.set(key, { environmentId, credential: parsed, written: true })
      if (!parsed) continue
      unreadable.delete(environmentId)
      saved.set(environmentId, parsed)
      current.set(environmentId, key)
    }
    for (const key of persisted.retired) {
      if (!slots.has(key)) slots.set(key, { environmentId: '', credential: '', written: true })
    }
    for (const [key, item] of deviceEntries) {
      if (item !== null) device.set(key.slice(DEVICE_KEY_PREFIX.length), item)
    }
    credentials = saved
    ready = true

    const raw = value(ENVIRONMENT_STORAGE_KEY)
    registryRaw = raw
    const split = raw === null ? null : splitRegistryDocument(raw)
    const known = [...saved.values(), ...(split?.credentials.values() ?? [])]

    legacyRaw = value(LEGACY_ENVIRONMENT_STORAGE_KEY)
    if (legacyRaw !== null && holdsCredential(legacyRaw, known)) {
      removedAtBoot(LEGACY_ENVIRONMENT_STORAGE_KEY, 'It held a credential; removed.')
      legacyRaw = null
      asyncWrite(LEGACY_ENVIRONMENT_STORAGE_KEY, null)
    }

    if (raw !== null && !split) {
      // The shared code reads it as empty anyway; it may hold anything, so it goes.
      removedAtBoot(ENVIRONMENT_STORAGE_KEY, 'Not a registry document; removed.')
      applyRegistry(null, raw)
      return
    }
    if (split && holdsCredential(split.stripped, known)) {
      // A credential outside its field (a label, a health message): the
      // document is not rewritten around it but removed, credentials and all.
      removedAtBoot(ENVIRONMENT_STORAGE_KEY, 'It held a credential outside its field; removed.')
      applyRegistry(null, raw)
      return
    }
    if (!split) {
      // No registry: every slot the manifest names is left over, so it goes.
      applyRegistry(null, null)
      return
    }
    // Each listed environment gets what SecureStore holds. A credential found
    // in AsyncStorage (it should never be there) moves to SecureStore when
    // SecureStore has none, and is taken out of AsyncStorage either way.
    const listed = new Map<string, string>()
    for (const environmentId of split.environmentIds) {
      const credential = saved.get(environmentId) ?? split.credentials.get(environmentId)
      if (credential && !unreadable.has(environmentId)) listed.set(environmentId, credential)
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
    retryFailedWrites() {
      if (ready) retryFailedWrites()
    },
    get unreadableCredentials() {
      return [...unreadable.keys()]
    },
  }
}
