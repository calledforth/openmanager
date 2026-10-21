/**
 * Failures and crashes between the separate writes a credential change takes:
 * each must leave the device in a state the next boot reads safely. A "crash"
 * here is a new storage object on the same stores, as the next launch is.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  EMPTY_REGISTRY,
  ENVIRONMENT_STORAGE_KEY,
  LEGACY_ENVIRONMENT_STORAGE_KEY,
  readEnvironmentRegistry,
  removeStoredEnvironment,
  selectStoredEnvironment,
  upsertStoredEnvironment,
  writeEnvironmentRegistry,
  type EnvironmentRegistry,
} from '@openmanager/environment-client/connection'
import { credentialSlotKey, credentialStoreKey } from '../../src/storage/credential-key'
import { forgetRejectedCredential } from '../../src/storage/credential-rejection'
import {
  CREDENTIAL_MANIFEST_KEY,
  DEVICE_KEY_PREFIX,
  PhoneStorageNotReadyError,
  createPhoneStorage,
  type PhoneStorage,
} from '../../src/storage/phone-storage'
import type { StorageWriteError } from '../../src/storage/ports'
import { TOKEN_A, TOKEN_B, activeIds, device, secretOf, storeContains, takeLeaks } from './fakes'

const STUDIO = 'env-studio'
const ENDPOINT = 'https://studio.example.com'

afterEach(() => {
  expect(takeLeaks()).toEqual([])
})

async function boot(stores: ReturnType<typeof device>, errors: StorageWriteError[] = []) {
  const storage = createPhoneStorage({ ...stores, onError: (error) => errors.push(error) })
  await storage.hydrate()
  await storage.flush()
  return storage
}

async function save(storage: PhoneStorage, registry: EnvironmentRegistry) {
  writeEnvironmentRegistry(registry, storage.registry)
  await storage.flush()
}

function withCredential(credential: string, registry: EnvironmentRegistry = EMPTY_REGISTRY) {
  return upsertStoredEnvironment(registry, {
    environmentId: STUDIO,
    endpoint: ENDPOINT,
    label: 'Studio',
    credential,
  })!
}

const credentialOf = (storage: PhoneStorage) =>
  readEnvironmentRegistry(storage.registry).environments[0]?.credential

describe('a revoked credential whose delete fails', () => {
  it('is never read again, and its slot is deleted once SecureStore allows', async () => {
    const stores = device()
    const storage = await boot(stores)
    await save(storage, withCredential(TOKEN_A))
    // The environment refused it; SecureStore refuses to delete it.
    stores.secureStore.failing.add(credentialStoreKey(STUDIO))
    await save(storage, forgetRejectedCredential(withCredential(TOKEN_A), STUDIO, TOKEN_A))
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_A)
    expect(activeIds(stores.asyncStore)).toEqual([])

    // The next launch does not send it again.
    const relaunched = await boot(stores)
    expect(credentialOf(relaunched)).toBe('')
    // And once SecureStore deletes again, the next boot clears the slot.
    stores.secureStore.failing.clear()
    await boot(stores)
    expect(secretOf(stores.secureStore, STUDIO)).toBeNull()
    expect(stores.asyncStore.data.has(CREDENTIAL_MANIFEST_KEY)).toBe(false)
  })
})

describe('a manifest write that fails', () => {
  it('keeps the credential out of SecureStore until a manifest names it, then saves both', async () => {
    const stores = device()
    const errors: StorageWriteError[] = []
    const storage = await boot(stores, errors)
    stores.asyncStore.failing.add(CREDENTIAL_MANIFEST_KEY)
    await save(storage, withCredential(TOKEN_A))
    // Nothing unfindable: the secret was not written without a saved manifest.
    expect(stores.secureStore.data.size).toBe(0)
    expect(
      errors.map((error) => [error.store, error.key.split('.').slice(0, 2).join('.')]),
    ).toEqual([
      ['async', CREDENTIAL_MANIFEST_KEY],
      ['secure', 'openmanager.credential'],
    ])
    // It still works for this run.
    expect(credentialOf(storage)).toBe(TOKEN_A)

    // The disk recovers; the next write (even an unchanged one) saves both.
    stores.asyncStore.failing.clear()
    await save(storage, selectStoredEnvironment(withCredential(TOKEN_A), STUDIO))
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_A)
    expect(activeIds(stores.asyncStore)).toEqual([STUDIO])

    // A restart finds it, and removing the environment then deletes it.
    const relaunched = await boot(stores)
    expect(credentialOf(relaunched)).toBe(TOKEN_A)
    await save(relaunched, removeStoredEnvironment(withCredential(TOKEN_A), STUDIO))
    expect(stores.secureStore.data.size).toBe(0)
  })
  it('keeps a saved credential when only the manifest write that would confirm it fails', async () => {
    // The manifest names the new slot as pending, SecureStore saves it, then
    // the write marking it active fails, and the app restarts before any
    // other write: boot finds it in SecureStore and makes it active.
    const stores = device()
    const storage = await boot(stores)
    stores.asyncStore.failAt.set(CREDENTIAL_MANIFEST_KEY, 2)
    await save(storage, withCredential(TOKEN_A))
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_A)
    expect(activeIds(stores.asyncStore)).toEqual([])
    const relaunched = await boot(stores)
    expect(credentialOf(relaunched)).toBe(TOKEN_A)
    expect(activeIds(stores.asyncStore)).toEqual([STUDIO])
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_A)
  })

  it('retires a revoked credential rather than leaving it pending', async () => {
    // Only the current credential is ever pending. (If the retirement write
    // and the delete both fail, a pending or active slot can still come back
    // at boot; see the known limit in README.md.)
    const stores = device()
    const storage = await boot(stores)
    await save(storage, withCredential(TOKEN_A))
    await save(storage, forgetRejectedCredential(withCredential(TOKEN_A), STUDIO, TOKEN_A))
    const raw = stores.asyncStore.data.get(CREDENTIAL_MANIFEST_KEY)
    expect(raw === undefined || !raw.includes('pending":{"')).toBe(true)
    expect(credentialOf(await boot(stores))).toBe('')
  })

  it('still activates a later credential when only an earlier manifest write failed', async () => {
    // Pair, then rotate before the first manifest write settles; only that
    // first write fails. The newer manifest gets through, and the rotated
    // credential must end up active, not retired and deleted at the next boot.
    const stores = device()
    const storage = await boot(stores)
    stores.log.hold()
    writeEnvironmentRegistry(withCredential(TOKEN_A), storage.registry)
    writeEnvironmentRegistry(withCredential(TOKEN_B), storage.registry)
    stores.asyncStore.failNext.set(CREDENTIAL_MANIFEST_KEY, 1)
    stores.log.release()
    await storage.flush()
    expect(activeIds(stores.asyncStore)).toEqual([STUDIO])
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_B)
    const relaunched = await boot(stores)
    expect(credentialOf(relaunched)).toBe(TOKEN_B)
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_B)
  })
})

describe('an AsyncStorage write that fails', () => {
  it('is not retried on its own, and is written again with the next write or on leaving the foreground', async () => {
    const stores = device()
    const errors: StorageWriteError[] = []
    const storage = await boot(stores, errors)
    stores.asyncStore.failing.add(ENVIRONMENT_STORAGE_KEY)
    await save(storage, withCredential(TOKEN_A))
    expect(stores.asyncStore.data.has(ENVIRONMENT_STORAGE_KEY)).toBe(false)
    // Nothing loops: draining again asks nothing more of the disk.
    const failures = errors.length
    await storage.flush()
    expect(errors.length).toBe(failures)

    // The disk recovers; a device-storage write carries the registry with it.
    stores.asyncStore.failing.clear()
    storage.device.setItem('theme', 'dark')
    await storage.flush()
    expect(stores.asyncStore.data.has(ENVIRONMENT_STORAGE_KEY)).toBe(true)
    // So the next boot still has the environment, and its credential.
    expect(credentialOf(await boot(stores))).toBe(TOKEN_A)
  })

  it('is written again when asked, as the app leaving the foreground does', async () => {
    const stores = device()
    const storage = await boot(stores)
    stores.asyncStore.failing.add(ENVIRONMENT_STORAGE_KEY)
    await save(storage, withCredential(TOKEN_A))
    stores.asyncStore.failing.clear()
    storage.retryFailedWrites()
    await storage.flush()
    expect(credentialOf(await boot(stores))).toBe(TOKEN_A)
    // Nothing left to write: asking again is not a write.
    stores.log.ops = []
    storage.retryFailedWrites()
    await storage.flush()
    expect(stores.log.ops).toEqual([])
  })
})

describe('a registry document that holds a credential at boot', () => {
  it('is removed rather than written back, when the credential is outside its field', async () => {
    const stores = device()
    const errors: StorageWriteError[] = []
    const document = JSON.parse(JSON.stringify({ version: 2, ...withCredential(TOKEN_A) })) as {
      environments: Array<{ label: string }>
    }
    document.environments[0]!.label = `pasted ${TOKEN_A}`
    stores.asyncStore.data.set(ENVIRONMENT_STORAGE_KEY, JSON.stringify(document))
    const storage = await boot(stores, errors)
    expect(storeContains(stores.asyncStore, TOKEN_A)).toBe(false)
    expect(stores.secureStore.data.size).toBe(0)
    expect(readEnvironmentRegistry(storage.registry)).toEqual(EMPTY_REGISTRY)
    expect(errors).toEqual([expect.objectContaining({ key: ENVIRONMENT_STORAGE_KEY })])
  })

  it('is removed when it is not a registry document at all', async () => {
    const stores = device()
    stores.asyncStore.data.set(ENVIRONMENT_STORAGE_KEY, `{"credential":"${TOKEN_A}"`)
    const storage = await boot(stores)
    expect(storeContains(stores.asyncStore, TOKEN_A)).toBe(false)
    expect(readEnvironmentRegistry(storage.registry)).toEqual(EMPTY_REGISTRY)
  })

  it('removes a legacy record that holds a credential SecureStore has', async () => {
    const stores = device()
    const first = await boot(stores)
    await save(first, withCredential(TOKEN_A))
    stores.asyncStore.data.set(
      LEGACY_ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({ endpoint: ENDPOINT, environmentId: STUDIO, token: TOKEN_A }),
    )
    await boot(stores)
    expect(storeContains(stores.asyncStore, TOKEN_A)).toBe(false)
  })
})

describe('an earlier install’s Keychain entries', () => {
  it('are never read, even when pairing again is cut short before the new credential is saved', async () => {
    const stores = device()
    const old = await boot(stores)
    await save(old, withCredential(TOKEN_A))
    // Uninstall: AsyncStorage goes, the iOS Keychain entry stays.
    stores.asyncStore.data.clear()
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_A)

    const fresh = await boot(stores)
    await save(fresh, withCredential(''))
    // Pairing again: the manifest names the new slot, then saving it fails
    // (the same state as a crash between the two).
    stores.secureStore.failing.add(credentialStoreKey(STUDIO))
    await save(fresh, withCredential(TOKEN_B))
    const relaunched = await boot(stores)
    expect(credentialOf(relaunched)).toBe('')
    // The old install's slot is still there, and still never read.
    expect(stores.secureStore.data.size).toBe(1)
    expect([...stores.secureStore.data.values()]).toEqual([TOKEN_A])
  })

  it('cannot be picked up through a forged manifest entry either', () => {
    // Slot keys are made fresh for every write, so a new install never
    // computes an old install's key.
    expect(credentialSlotKey(STUDIO)).not.toBe(credentialSlotKey(STUDIO))
  })
})

describe('reads and writes during hydration', () => {
  it('throw while the load is in flight, and the load is unaffected by them', async () => {
    const stores = device()
    const first = await boot(stores)
    await save(first, withCredential(TOKEN_A))
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const multiGet = stores.asyncStore.multiGet.bind(stores.asyncStore)
    stores.asyncStore.multiGet = async (keys) => {
      await held
      return multiGet(keys)
    }
    const storage = createPhoneStorage(stores)
    const loading = storage.hydrate()
    expect(() => storage.registry.getItem(ENVIRONMENT_STORAGE_KEY)).toThrow(
      PhoneStorageNotReadyError,
    )
    writeEnvironmentRegistry(EMPTY_REGISTRY, storage.registry)
    expect(storage.hydrated).toBe(false)
    release()
    await loading
    await storage.flush()
    expect(credentialOf(storage)).toBe(TOKEN_A)
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_A)
  })

  it('leaves nothing half loaded when a later read fails', async () => {
    const stores = device()
    const first = await boot(stores)
    await save(first, withCredential(TOKEN_A))
    first.device.setItem('theme', 'dark')
    await first.flush()
    let calls = 0
    const multiGet = stores.asyncStore.multiGet.bind(stores.asyncStore)
    stores.asyncStore.multiGet = async (keys) => {
      calls += 1
      // The registry read works; the device-storage read after it does not.
      if (calls === 2) throw new Error('read failed')
      return multiGet(keys)
    }
    const storage = createPhoneStorage(stores)
    await expect(storage.hydrate()).rejects.toThrow('read failed')
    expect(storage.hydrated).toBe(false)
    expect(() => storage.device.getItem('theme')).toThrow(PhoneStorageNotReadyError)
    await storage.hydrate()
    await storage.flush()
    expect(credentialOf(storage)).toBe(TOKEN_A)
    expect(storage.device.getItem('theme')).toBe('dark')
    expect(stores.asyncStore.data.has(`${DEVICE_KEY_PREFIX}theme`)).toBe(true)
  })
})

describe('rapid changes with a store refusing part of them', () => {
  it('end on the last credential, with the refused slot deleted once allowed', async () => {
    const stores = device()
    const storage = await boot(stores)
    await save(storage, withCredential(TOKEN_A))
    // The old slot cannot be deleted while the environment is removed and paired again.
    const oldSlot = [...stores.secureStore.data.keys()][0]!
    stores.secureStore.failing.add(oldSlot)
    stores.log.hold()
    writeEnvironmentRegistry(
      removeStoredEnvironment(withCredential(TOKEN_A), STUDIO),
      storage.registry,
    )
    writeEnvironmentRegistry(withCredential(TOKEN_B), storage.registry)
    stores.log.release()
    await storage.flush()
    expect(credentialOf(storage)).toBe(TOKEN_B)
    expect(stores.secureStore.data.get(oldSlot)).toBe(TOKEN_A)

    const relaunched = await boot(stores)
    expect(credentialOf(relaunched)).toBe(TOKEN_B)
    stores.secureStore.failing.clear()
    await boot(stores)
    expect(secretOf(stores.secureStore, STUDIO)).toBe(TOKEN_B)
  })
})
