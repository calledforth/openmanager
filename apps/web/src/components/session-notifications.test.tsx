import { render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createInitialState,
  type ConnectionState,
  type EnvironmentClient,
  type EnvironmentState,
} from '@openmanager/environment-client'
import { SessionNotifications } from './session-notifications'

type Row = {
  sessionId: string
  title?: string
  status: string
  parentSessionId?: string
  doneAt?: string
  waitingOn?: string
}

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static created: FakeNotification[] = []
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    FakeNotification.created.push(this)
  }
}

const LIVE: Partial<ConnectionState> = { phase: 'connected', hasConnected: true, caughtUp: true }

/** A client as far as the watcher reads one, with a hand on what it holds. */
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
  const tell = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    client: {
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } as unknown as EnvironmentClient,
    set: (next: Row[], patch: Partial<ConnectionState> = {}) => {
      state = {
        ...state,
        sessions: sessions(next),
        sessionOrder: next.map((row) => row.sessionId),
        connection: { ...state.connection, ...patch },
      }
      tell()
    },
    connect: (patch: Partial<ConnectionState>) => {
      state = { ...state, connection: { ...state.connection, ...patch } }
      tell()
    },
    /** What a streamed token does: a new state with the same sessions. */
    token: () => {
      state = { ...state }
      tell()
    },
    listeners,
  }
}

const NAMES = { desk: 'Desk', laptop: 'Laptop' }

function watch(props: Partial<ComponentProps<typeof SessionNotifications>>) {
  const openSession = vi.fn()
  const defaults = { clients: {}, names: NAMES, isOnScreen: () => false, openSession }
  const view = render(<SessionNotifications {...defaults} {...props} />)
  return {
    openSession,
    update: (next: Partial<ComponentProps<typeof SessionNotifications>>) =>
      view.rerender(<SessionNotifications {...defaults} {...props} {...next} />),
  }
}

const raised = () => FakeNotification.created.map((n) => [n.title, n.options.body, n.options.tag])

