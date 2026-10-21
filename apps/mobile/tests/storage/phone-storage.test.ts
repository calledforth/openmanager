import { afterEach, describe, expect, it } from 'vitest'
import {
  EMPTY_REGISTRY,
  ENVIRONMENT_STORAGE_KEY,
  LEGACY_ENVIRONMENT_STORAGE_KEY,
  clearEnvironmentRegistry,
  exchangePairingToken,
  readEnvironmentRegistry,
  removeStoredEnvironment,
  selectStoredEnvironment,
  setStoredCredential,
  setStoredRouteHealth,
  upsertStoredEnvironment,
  writeEnvironmentRegistry,
  type EnvironmentRegistry,
} from '@openmanager/environment-client/connection'
import { credentialStoreKey } from '../../src/storage/credential-key'
import {
  CREDENTIAL_MANIFEST_KEY,
  DEVICE_KEY_PREFIX,
  PhoneStorageNotReadyError,
  createPhoneStorage,
  type PhoneStorage,
} from '../../src/storage/phone-storage'
import type { StorageWriteError } from '../../src/storage/ports'
import {
  TOKEN_A,
  TOKEN_B,
  TOKEN_C,
  activeIds,
  device,
  secretOf,
  storeContains,
  takeLeaks,
  type FakeAsyncStorage,
} from './fakes'

const STUDIO = 'env-studio'
const LAPTOP = 'env-laptop'
const NOW = new Date('2026-10-21T09:00:00.000Z')

async function booted(stores = device(), errors: StorageWriteError[] = []) {
  const storage = createPhoneStorage({ ...stores, onError: (error) => errors.push(error) })
  await storage.hydrate()
  return { ...stores, storage, errors }
}

/** Write through the shared function, as the connection does, and wait for the device. */
async function save(storage: PhoneStorage, registry: EnvironmentRegistry) {
  writeEnvironmentRegistry(registry, storage.registry)
  await storage.flush()
}

function paired(
  registry: EnvironmentRegistry = EMPTY_REGISTRY,
  environmentId = STUDIO,
  credential = TOKEN_A,
  endpoint = 'https://studio.example.com',
) {
  return upsertStoredEnvironment(
    registry,
    { environmentId, endpoint, label: environmentId, credential },
    NOW,
  )!
}

function storedDocument(asyncStore: FakeAsyncStorage) {
  return JSON.parse(asyncStore.data.get(ENVIRONMENT_STORAGE_KEY)!) as {
    version: number
    selectedId: string | null
    environments: Array<Record<string, unknown>>
  }
}

// Checked on every write, not only at the end: no token may pass through AsyncStorage.
afterEach(() => {
  expect(takeLeaks()).toEqual([])
})

