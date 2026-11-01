import { act, render, renderHook, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyActiveSession,
  applyCatchingUp,
  applyConnection,
  applyThreadHydration,
  createEnvironmentStore,
  createInitialState,
  createThreadState,
  selectOpenChatCatchingUp,
  type EnvironmentState,
} from '@openmanager/environment-client'
import {
  SYNCING_PILL_DELAY_MS,
  SYNCING_PILL_MIN_VISIBLE_MS,
  useSyncingPill,
} from '@openmanager/app-core/components/chat/SyncingPill'
import { ComposerStatusPill } from '@openmanager/app-core/components/chat/SessionLaunchPill'

const ENVIRONMENT = 'env'
const THREAD = 'thread'
const scope = { type: 'thread', environmentId: ENVIRONMENT, sessionId: 'session', threadId: THREAD }

/** A store with one chat on screen, connected; `saved` is whether a copy of it is held. */
function chat(saved = true) {
  const state = createInitialState()
  state.environment = { environmentId: ENVIRONMENT, name: 'Environment' }
  state.sessions = {
    session: {
      sessionId: 'session',
      workspaceId: 'workspace',
      title: 'Chat',
      status: 'idle',
      providerId: 'opencode',
      updatedAt: '2026-10-01T00:00:00.000Z',
      threadIds: [THREAD],
    },
  }
  state.sessionOrder = ['session']
  const thread = createThreadState({ threadId: THREAD, sessionId: 'session' }, 'ready')
  if (saved) {
    thread.cursor = { scope, epoch: 'e', sequence: 4 } as NonNullable<typeof thread.cursor>
    thread.messages = [
      {
        messageId: 'message',
        threadId: THREAD,
        turnId: 'turn',
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]
  }
  state.threads = { [THREAD]: thread }
  state.connection = { ...state.connection, phase: 'connected', hasConnected: true }
  return createEnvironmentStore(applyActiveSession(state, 'session'))
}

/** The pill as the app wires it: the shared signal through the shared timing. */
function pill(store: ReturnType<typeof chat>, connectionProblem = { current: false }) {
  return renderHook(() => {
    const select = (reader: (state: EnvironmentState) => boolean | string | null) =>
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useSyncExternalStore(store.subscribe, () => reader(store.getState()))
    const catchingUp = select(selectOpenChatCatchingUp) as boolean
    const chatId = select((state) => state.activeThreadId) as string | null
    const connected = select((state) => state.connection.phase === 'connected') as boolean
    return useSyncingPill(catchingUp, chatId, connectionProblem.current || !connected)
  })
}

const opening = (loading: boolean) => (state: EnvironmentState) =>
  applyThreadHydration(state, THREAD, loading ? 'loading' : 'ready')
const recovering = (on: boolean) => (state: EnvironmentState) => applyCatchingUp(state, THREAD, on)
const phase = (next: EnvironmentState['connection']['phase']) => (state: EnvironmentState) =>
  applyConnection(state, { phase: next })
const pass = (ms: number) => act(() => vi.advanceTimersByTime(ms))

describe('the syncing pill', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows nothing when a switch is answered quickly', () => {
    const store = chat()
    const { result } = pill(store)
    act(() => store.update(opening(true)))
    pass(SYNCING_PILL_DELAY_MS - 1)
    act(() => store.update(opening(false)))
    pass(SYNCING_PILL_DELAY_MS * 2)
    expect(result.current).toBe(false)
  })

  it('shows after the delay when a switch is slow, and stays the minimum', () => {
    const store = chat()
    const { result } = pill(store)
    act(() => store.update(opening(true)))
    pass(SYNCING_PILL_DELAY_MS - 1)
    expect(result.current).toBe(false)
    pass(1)
    expect(result.current).toBe(true)
    pass(10)
    act(() => store.update(opening(false)))
    expect(result.current).toBe(true)
    pass(SYNCING_PILL_MIN_VISIBLE_MS - 11)
    expect(result.current).toBe(true)
    pass(1)
    expect(result.current).toBe(false)
  })

  it('goes after its answer with no wait once the minimum has passed', () => {
    const store = chat()
    const { result } = pill(store)
    act(() => store.update(opening(true)))
    pass(SYNCING_PILL_DELAY_MS + SYNCING_PILL_MIN_VISIBLE_MS)
    act(() => store.update(opening(false)))
    expect(result.current).toBe(false)
  })

  it('gives way at once to a lost connection, with no minimum', () => {
    const store = chat()
    const { result } = pill(store)
    act(() => store.update(recovering(true)))
    pass(SYNCING_PILL_DELAY_MS)
    expect(result.current).toBe(true)
    act(() => store.update(phase('reconnecting')))
    expect(result.current).toBe(false)
  })

  it('shows nothing while the connection is lost, however long', () => {
    const store = chat()
    act(() => store.update(phase('reconnecting')))
    const { result } = pill(store)
    act(() => store.update(recovering(true)))
    pass(60_000)
    expect(result.current).toBe(false)
  })

  it('shows nothing when the connection is back and catch-up is quick', () => {
    const store = chat()
    act(() => store.update(phase('reconnecting')))
    const { result } = pill(store)
    act(() => {
      store.update(phase('connected'))
      store.update(recovering(true))
    })
    pass(100)
    act(() => store.update(recovering(false)))
    pass(SYNCING_PILL_DELAY_MS)
    expect(result.current).toBe(false)
  })

  it('shows when the connection is back and catch-up is slow', () => {
    const store = chat()
    act(() => store.update(phase('reconnecting')))
    const { result } = pill(store)
    act(() => {
      store.update(phase('connected'))
      store.update(recovering(true))
    })
    pass(SYNCING_PILL_DELAY_MS)
    expect(result.current).toBe(true)
  })

  it('never shows beside a connection problem the socket has not seen', () => {
    const store = chat()
    const { result } = pill(store, { current: true })
    act(() => store.update(recovering(true)))
    pass(SYNCING_PILL_DELAY_MS * 4)
    expect(result.current).toBe(false)
  })

  it('shows for a reload whose saved copy is on screen and whose answer is slow', () => {
    const store = chat()
    act(() => store.update(phase('connecting')))
    const { result } = pill(store)
    act(() => {
      store.update(phase('connected'))
      store.update(opening(true))
    })
    pass(SYNCING_PILL_DELAY_MS)
    expect(result.current).toBe(true)
  })

  it('takes the same delay for a lagging chat', () => {
    const store = chat()
    const { result } = pill(store)
    act(() => store.update(recovering(true)))
    pass(SYNCING_PILL_DELAY_MS - 1)
    expect(result.current).toBe(false)
    pass(1)
    expect(result.current).toBe(true)
  })

  it('shows while a copy whose cursor was forgotten downloads whole', () => {
    const store = chat()
    act(() =>
      store.update((state) => {
        const { cursor: _forgotten, ...thread } = state.threads[THREAD]!
        return { ...state, threads: { ...state.threads, [THREAD]: thread } }
      }),
    )
    const { result } = pill(store)
    act(() => store.update(recovering(true)))
    pass(SYNCING_PILL_DELAY_MS)
    expect(result.current).toBe(true)
  })

  it('leaves a first open with nothing saved to the empty loading state', () => {
    const store = chat(false)
    const { result } = pill(store)
    act(() => store.update(opening(true)))
    pass(SYNCING_PILL_DELAY_MS * 4)
    expect(result.current).toBe(false)
  })

  it('starts over on another chat, and never carries over to it', () => {
    const store = chat()
    const other = createThreadState({ threadId: 'other', sessionId: 'session' }, 'ready')
    other.cursor = { scope: { ...scope, threadId: 'other' }, epoch: 'e', sequence: 1 } as never
    other.messages = store.getState().threads[THREAD]!.messages
    const { result } = pill(store)
    act(() => store.update(opening(true)))
    pass(SYNCING_PILL_DELAY_MS)
    expect(result.current).toBe(true)
    act(() =>
      store.update((state) => ({
        ...state,
        threads: { ...state.threads, other: { ...other, hydration: 'loading' } },
        activeThreadId: 'other',
      })),
    )
    expect(result.current).toBe(false)
    pass(SYNCING_PILL_DELAY_MS - 1)
    expect(result.current).toBe(false)
    pass(1)
    expect(result.current).toBe(true)
  })

  it('reads in plain words, as a status above the composer', () => {
    render(<ComposerStatusPill visible label="Syncing…" />)
    expect(screen.getByRole('status')).toHaveTextContent('Syncing…')
  })
})
