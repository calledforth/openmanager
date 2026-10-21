import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_REGISTRY,
  readEnvironmentRegistry,
  upsertStoredEnvironment,
  writeEnvironmentRegistry,
} from '@openmanager/environment-client/connection'
import { createAppStatePageExit } from '../../src/storage/app-state'
import { CREDENTIAL_KEY_PREFIX, credentialStoreKey } from '../../src/storage/credential-key'
import { createPhoneStorage } from '../../src/storage/phone-storage'
import type { AsyncKeyValueStore } from '../../src/storage/ports'
import { createWriteQueue } from '../../src/storage/write-queue'
import { FakeSecureStore, TOKEN_A } from './fakes'

describe('credentialStoreKey', () => {
  it('only uses characters SecureStore accepts', () => {
    for (const id of ['env-studio', 'a_b', 'é/π', 'x'.repeat(256), 'ünï:cødé@host']) {
      expect(credentialStoreKey(id)).toMatch(/^[\w.-]+$/)
    }
  })

  it('never gives two environment IDs the same key', () => {
    const ids = ['a_b', 'a/b', 'a_002fb', 'a.b', 'a-b', 'A_b', 'a_005fb', 'é', '_00e9']
    const keys = ids.map(credentialStoreKey)
    expect(new Set(keys).size).toBe(ids.length)
    expect(credentialStoreKey('env-studio')).toBe(`${CREDENTIAL_KEY_PREFIX}env-studio`)
  })
})

describe('createWriteQueue', () => {
  it('runs writes one at a time, in order, and carries on past a failure', async () => {
    const queue = createWriteQueue()
    const ran: string[] = []
    let running = 0
    const job = (key: string, fail = false) => ({
      key,
      coalesce: false,
      run: async () => {
        running += 1
        expect(running).toBe(1)
        await new Promise((resolve) => setTimeout(resolve, 1))
        running -= 1
        ran.push(key)
        if (fail) throw new Error(key)
      },
    })
    const errors: unknown[] = []
    queue.enqueue(job('a'))
    queue.enqueue({ ...job('b', true), onError: (cause) => errors.push(cause) })
    queue.enqueue(job('c'))
    await queue.drained()
    expect(ran).toEqual(['a', 'b', 'c'])
    expect(errors).toHaveLength(1)
    expect(queue.size).toBe(0)
  })

  it('collapses only a waiting write to the same key at the tail', async () => {
    const queue = createWriteQueue()
    const ran: string[] = []
    const job = (key: string, value: string, coalesce = true) => ({
      key,
      coalesce,
      run: async () => void ran.push(`${key}=${value}`),
    })
    queue.enqueue(job('x', '1')) // starts at once
    queue.enqueue(job('x', '2'))
    queue.enqueue(job('x', '3')) // replaces 2
    queue.enqueue(job('y', '1'))
    queue.enqueue(job('x', '4')) // y sits between: kept apart
    queue.enqueue(job('s', '1', false))
    queue.enqueue(job('s', '2', false)) // not coalescing: both run
    await queue.drained()
    expect(ran).toEqual(['x=1', 'x=3', 'y=1', 'x=4', 's=1', 's=2'])
  })

  it('keeps going when a callback throws', async () => {
    const queue = createWriteQueue()
    const ran: string[] = []
    queue.enqueue({
      key: 'a',
      coalesce: false,
      run: async () => void ran.push('a'),
      onDone: () => {
        throw new Error('callback')
      },
    })
    queue.enqueue({ key: 'b', coalesce: false, run: async () => void ran.push('b') })
    await queue.drained()
    expect(ran).toEqual(['a', 'b'])
  })
})

describe('createAppStatePageExit', () => {
  it('flushes when the app leaves the foreground, and unsubscribes', () => {
    let listener: ((state: string) => void) | null = null
    const removed = vi.fn()
    const exit = createAppStatePageExit({
      addEventListener: (_type, next) => {
        listener = next
        return { remove: removed }
      },
    })
    const flush = vi.fn()
    const unsubscribe = exit(flush)
    listener!('active')
    expect(flush).not.toHaveBeenCalled()
    listener!('inactive')
    listener!('background')
    expect(flush).toHaveBeenCalledTimes(2)
    unsubscribe()
    expect(removed).toHaveBeenCalled()
  })
})

describe('with the AsyncStorage package’s own mock', () => {
  it('stores the registry without the credential', async () => {
    // The package's mock is written for Jest; `vi.fn` stands in for `jest.fn`.
    ;(globalThis as { jest?: unknown }).jest = { fn: vi.fn }
    const require = createRequire(import.meta.url)
    const mock =
      require('@react-native-async-storage/async-storage/jest/async-storage-mock') as AsyncKeyValueStore & {
        __INTERNAL_MOCK_STORAGE__: Record<string, string>
      }
    const secureStore = new FakeSecureStore()
    const storage = createPhoneStorage({ asyncStore: mock, secureStore })
    await storage.hydrate()
    const registry = upsertStoredEnvironment(EMPTY_REGISTRY, {
      environmentId: 'env-studio',
      endpoint: 'https://studio.example.com',
      credential: TOKEN_A,
    })!
    writeEnvironmentRegistry(registry, storage.registry)
    await storage.flush()
    expect(JSON.stringify(mock.__INTERNAL_MOCK_STORAGE__)).not.toContain(TOKEN_A)
    expect(secureStore.data.get(credentialStoreKey('env-studio'))).toBe(TOKEN_A)

    const relaunched = createPhoneStorage({ asyncStore: mock, secureStore })
    await relaunched.hydrate()
    expect(readEnvironmentRegistry(relaunched.registry)).toEqual(registry)
  })
})
