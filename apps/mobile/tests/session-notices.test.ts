import { describe, expect, it, vi } from 'vitest'
import {
  createInitialState,
  type ConnectionState,
  type EnvironmentClient,
  type EnvironmentState,
} from '@openmanager/environment-client'

import type { SessionWatchNative } from '../modules/session-watch'
import type { AppActivity, AppActivitySource } from '../src/environment/controller'
import { sessionOnPath } from '../src/notifications/notices'
import { createSessionWatch, NOTIFICATIONS_STORAGE_KEY } from '../src/notifications/watch'
import { notificationsRow } from '../src/settings/notifications'

type Row = { sessionId: string; title?: string; status: string; parentSessionId?: string }

const LIVE: Partial<ConnectionState> = { phase: 'connected', hasConnected: true, caughtUp: true }

function fakeClient(rows: Row[], connection: Partial<ConnectionState> = LIVE) {
  const listeners = new Set<() => void>()
  const sessions = (list: Row[]) =>
    Object.fromEntries(
      list.map((row) => [row.sessionId, { workspaceId: '/repo', providerId: 'cursor', ...row }]),
    ) as unknown as EnvironmentState['sessions']
  let state: EnvironmentState = {
    ...createInitialState(),
    sessions: sessions(rows),
    sessionOrder: rows.map((row) => row.sessionId),
    connection: { ...createInitialState().connection, ...connection },
  }
  return {
    client: {
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } as unknown as EnvironmentClient,
    set(next: Row[]) {
      state = {
        ...state,
        sessions: sessions(next),
        sessionOrder: next.map((row) => row.sessionId),
      }
      for (const listener of [...listeners]) listener()
    },
  }
}

function fakeNative(overrides: Partial<SessionWatchNative> = {}) {
  let enabled = true
  let watching = false
  const native = {
    notificationsEnabled: vi.fn(() => enabled),
    requestPermission: vi.fn(async () => {
      enabled = true
      return { status: 'granted' as const, granted: true, canAskAgain: true }
    }),
    openSettings: vi.fn(),
    isWatching: vi.fn(() => watching),
    startWatching: vi.fn(() => {
      watching = true
    }),
    stopWatching: vi.fn(() => {
      watching = false
      return true
    }),
    notify: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  }
  return {
    native,
    deny: () => {
      enabled = false
    },
  }
}

function setup(options: { saved?: string | null; appState?: string } = {}) {
  const store = new Map<string, string>()
  if (options.saved) store.set(NOTIFICATIONS_STORAGE_KEY, options.saved)
  let status = options.appState ?? 'active'
  const appListeners = new Set<(status: string) => void>()
  const { native, deny } = fakeNative()
  const watch = createSessionWatch({
    native,
    storage: {
      getItem: async (key) => store.get(key) ?? null,
      setItem: async (key, value) => {
        store.set(key, value)
      },
    },
    appState: {
      current: () => status,
      subscribe(listener) {
        appListeners.add(listener)
        return () => appListeners.delete(listener)
      },
    },
  })
  const moveTo = (next: string) => {
    status = next
    for (const listener of [...appListeners]) listener(next)
  }
  return { watch, native, deny, store, moveTo }
}

function connectTo(watch: ReturnType<typeof createSessionWatch>, client: EnvironmentClient) {
  watch.attach({
    getState: () => ({ client, selectedId: 'env-1' }),
    subscribe: () => () => {},
  })
}

