import { credentialStoreKey } from '../../src/storage/credential-key'
import { CREDENTIAL_MANIFEST_KEY } from '../../src/storage/phone-storage'
import type { AsyncKeyValueStore, SecureKeyValueStore } from '../../src/storage/ports'

/** One write either store carried out, in the order they happened. */
export type StoreOp = { store: 'async' | 'secure'; op: 'set' | 'remove'; key: string }

/**
 * Both device stores share one log, so a test can read the order writes
 * reached the device across the two. `hold()` keeps every write waiting until
 * `release()`, to look at what is in flight.
 */
export class DeviceLog {
  ops: StoreOp[] = []
  private held: Array<() => void> | null = null

  hold() {
    this.held ??= []
  }

  release() {
    const waiting = this.held ?? []
    this.held = null
    for (const resolve of waiting) resolve()
  }

  async gate() {
    if (!this.held) return
    await new Promise<void>((resolve) => this.held!.push(resolve))
  }
}

/** Server-shaped credentials: long and random, as the environment mints them. */
export const TOKEN_A = 'tok_' + 'a1b2c3d4'.repeat(8)
export const TOKEN_B = 'tok_' + 'f9e8d7c6'.repeat(8)
export const TOKEN_C = 'tok_' + '0f1e2d3c'.repeat(8)
const TOKENS = [TOKEN_A, TOKEN_B, TOKEN_C]

/** Every AsyncStorage fake made, so a test file can check none was ever written a token. */
const created: FakeAsyncStorage[] = []

/** Every write that carried a token, across every fake made since the last call. Clears the list. */
export function takeLeaks(): string[] {
  const leaks = created.flatMap((store) => store.leaks)
  created.length = 0
  return leaks
}

/** AsyncStorage in memory: what `@react-native-async-storage/async-storage` does, minus the disk. */
export class FakeAsyncStorage implements AsyncKeyValueStore {
  readonly data = new Map<string, string>()
  /** Keys whose writes throw, as a full disk would. */
  readonly failing = new Set<string>()
  /** Keys whose next N writes throw. */
  readonly failNext = new Map<string, number>()
  failReads = false
  /** Writes that carried a token, as they happened, not just what is left at the end. */
  readonly leaks: string[] = []

  constructor(readonly log: DeviceLog = new DeviceLog()) {
    created.push(this)
  }

  async getItem(key: string) {
    if (this.failReads) throw new Error('read failed')
    return this.data.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    await this.log.gate()
    if (this.failing.has(key)) throw new Error(`disk full writing ${key}`)
    const left = this.failNext.get(key) ?? 0
    if (left > 0) {
      this.failNext.set(key, left - 1)
      throw new Error(`disk full writing ${key}`)
    }
    for (const token of TOKENS) {
      if (key.includes(token) || value.includes(token)) this.leaks.push(`${key} = ${value}`)
    }
    this.data.set(key, value)
    this.log.ops.push({ store: 'async', op: 'set', key })
  }
  async removeItem(key: string) {
    await this.log.gate()
    if (this.failing.has(key)) throw new Error(`disk full removing ${key}`)
    this.data.delete(key)
    this.log.ops.push({ store: 'async', op: 'remove', key })
  }
  async getAllKeys() {
    if (this.failReads) throw new Error('read failed')
    return [...this.data.keys()]
  }
  async multiGet(keys: readonly string[]) {
    if (this.failReads) throw new Error('read failed')
    return keys.map((key) => [key, this.data.get(key) ?? null] as const)
  }

  /** Every stored value, for scanning. */
  dump(): Record<string, string> {
    return Object.fromEntries(this.data)
  }
}

const SECURE_KEY = /^[\w.-]+$/

/** SecureStore in memory, with its key rule enforced. */
export class FakeSecureStore implements SecureKeyValueStore {
  readonly data = new Map<string, string>()
  /** Key prefixes whose writes throw. */
  readonly failing = new Set<string>()
  /** Key prefixes whose reads throw, as a Keychain read before first unlock does. */
  readonly unreadable = new Set<string>()

  constructor(readonly log: DeviceLog = new DeviceLog()) {}

  private check(key: string) {
    if (!SECURE_KEY.test(key)) throw new Error(`Invalid SecureStore key: ${key}`)
  }
  private matches(prefixes: Set<string>, key: string) {
    return [...prefixes].some((prefix) => key.startsWith(prefix))
  }
  async getItemAsync(key: string) {
    this.check(key)
    if (this.matches(this.unreadable, key)) throw new Error('User interaction is not allowed.')
    return this.data.get(key) ?? null
  }
  async setItemAsync(key: string, value: string) {
    this.check(key)
    await this.log.gate()
    if (this.matches(this.failing, key)) throw new Error('keystore refused')
    this.data.set(key, value)
    this.log.ops.push({ store: 'secure', op: 'set', key })
  }
  async deleteItemAsync(key: string) {
    this.check(key)
    await this.log.gate()
    if (this.matches(this.failing, key)) throw new Error('keystore refused')
    this.data.delete(key)
    this.log.ops.push({ store: 'secure', op: 'remove', key })
  }
}

/** A fresh pair of stores on one device log. */
export function device() {
  const log = new DeviceLog()
  return { log, asyncStore: new FakeAsyncStorage(log), secureStore: new FakeSecureStore(log) }
}

/** True when `token` appears anywhere in what the store holds, keys included. */
export function storeContains(store: FakeAsyncStorage, token: string): boolean {
  for (const [key, value] of store.data) {
    if (key.includes(token) || value.includes(token)) return true
  }
  return false
}

/**
 * The credential SecureStore holds for an environment, or null. Fails when
 * more than one slot is left for it: a write or delete that never finished.
 */
export function secretOf(secureStore: FakeSecureStore, environmentId: string): string | null {
  const prefix = `${credentialStoreKey(environmentId)}.`
  const values = [...secureStore.data].filter(([key]) => key.startsWith(prefix))
  if (values.length > 1) throw new Error(`${values.length} slots left for ${environmentId}`)
  return values[0]?.[1] ?? null
}

/** The environments the stored manifest says have a credential. */
export function activeIds(asyncStore: FakeAsyncStorage): string[] {
  const raw = asyncStore.data.get(CREDENTIAL_MANIFEST_KEY)
  return raw ? Object.keys((JSON.parse(raw) as { active: object }).active) : []
}
