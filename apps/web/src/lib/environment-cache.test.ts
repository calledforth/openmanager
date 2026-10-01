import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialState, createThreadState } from '@openmanager/environment-client'
import {
  createEnvironmentCache,
  environmentCacheName,
  readEnvironmentCache,
  writeEnvironmentCache,
} from './environment-cache'

function seed(environmentId = 'env-one') {
  const state = createInitialState()
  state.environment = { environmentId, name: 'Environment' }
  state.sessions = {
    session: {
      sessionId: 'session',
      workspaceId: 'workspace',
      title: 'Cached session',
      status: 'idle',
      threadIds: ['thread'],
    },
  }
  state.sessionOrder = ['session']
  state.activeSessionId = 'session'
  state.activeThreadId = 'thread'
  state.threads = {
    thread: createThreadState({ threadId: 'thread', sessionId: 'session' }, 'ready'),
  }
  state.threads.thread!.messages = [
    {
      messageId: 'message',
      threadId: 'thread',
      turnId: 'turn',
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
    },
  ]
  return state
}

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => vi.unstubAllGlobals())

describe('environment identity cache', () => {
  it('restores session selection and messages across a new cache instance', async () => {
    const cache = createEnvironmentCache()
    const store = await cache.getStore('env-one')
    store.update(() => seed())
    await writeEnvironmentCache('env-one', store.getState())
    const restored = await createEnvironmentCache().getStore('env-one')
    expect(restored.getState()).toMatchObject(seed())
    expect(await cache.getStore('env-one')).toBe(store)
  })

  it('isolates environments even when their domain IDs collide', async () => {
    await writeEnvironmentCache('env-one', seed())
    const other = seed('env-two')
    other.sessions.session!.title = 'Other environment'
    await writeEnvironmentCache('env-two', other)
    expect((await readEnvironmentCache('env-one'))!.sessions.session!.title).toBe('Cached session')
    expect((await readEnvironmentCache('env-two'))!.sessions.session!.title).toBe(
      'Other environment',
    )
    expect(environmentCacheName('env-one')).not.toBe(environmentCacheName('env-two'))
    await writeEnvironmentCache('env-two', seed())
    expect((await readEnvironmentCache('env-two'))!.sessions.session!.title).toBe(
      'Other environment',
    )
  })

  it('does not restore live connection state or pending commands', async () => {
    const state = seed()
    state.connection = {
      ...state.connection,
      phase: 'connected',
      hasConnected: true,
      capabilities: ['turn.send'],
    }
    state.threads.thread!.hydration = 'loading'
    state.threads.thread!.outbox = [{ commandId: 'send', text: 'Pending', status: 'pending' }]
    await writeEnvironmentCache('env-one', state)
    const restored = (await readEnvironmentCache('env-one'))!
    expect(restored.connection).toEqual(createInitialState().connection)
    expect(restored.threads.thread!.outbox).toEqual([])
    expect(restored.threads.thread!.hydration).toBe('idle')
    expect(state.threads.thread!.outbox).toHaveLength(1)
  })

  it('serializes overlapping writes and waits for the newest snapshot on reload', async () => {
    const older = seed()
    const newer = seed()
    newer.sessions.session!.title = 'Latest session'
    const first = writeEnvironmentCache('env-one', older)
    const second = writeEnvironmentCache('env-one', newer)
    const restored = await readEnvironmentCache('env-one')
    await Promise.all([first, second])
    expect(restored!.sessions.session!.title).toBe('Latest session')
  })

  it('continues with memory when IndexedDB is unavailable or throws', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const cache = createEnvironmentCache()
    const store = await cache.getStore('env-one')
    store.update(() => seed())
    await writeEnvironmentCache('env-one', store.getState())
    expect(await cache.getStore('env-one')).toBe(store)
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('Denied')
      },
    })
    expect(await readEnvironmentCache('env-one')).toBeNull()
  })
})