describe('the registry through the shared functions', () => {
  it('reads back exactly what was written, credentials included', async () => {
    const { storage } = await booted()
    const registry = paired(paired(), LAPTOP, TOKEN_B, 'http://127.0.0.1:43120')
    await save(storage, registry)
    expect(readEnvironmentRegistry(storage.registry)).toEqual(registry)
  })

  it('keeps every credential out of AsyncStorage and in SecureStore by environment ID', async () => {
    const { storage, asyncStore, secureStore } = await booted()
    let registry = paired(paired(), LAPTOP, TOKEN_B, 'http://127.0.0.1:43120')
    await save(storage, registry)
    registry = setStoredRouteHealth(
      registry,
      STUDIO,
      'https://studio.example.com',
      { status: 'available' },
      NOW,
    )
    registry = selectStoredEnvironment(registry, LAPTOP)
    await save(storage, registry)

    for (const token of [TOKEN_A, TOKEN_B]) expect(storeContains(asyncStore, token)).toBe(false)
    const document = storedDocument(asyncStore)
    expect(document.environments.map((item) => Object.keys(item).sort())).toEqual([
      ['environmentId', 'label', 'routes'],
      ['environmentId', 'label', 'routes'],
    ])
    // Everything else the registry keeps is there, as written.
    expect(document).toMatchObject({ version: 2, selectedId: LAPTOP })
    expect(document.environments[0]!.routes).toEqual(registry.environments[0]!.routes)
    expect(secretOf(secureStore, STUDIO)).toBe(TOKEN_A)
    expect(secretOf(secureStore, LAPTOP)).toBe(TOKEN_B)
    expect(activeIds(asyncStore)).toEqual([LAPTOP, STUDIO])
  })

  it('keeps a pairing round trip out of AsyncStorage', async () => {
    const { storage, asyncStore, secureStore } = await booted()
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          environmentId: STUDIO,
          label: 'Studio',
          kind: 'paired',
          clientId: 'client-phone',
          clientLabel: 'Pixel',
          grant: ['read', 'operate'],
          credential: TOKEN_C,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    const answer = await exchangePairingToken(
      'https://studio.example.com',
      { token: 'pairing-token', label: 'Pixel' },
      fetchImpl,
    )
    const registry = upsertStoredEnvironment(readEnvironmentRegistry(storage.registry), {
      environmentId: answer.environmentId,
      endpoint: 'https://studio.example.com',
      label: answer.label,
      credential: answer.credential,
    })!
    await save(storage, registry)
    expect(storeContains(asyncStore, TOKEN_C)).toBe(false)
    expect(secretOf(secureStore, STUDIO)).toBe(TOKEN_C)
    expect(readEnvironmentRegistry(storage.registry).environments[0]!.credential).toBe(TOKEN_C)
  })

  it('moves a rotated credential in SecureStore and never shows either in AsyncStorage', async () => {
    const { storage, asyncStore, secureStore } = await booted()
    await save(storage, paired())
    await save(storage, setStoredCredential(paired(), STUDIO, TOKEN_B))
    expect(secretOf(secureStore, STUDIO)).toBe(TOKEN_B)
    expect(storeContains(asyncStore, TOKEN_A)).toBe(false)
    expect(storeContains(asyncStore, TOKEN_B)).toBe(false)
  })

  it('forgets the SecureStore entry when the environment is removed', async () => {
    const { storage, asyncStore, secureStore } = await booted()
    const both = paired(paired(), LAPTOP, TOKEN_B, 'http://127.0.0.1:43120')
    await save(storage, both)
    await save(storage, removeStoredEnvironment(both, STUDIO))
    expect(secretOf(secureStore, STUDIO)).toBeNull()
    expect(secretOf(secureStore, LAPTOP)).toBe(TOKEN_B)
    expect(activeIds(asyncStore)).toEqual([LAPTOP])
  })

  it('forgets every credential when the registry is cleared', async () => {
    const { storage, asyncStore, secureStore } = await booted()
    await save(storage, paired(paired(), LAPTOP, TOKEN_B, 'http://127.0.0.1:43120'))
    clearEnvironmentRegistry(storage.registry)
    await storage.flush()
    expect(secureStore.data.size).toBe(0)
    expect(asyncStore.data.has(ENVIRONMENT_STORAGE_KEY)).toBe(false)
    expect(asyncStore.data.has(CREDENTIAL_MANIFEST_KEY)).toBe(false)
    expect(readEnvironmentRegistry(storage.registry)).toEqual(EMPTY_REGISTRY)
  })

  it('refuses to store anything that is not a registry document', async () => {
    const { storage, asyncStore } = await booted()
    expect(() => storage.registry.setItem(ENVIRONMENT_STORAGE_KEY, TOKEN_A)).toThrow()
    expect(() => storage.registry.setItem('other', '{}')).toThrow()
    expect(() => storage.registry.setItem(LEGACY_ENVIRONMENT_STORAGE_KEY, '{}')).toThrow()
    await storage.flush()
    expect(asyncStore.data.size).toBe(0)
  })

  it('refuses a document that still carries a credential outside its credential field', async () => {
    const { storage, asyncStore } = await booted()
    await save(storage, paired())
    const before = asyncStore.data.get(ENVIRONMENT_STORAGE_KEY)
    const sneaky = JSON.stringify({
      version: 2,
      selectedId: STUDIO,
      environments: [
        {
          environmentId: STUDIO,
          label: `copied ${TOKEN_A}`,
          routes: paired().environments[0]!.routes,
          credential: TOKEN_A,
        },
      ],
    })
    expect(() => storage.registry.setItem(ENVIRONMENT_STORAGE_KEY, sneaky)).toThrow(/credential/)
    await storage.flush()
    expect(asyncStore.data.get(ENVIRONMENT_STORAGE_KEY)).toBe(before)
  })

  it('does not rewrite the legacy key on every write', async () => {
    const { storage, log } = await booted()
    await save(storage, paired())
    await save(storage, selectStoredEnvironment(paired(), STUDIO))
    expect(log.ops.filter((op) => op.key === LEGACY_ENVIRONMENT_STORAGE_KEY)).toEqual([])
  })
})