describe('session notices on the phone', () => {
  it('is off until turned on, and turning it on starts the watch and is kept', async () => {
    const { watch, native, store } = setup()
    await watch.start()
    expect(watch.getState()).toMatchObject({ enabled: false, watching: false })
    expect(native.startWatching).not.toHaveBeenCalled()

    await watch.enable()
    expect(watch.getState()).toMatchObject({ enabled: true, access: 'granted', watching: true })
    expect(store.get(NOTIFICATIONS_STORAGE_KEY)).toBe('on')

    await watch.disable()
    expect(watch.getState()).toMatchObject({ enabled: false, watching: false })
    expect(native.stopWatching).toHaveBeenCalled()
    expect(store.get(NOTIFICATIONS_STORAGE_KEY)).toBe('off')
  })

  it('starts the watch at launch when it was left on', async () => {
    const { watch, native } = setup({ saved: 'on' })
    await watch.start()
    expect(native.startWatching).toHaveBeenCalledTimes(1)
    expect(watch.getState().watching).toBe(true)
  })

  it('a refusal for good sends the next press to Android settings', async () => {
    const { watch, native, deny } = setup()
    deny()
    native.requestPermission.mockResolvedValueOnce({
      status: 'denied',
      granted: false,
      canAskAgain: false,
    })
    await watch.start()
    await watch.enable()
    expect(watch.getState()).toMatchObject({ enabled: false, access: 'blocked', watching: false })
    expect(notificationsRow(watch.getState())?.action).toBe('settings')
    await watch.enable()
    expect(native.openSettings).toHaveBeenCalledTimes(1)
  })

  it('keeps the connection active in the background only while the watch runs', async () => {
    const { watch } = setup()
    let base: AppActivity = 'active'
    const baseListeners = new Set<(activity: AppActivity) => void>()
    const source: AppActivitySource = {
      current: () => base,
      subscribe(listener) {
        baseListeners.add(listener)
        return () => baseListeners.delete(listener)
      },
    }
    const activity = watch.activity(source)
    const seen: AppActivity[] = []
    activity.subscribe((next) => seen.push(next))
    const move = (next: AppActivity) => {
      base = next
      for (const listener of [...baseListeners]) listener(next)
    }

    await watch.start()
    move('background')
    expect(activity.current()).toBe('background')
    move('active')
    await watch.enable()
    move('background')
    expect(activity.current()).toBe('active')
    await watch.disable()
    expect(activity.current()).toBe('background')
    expect(seen).toEqual(['background', 'active', 'background'])
  })

  it('notifies finished, waiting and failed sessions, but not the one on screen', async () => {
    const { watch, native } = setup({ saved: 'on' })
    await watch.start()
    const fake = fakeClient([
      { sessionId: 'a', title: 'Alpha', status: 'running' },
      { sessionId: 'b', title: 'Beta', status: 'running' },
      { sessionId: 'c', title: 'Gamma', status: 'running' },
      { sessionId: 'child', status: 'running', parentSessionId: 'a' },
    ])
    connectTo(watch, fake.client)
    // First sight is not news.
    expect(native.notify).not.toHaveBeenCalled()

    watch.arrived('/session/c')
    fake.set([
      { sessionId: 'a', title: 'Alpha', status: 'idle' },
      { sessionId: 'b', title: 'Beta', status: 'waiting' },
      { sessionId: 'c', title: 'Gamma', status: 'idle' },
      { sessionId: 'child', status: 'idle', parentSessionId: 'a' },
    ])
    expect(native.notify).toHaveBeenCalledTimes(2)
    expect(native.notify).toHaveBeenCalledWith(
      'env-1:a',
      'Alpha',
      'Finished',
      'openmanager://session/a',
    )
    expect(native.notify).toHaveBeenCalledWith(
      'env-1:b',
      'Beta',
      'Needs your input',
      'openmanager://session/b',
    )
  })

  it('in the background, the session left on screen is notified too', async () => {
    const { watch, native, moveTo } = setup({ saved: 'on' })
    await watch.start()
    const fake = fakeClient([{ sessionId: 'a', title: 'Alpha', status: 'running' }])
    connectTo(watch, fake.client)
    watch.arrived('/session/a')
    moveTo('background')
    fake.set([{ sessionId: 'a', title: 'Alpha', status: 'error' }])
    expect(native.notify).toHaveBeenCalledWith(
      'env-1:a',
      'Alpha',
      'Stopped with an error',
      'openmanager://session/a',
    )
  })

  it('says nothing while turned off', async () => {
    const { watch, native } = setup()
    await watch.start()
    const fake = fakeClient([{ sessionId: 'a', status: 'running' }])
    connectTo(watch, fake.client)
    fake.set([{ sessionId: 'a', status: 'idle' }])
    expect(native.notify).not.toHaveBeenCalled()
  })

  it('opening a session takes its notice away', async () => {
    const { watch, native } = setup({ saved: 'on' })
    await watch.start()
    connectTo(watch, fakeClient([{ sessionId: 'a', status: 'running' }]).client)
    watch.arrived('/session/a')
    expect(native.cancel).toHaveBeenCalledWith('env-1:a')
  })

  it("the watch's task lasts until the watch is turned off", async () => {
    const { watch } = setup({ saved: 'on' })
    await watch.start()
    let ended = false
    const task = watch.task().then(() => {
      ended = true
    })
    await Promise.resolve()
    expect(ended).toBe(false)
    await watch.disable()
    await task
    expect(ended).toBe(true)
  })

  it('reads the session a path shows', () => {
    expect(sessionOnPath('/session/abc')).toBe('abc')
    expect(sessionOnPath('/session/a%20b')).toBe('a b')
    expect(sessionOnPath('/draft/abc')).toBeNull()
  })
})