describe('SessionNotifications', () => {
  beforeEach(() => {
    FakeNotification.permission = 'granted'
    FakeNotification.created = []
    vi.stubGlobal('Notification', FakeNotification)
    window.localStorage.clear()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    vi.spyOn(window, 'focus').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('notifies when a session finishes or needs input, not on first load', () => {
    const desk = fakeClient([
      { sessionId: 'a', title: 'Fix login', status: 'running' },
      { sessionId: 'b', title: 'Old', status: 'idle', doneAt: 'then' },
    ])
    const { openSession } = watch({ clients: { desk: desk.client } })
    expect(FakeNotification.created).toHaveLength(0)

    desk.set([
      { sessionId: 'a', title: 'Fix login', status: 'idle', doneAt: 'now' },
      { sessionId: 'b', title: 'Old', status: 'waiting' },
    ])

    expect(raised()).toEqual(
      expect.arrayContaining([
        ['Fix login', 'Finished · Desk', 'desk/a'],
        ['Old', 'Needs your input · Desk', 'desk/b'],
      ]),
    )

    const notice = FakeNotification.created.find((item) => item.title === 'Fix login')!
    notice.onclick?.()
    expect(openSession).toHaveBeenCalledWith('desk', 'a')
    expect(notice.close).toHaveBeenCalled()
  })

  it('names no environment with one saved', () => {
    const desk = fakeClient([{ sessionId: 'a', status: 'running' }])
    watch({ clients: { desk: desk.client }, names: { desk: 'Desk' } })
    desk.set([{ sessionId: 'a', status: 'idle', doneAt: 'now' }])
    expect(raised()).toEqual([['Session', 'Finished', 'desk/a']])
  })

  it('keeps two environments apart when a session id repeats', () => {
    const desk = fakeClient([{ sessionId: 'same', title: 'On desk', status: 'running' }])
    const laptop = fakeClient([{ sessionId: 'same', title: 'On laptop', status: 'idle' }])
    const { openSession } = watch({ clients: { desk: desk.client, laptop: laptop.client } })

    // The desk's session finishing says nothing of the laptop's, and the other
    // way around: neither replaces the other's notice.
    laptop.set([{ sessionId: 'same', title: 'On laptop', status: 'running' }])
    desk.set([{ sessionId: 'same', title: 'On desk', status: 'idle', doneAt: 'now' }])
    laptop.set([{ sessionId: 'same', title: 'On laptop', status: 'error' }])

    expect(raised()).toEqual([
      ['On desk', 'Finished · Desk', 'desk/same'],
      ['On laptop', 'Stopped with an error · Laptop', 'laptop/same'],
    ])
    FakeNotification.created[1]!.onclick?.()
    expect(openSession).toHaveBeenCalledWith('laptop', 'same')
  })

  it('stays quiet for the session on screen while the window has focus, only that one', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const desk = fakeClient([{ sessionId: 'same', status: 'running' }])
    const laptop = fakeClient([{ sessionId: 'same', status: 'running' }])
    watch({
      clients: { desk: desk.client, laptop: laptop.client },
      isOnScreen: (environmentId, sessionId) => environmentId === 'desk' && sessionId === 'same',
    })

    desk.set([{ sessionId: 'same', status: 'idle', doneAt: 'now' }])
    expect(FakeNotification.created).toHaveLength(0)

    laptop.set([{ sessionId: 'same', status: 'idle', doneAt: 'now' }])
    expect(raised()).toEqual([['Session', 'Finished · Laptop', 'laptop/same']])
  })

  it('reads what is on screen when the session finishes, not when it was first watched', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const desk = fakeClient([{ sessionId: 'a', status: 'running' }])
    const { update } = watch({ clients: { desk: desk.client }, isOnScreen: () => true })
    update({ isOnScreen: () => false })
    desk.set([{ sessionId: 'a', status: 'idle', doneAt: 'now' }])
    expect(FakeNotification.created).toHaveLength(1)
  })

  it('says nothing of a session cached as running and found finished on connecting', () => {
    const laptop = fakeClient(
      [
        { sessionId: 'a', status: 'running' },
        { sessionId: 'b', status: 'running' },
      ],
      { phase: 'connecting' },
    )
    watch({ clients: { laptop: laptop.client } })

    laptop.connect({ phase: 'connected', caughtUp: false })
    // The whole catch-up lands in one update, while it is still catching up.
    laptop.set([
      { sessionId: 'a', status: 'idle', doneAt: 'then' },
      { sessionId: 'b', status: 'waiting' },
    ])
    laptop.connect({ caughtUp: true })
    expect(FakeNotification.created).toHaveLength(0)

    laptop.set([
      { sessionId: 'a', status: 'running' },
      { sessionId: 'b', status: 'waiting' },
    ])
    laptop.set([
      { sessionId: 'a', status: 'idle', doneAt: 'now' },
      { sessionId: 'b', status: 'waiting' },
    ])
    expect(raised()).toEqual([['Session', 'Finished · Laptop', 'laptop/a']])
  })

  it('takes a late environment as it finds it, whatever the others are doing', () => {
    const desk = fakeClient([{ sessionId: 'a', status: 'running' }])
    const { update } = watch({ clients: { desk: desk.client } })

    const laptop = fakeClient([
      { sessionId: 'b', status: 'idle', doneAt: 'then' },
      { sessionId: 'c', status: 'waiting' },
    ])
    update({ clients: { desk: desk.client, laptop: laptop.client } })
    expect(FakeNotification.created).toHaveLength(0)

    desk.set([{ sessionId: 'a', status: 'idle', doneAt: 'now' }])
    expect(raised()).toEqual([['Session', 'Finished · Desk', 'desk/a']])
  })

  it('still tells of what ended during a drop, once the environment has been watched', () => {
    const desk = fakeClient([{ sessionId: 'a', status: 'running' }])
    watch({ clients: { desk: desk.client } })

    desk.connect({ phase: 'reconnecting' })
    desk.connect({ phase: 'connected', caughtUp: false })
    desk.set([{ sessionId: 'a', status: 'idle', doneAt: 'now' }])

    expect(raised()).toEqual([['Session', 'Finished · Desk', 'desk/a']])
  })

  it('keeps what it saw across a client replaced on the same environment', () => {
    const first = fakeClient([{ sessionId: 'a', status: 'running' }])
    const { update } = watch({ clients: { desk: first.client } })

    const second = fakeClient([{ sessionId: 'a', status: 'idle', doneAt: 'now' }])
    update({ clients: { desk: second.client } })

    expect(raised()).toEqual([['Session', 'Finished · Desk', 'desk/a']])
    expect(first.listeners.size).toBe(0)
  })

  it('forgets an environment that is removed', () => {
    const laptop = fakeClient([{ sessionId: 'a', status: 'running' }])
    const { update } = watch({ clients: { laptop: laptop.client } })
    update({ clients: {}, names: { desk: 'Desk' } })

    const paired = fakeClient([{ sessionId: 'a', status: 'idle', doneAt: 'then' }])
    update({ clients: { laptop: paired.client }, names: NAMES })

    expect(FakeNotification.created).toHaveLength(0)
  })

  it('reads the list only when the sessions change', () => {
    const desk = fakeClient([{ sessionId: 'a', status: 'running' }])
    watch({ clients: { desk: desk.client } })
    const read = vi.spyOn(Object, 'values')
    for (let token = 0; token < 5; token += 1) desk.token()
    expect(read).not.toHaveBeenCalled()
  })

  it('skips subagent sessions, a turned-off preference, and missing permission', () => {
    const desk = fakeClient([{ sessionId: 'child', parentSessionId: 'a', status: 'running' }])
    watch({ clients: { desk: desk.client } })
    desk.set([{ sessionId: 'child', parentSessionId: 'a', status: 'idle', doneAt: 'now' }])
    expect(FakeNotification.created).toHaveLength(0)

    window.localStorage.setItem('openmanager-notifications', 'off')
    desk.set([{ sessionId: 'a', status: 'running' }])
    desk.set([{ sessionId: 'a', status: 'idle', doneAt: 'now' }])
    expect(FakeNotification.created).toHaveLength(0)

    window.localStorage.clear()
    FakeNotification.permission = 'default'
    desk.set([{ sessionId: 'a', status: 'running' }])
    desk.set([{ sessionId: 'a', status: 'error' }])
    expect(FakeNotification.created).toHaveLength(0)
  })
})