describe('hydration', () => {
  it('throws before hydrating, which the shared functions read as an empty, unsaved registry', async () => {
    const stores = device()
    const first = await booted(stores)
    await save(first.storage, paired())
    const snapshot = stores.asyncStore.dump()

    // The next launch, before its load finishes.
    const storage = createPhoneStorage(stores)
    expect(() => storage.registry.getItem(ENVIRONMENT_STORAGE_KEY)).toThrow(
      PhoneStorageNotReadyError,
    )
    expect(() => storage.device.getItem('anything')).toThrow(PhoneStorageNotReadyError)
    expect(readEnvironmentRegistry(storage.registry)).toEqual(EMPTY_REGISTRY)
    // A write this early is dropped rather than replacing what is on the device.
    writeEnvironmentRegistry(EMPTY_REGISTRY, storage.registry)
    clearEnvironmentRegistry(storage.registry)
    await storage.flush()
    expect(stores.asyncStore.dump()).toEqual(snapshot)
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_A)

    await storage.hydrate()
    expect(readEnvironmentRegistry(storage.registry)).toEqual(paired())
  })

  it('loads once however many callers wait for it', async () => {
    const stores = device()
    let reads = 0
    const multiGet = stores.asyncStore.multiGet.bind(stores.asyncStore)
    stores.asyncStore.multiGet = async (keys) => {
      reads += 1
      return multiGet(keys)
    }
    const storage = createPhoneStorage(stores)
    const loads = [storage.hydrate(), storage.hydrate(), storage.hydrate()]
    expect(new Set(loads).size).toBe(1)
    await Promise.all(loads)
    await storage.hydrate()
    expect(reads).toBe(1)
    expect(storage.hydrated).toBe(true)
  })

  it('stays unloaded after a failed load, and loads on the next try', async () => {
    const stores = device()
    const first = await booted(stores)
    await save(first.storage, paired())
    stores.asyncStore.failReads = true
    const storage = createPhoneStorage(stores)
    await expect(storage.hydrate()).rejects.toThrow('read failed')
    expect(storage.hydrated).toBe(false)
    expect(readEnvironmentRegistry(storage.registry)).toEqual(EMPTY_REGISTRY)
    stores.asyncStore.failReads = false
    await storage.hydrate()
    expect(readEnvironmentRegistry(storage.registry)).toEqual(paired())
  })

  it('keeps environments and credentials across an app update', async () => {
    const stores = device()
    const before = await booted(stores)
    const registry = paired(paired(), LAPTOP, TOKEN_B, 'http://127.0.0.1:43120')
    await save(before.storage, registry)
    // An update keeps AsyncStorage and SecureStore; the new build starts afresh in memory.
    const after = await booted(stores)
    expect(readEnvironmentRegistry(after.storage.registry)).toEqual(registry)
  })

  it('starts clean after a reinstall, whatever an old install left in the iOS Keychain', async () => {
    const stores = device()
    const old = await booted(stores)
    await save(old.storage, paired())
    // Uninstalling wipes AsyncStorage; on iOS the Keychain entry survives.
    stores.asyncStore.data.clear()
    const fresh = await booted(stores)
    expect(readEnvironmentRegistry(fresh.storage.registry)).toEqual(EMPTY_REGISTRY)
    // Even the same environment, added again without pairing, does not pick
    // the old install's credential back up, now or on the next launch.
    await save(fresh.storage, paired(EMPTY_REGISTRY, STUDIO, ''))
    expect(readEnvironmentRegistry(fresh.storage.registry).environments[0]!.credential).toBe('')
    const relaunched = await booted(stores)
    expect(readEnvironmentRegistry(relaunched.storage.registry).environments[0]!.credential).toBe(
      '',
    )
  })

  it('upgrades a version-1 registry through the shared code, credentials split out', async () => {
    const stores = device()
    stores.asyncStore.data.set(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        selectedId: STUDIO,
        environments: [
          {
            environmentId: STUDIO,
            label: 'Studio',
            endpoints: ['https://studio.example.com', 'http://127.0.0.1:43120'],
            credential: TOKEN_A,
          },
        ],
      }),
    )
    const { storage, asyncStore, secureStore } = await booted(stores)
    // Booting already moved the credential to SecureStore.
    await storage.flush()
    expect(storeContains(asyncStore, TOKEN_A)).toBe(false)
    expect(secretOf(secureStore, STUDIO)).toBe(TOKEN_A)

    const registry = readEnvironmentRegistry(storage.registry)
    await storage.flush()
    expect(registry.environments[0]).toMatchObject({
      environmentId: STUDIO,
      credential: TOKEN_A,
      routes: [
        { endpoint: 'https://studio.example.com', priority: 0 },
        { endpoint: 'http://127.0.0.1:43120', priority: 1 },
      ],
    })
    // The shared code wrote the upgrade back, as version 2, still without the credential.
    expect(storedDocument(asyncStore).version).toBe(2)
    expect(storeContains(asyncStore, TOKEN_A)).toBe(false)
  })

  it('takes a credential it finds in AsyncStorage out, keeping the one SecureStore has', async () => {
    const stores = device()
    const first = await booted(stores)
    await save(first.storage, paired())
    // Something put credentials into the stored document.
    const document = storedDocument(stores.asyncStore)
    document.environments[0]!.credential = TOKEN_B
    stores.asyncStore.data.set(ENVIRONMENT_STORAGE_KEY, JSON.stringify(document))

    const { storage } = await booted(stores)
    await storage.flush()
    expect(storeContains(stores.asyncStore, TOKEN_B)).toBe(false)
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_A)
    expect(readEnvironmentRegistry(storage.registry).environments[0]!.credential).toBe(TOKEN_A)
  })

  it('forgets a credential whose environment the registry no longer lists', async () => {
    const stores = device()
    const first = await booted(stores)
    await save(first.storage, paired(paired(), LAPTOP, TOKEN_B, 'http://127.0.0.1:43120'))
    // A removal cut short after the registry write, before SecureStore forgot.
    const document = storedDocument(stores.asyncStore)
    document.environments = document.environments.filter((item) => item.environmentId !== STUDIO)
    stores.asyncStore.data.set(ENVIRONMENT_STORAGE_KEY, JSON.stringify(document))

    const { storage } = await booted(stores)
    await storage.flush()
    expect(secretOf(stores.secureStore, STUDIO)).toBeNull()
    expect(secretOf(stores.secureStore, LAPTOP)).toBe(TOKEN_B)
    expect(activeIds(stores.asyncStore)).toEqual([LAPTOP])
  })

  it('forgets every indexed credential when there is no registry at all', async () => {
    const stores = device()
    const first = await booted(stores)
    await save(first.storage, paired())
    stores.asyncStore.data.delete(ENVIRONMENT_STORAGE_KEY)
    const { storage } = await booted(stores)
    await storage.flush()
    expect(stores.secureStore.data.size).toBe(0)
    expect(stores.asyncStore.data.has(CREDENTIAL_MANIFEST_KEY)).toBe(false)
  })

  it('reads a credential SecureStore will not read as missing, and keeps it', async () => {
    const stores = device()
    const first = await booted(stores)
    await save(first.storage, paired(paired(), LAPTOP, TOKEN_B, 'http://127.0.0.1:43120'))
    stores.secureStore.unreadable.add(credentialStoreKey(STUDIO))

    const { storage, errors } = await booted(stores)
    expect(storage.unreadableCredentials).toEqual([STUDIO])
    expect(errors).toEqual([
      expect.objectContaining({
        store: 'secure',
        operation: 'read',
        key: expect.stringContaining(`${credentialStoreKey(STUDIO)}.`),
      }),
    ])
    const registry = readEnvironmentRegistry(storage.registry)
    expect(registry.environments.map((item) => item.credential)).toEqual(['', TOKEN_B])
    // Ordinary writes leave the unreadable credential where it is.
    await save(storage, selectStoredEnvironment(registry, LAPTOP))
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_A)
    // Removing the environment forgets it.
    await save(storage, removeStoredEnvironment(registry, STUDIO))
    expect(secretOf(stores.secureStore, STUDIO)).toBeNull()
  })
})

describe('writes', () => {
  it('reach the device in the order they were made, and the last one wins', async () => {
    const { storage, asyncStore, log } = await booted()
    log.hold()
    let registry = paired()
    const endpoint = 'https://studio.example.com'
    for (let index = 0; index < 50; index += 1) {
      registry = setStoredRouteHealth(
        registry,
        STUDIO,
        endpoint,
        { status: index % 2 ? 'available' : 'unreachable', message: `probe ${index}` },
        new Date(NOW.getTime() + index * 1000),
      )
      writeEnvironmentRegistry(registry, storage.registry)
    }
    // Memory already has the last write, before any of it reached the device.
    expect(readEnvironmentRegistry(storage.registry)).toEqual(registry)
    expect(asyncStore.data.has(ENVIRONMENT_STORAGE_KEY)).toBe(false)
    log.release()
    await storage.flush()
    expect(
      readEnvironmentRegistry({
        getItem: (key) => asyncStore.data.get(key) ?? null,
        setItem: () => undefined,
        removeItem: () => undefined,
      }).environments[0]!.routes,
    ).toEqual(registry.environments[0]!.routes)
    // A burst collapses: at most one write in flight and one waiting, not fifty.
    const registryWrites = log.ops.filter((op) => op.key === ENVIRONMENT_STORAGE_KEY)
    expect(registryWrites.length).toBeLessThanOrEqual(3)
  })

  it('names a slot in the manifest, saves the credential, writes the registry, then marks it active', async () => {
    const { storage, log, asyncStore } = await booted()
    const slot = expect.stringContaining(`${credentialStoreKey(STUDIO)}.`)
    await save(storage, paired())
    expect(log.ops).toEqual([
      { store: 'async', op: 'set', key: CREDENTIAL_MANIFEST_KEY },
      { store: 'secure', op: 'set', key: slot },
      { store: 'async', op: 'set', key: ENVIRONMENT_STORAGE_KEY },
      { store: 'async', op: 'set', key: CREDENTIAL_MANIFEST_KEY },
    ])
    expect(activeIds(asyncStore)).toEqual([STUDIO])
  })

  it('takes a removed credential out of the manifest first, then deletes it, then writes the registry', async () => {
    const { storage, log } = await booted()
    const slot = expect.stringContaining(`${credentialStoreKey(STUDIO)}.`)
    await save(storage, paired())
    log.ops = []
    await save(storage, removeStoredEnvironment(paired(), STUDIO))
    expect(log.ops).toEqual([
      { store: 'async', op: 'set', key: CREDENTIAL_MANIFEST_KEY },
      { store: 'secure', op: 'remove', key: slot },
      { store: 'async', op: 'set', key: ENVIRONMENT_STORAGE_KEY },
      { store: 'async', op: 'remove', key: CREDENTIAL_MANIFEST_KEY },
    ])
  })

  it('forgets a removed environment credential even when the registry write fails', async () => {
    const stores = device()
    const { storage, errors } = await booted(stores)
    await save(storage, paired())
    stores.asyncStore.failing.add(ENVIRONMENT_STORAGE_KEY)
    await save(storage, removeStoredEnvironment(paired(), STUDIO))
    expect(secretOf(stores.secureStore, STUDIO)).toBeNull()
    expect(errors).toEqual([
      expect.objectContaining({ store: 'async', operation: 'set', key: ENVIRONMENT_STORAGE_KEY }),
    ])
    // The device still lists the environment, now without a credential: it
    // reads as needing to pair again rather than as paired.
    stores.asyncStore.failing.clear()
    const relaunched = await booted(stores)
    const registry = readEnvironmentRegistry(relaunched.storage.registry)
    expect(registry.environments).toHaveLength(1)
    expect(registry.environments[0]!.credential).toBe('')
  })

  it('tries a credential that could not be saved again with the next write', async () => {
    const stores = device()
    const { storage, errors } = await booted(stores)
    stores.secureStore.failing.add(credentialStoreKey(STUDIO))
    await save(storage, paired())
    expect(errors.map((error) => error.store)).toEqual(['secure'])
    // It still works for this run.
    expect(readEnvironmentRegistry(storage.registry).environments[0]!.credential).toBe(TOKEN_A)
    stores.secureStore.failing.clear()
    await save(storage, selectStoredEnvironment(paired(), STUDIO))
    await save(
      storage,
      setStoredRouteHealth(
        paired(),
        STUDIO,
        'https://studio.example.com',
        { status: 'available' },
        NOW,
      ),
    )
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_A)
  })

  it('tries a credential that could not be forgotten again with the next write', async () => {
    const stores = device()
    const { storage } = await booted(stores)
    const both = paired(paired(), LAPTOP, TOKEN_B, 'http://127.0.0.1:43120')
    await save(storage, both)
    stores.secureStore.failing.add(credentialStoreKey(STUDIO))
    const without = removeStoredEnvironment(both, STUDIO)
    await save(storage, without)
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_A)
    stores.secureStore.failing.clear()
    await save(storage, selectStoredEnvironment(without, LAPTOP))
    expect(secretOf(stores.secureStore, STUDIO)).toBeNull()
  })

  it('ends with the last credential when an environment is removed and paired again quickly', async () => {
    const { storage, secureStore, asyncStore, log } = await booted()
    await save(storage, paired())
    log.hold()
    writeEnvironmentRegistry(removeStoredEnvironment(paired(), STUDIO), storage.registry)
    writeEnvironmentRegistry(paired(EMPTY_REGISTRY, STUDIO, TOKEN_B), storage.registry)
    writeEnvironmentRegistry(removeStoredEnvironment(paired(), STUDIO), storage.registry)
    writeEnvironmentRegistry(paired(EMPTY_REGISTRY, STUDIO, TOKEN_C), storage.registry)
    log.release()
    await storage.flush()
    expect(secretOf(secureStore, STUDIO)).toBe(TOKEN_C)
    expect(activeIds(asyncStore)).toEqual([STUDIO])
    const relaunched = await booted({ log, asyncStore, secureStore })
    expect(readEnvironmentRegistry(relaunched.storage.registry).environments[0]!.credential).toBe(
      TOKEN_C,
    )
  })
})

describe('device storage', () => {
  it('reads synchronously, persists under its own prefix, and survives a relaunch', async () => {
    const stores = device()
    const { storage } = await booted(stores)
    const deviceStorage = storage.device
    deviceStorage.setItem('openmanager.sidebar.collapsed-workspaces', '["/repo"]')
    expect(deviceStorage.getItem('openmanager.sidebar.collapsed-workspaces')).toBe('["/repo"]')
    await storage.flush()
    expect(
      stores.asyncStore.data.get(`${DEVICE_KEY_PREFIX}openmanager.sidebar.collapsed-workspaces`),
    ).toBe('["/repo"]')
    // The same object every time: the providers depend on its identity.
    expect(storage.device).toBe(deviceStorage)

    const relaunched = await booted(stores)
    expect(relaunched.storage.device.getItem('openmanager.sidebar.collapsed-workspaces')).toBe(
      '["/repo"]',
    )
    relaunched.storage.device.removeItem('openmanager.sidebar.collapsed-workspaces')
    await relaunched.storage.flush()
    expect(stores.asyncStore.data.size).toBe(0)
  })
})
