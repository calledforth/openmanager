import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Draft,
  DraftContent,
  DraftList,
  DraftSaveInput,
  DraftTarget,
  DraftTombstone,
} from '@openmanager/protocol'
import {
  applyDraftDeleted,
  applyDraftList,
  applyDraftSaved,
  applyDraftsUnlisted,
  selectDraftContent,
  selectDraftSyncStatus,
} from '../src/draft-state'
import { createDraftSync } from '../src/draft-sync'
import { EnvironmentClientError } from '../src/errors'
import { createInitialState } from '../src/state'
import { createEnvironmentStore, type EnvironmentStore } from '../src/store'
import type { ConnectionPhase, EnvironmentState } from '../src/types'

const AT = '2026-10-01T10:00:00.000Z'
const target = (workspaceId: string, sessionId: string): DraftTarget => ({
  type: 'new_session',
  workspaceId,
  sessionId,
})
const FIRST = target('w1', 's1')
const SECOND = target('w2', 's2')

const withPhase =
  (phase: ConnectionPhase) =>
  (state: EnvironmentState): EnvironmentState => ({
    ...state,
    connection: { ...state.connection, phase, hasConnected: true },
  })

/**
 * One environment and any number of clients on it: every write is announced
 * to every connected client before it is answered, as the environment does.
 * A client that is not connected neither reaches it nor hears from it.
 */
function environment() {
  const rows = new Map<string, Draft | number>()
  const stores: EnvironmentStore[] = []
  const saves: DraftSaveInput[] = []
  let failNext: Error | undefined
  let gate: Promise<void> = Promise.resolve()
  const live = (store: EnvironmentStore) => store.getState().connection.phase === 'connected'
  const broadcast = (update: (state: EnvironmentState) => EnvironmentState) => {
    for (const store of stores) if (live(store)) store.update(update)
  }
  const unreachable = () => new EnvironmentClientError('unavailable', 'Not connected.')

  function client(phase: ConnectionPhase = 'connected') {
    const store = createEnvironmentStore(withPhase(phase)(createInitialState()))
    stores.push(store)
    const commands = {
      listDrafts: vi.fn(async (): Promise<DraftList> => {
        if (!live(store)) throw unreachable()
        const list: DraftList = {
          drafts: [...rows.values()].filter((row): row is Draft => typeof row !== 'number'),
          tombstones: [],
        }
        store.update((state) => applyDraftList(state, list))
        return list
      }),
      saveDraft: vi.fn(async (input: DraftSaveInput): Promise<Draft> => {
        if (!live(store)) throw unreachable()
        await gate
        if (failNext) {
          const error = failNext
          failNext = undefined
          throw error
        }
        saves.push(input)
        const row = rows.get(input.draftId)
        if (typeof row === 'number' && input.baseRevision < row) {
          throw new EnvironmentClientError('conflict', 'This draft was sent or deleted.', {
            draftId: input.draftId,
            revision: row,
          })
        }
        const revision = (typeof row === 'number' ? row : (row?.revision ?? 0)) + 1
        const saved: Draft = {
          draftId: input.draftId,
          target: input.target,
          content: input.content,
          revision,
          createdAt: AT,
          updatedAt: AT,
          updatedByClientId: null,
        }
        rows.set(input.draftId, saved)
        broadcast((state) => applyDraftSaved(state, saved))
        return saved
      }),
      deleteDraft: vi.fn(async ({ draftId }: { draftId: string }): Promise<DraftTombstone> => {
        if (!live(store)) throw unreachable()
        const row = rows.get(draftId)
        const revision = (typeof row === 'number' ? row : (row?.revision ?? 0)) + 1
        rows.set(draftId, revision)
        broadcast((state) => applyDraftDeleted(state, { draftId, revision }))
        return { draftId, revision }
      }),
    }
    let now = 0
    const sync = createDraftSync({
      store,
      commands,
      supported: () => true,
      debounceMs: 1000,
      now: () => (now += 1),
    })
    return {
      store,
      sync,
      commands,
      status: (draftId: string) => selectDraftSyncStatus(store.getState(), draftId),
      text: (draftId: string) => selectDraftContent(store.getState(), draftId)?.text,
      setPhase(next: ConnectionPhase) {
        store.update(withPhase(next))
      },
    }
  }

  return {
    client,
    saves,
    rows,
    failNextSave(error: Error) {
      failNext = error
    },
    hold() {
      let release!: () => void
      gate = new Promise((resolve) => {
        release = resolve
      })
      return () => {
        gate = Promise.resolve()
        release()
      }
    },
  }
}

describe('offline and unsynced drafts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps edits and new drafts made offline, and shows them on another client after reconnecting', async () => {
    const env = environment()
    const here = env.client()
    const there = env.client()
    await vi.advanceTimersByTimeAsync(0)
    here.sync.edit('a', FIRST, { text: 'first' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(there.text('a')).toBe('first')

    here.setPhase('reconnecting')
    here.sync.edit('a', FIRST, { text: 'first, edited offline' })
    // Unreachable: marked at once, not after the pause in typing.
    expect(here.status('a')).toBe('offline')
    here.sync.edit('b', SECOND, { text: 'a draft started offline' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(here.status('a')).toBe('offline')
    expect(here.status('b')).toBe('offline')
    expect(there.text('a')).toBe('first')
    expect(there.text('b')).toBeUndefined()

    // Back, but the saves are still on the wire: still not synced.
    const release = env.hold()
    here.setPhase('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(here.status('a')).toBe('offline')
    expect(here.status('b')).toBe('offline')

    release()
    await vi.advanceTimersByTimeAsync(0)
    // Flushed in the order they were made.
    expect(env.saves.map((save) => save.content.text)).toEqual([
      'first',
      'first, edited offline',
      'a draft started offline',
    ])
    expect(here.status('a')).toBe('synced')
    expect(here.status('b')).toBe('synced')
    expect(there.text('a')).toBe('first, edited offline')
    expect(there.text('b')).toBe('a draft started offline')
    here.sync.dispose()
    there.sync.dispose()
  })

  it('keeps showing a draft as unsynced while typing on, until a save of it lands', async () => {
    const env = environment()
    const here = env.client('closed')
    here.sync.edit('a', FIRST, { text: 'one' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(here.store.getState().draftEdits.a?.stalled).toBe('offline')
    here.sync.edit('a', FIRST, { text: 'one two' })
    expect(here.store.getState().draftEdits.a?.stalled).toBe('offline')

    here.setPhase('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(here.status('a')).toBe('synced')
    expect(env.saves.map((save) => save.content.text)).toEqual(['one two'])
    here.sync.dispose()
  })

  it('reads as saving, not unsynced, while an edit only waits out the pause in typing', async () => {
    const env = environment()
    const here = env.client()
    await vi.advanceTimersByTimeAsync(0)
    here.sync.edit('a', FIRST, { text: 'typing' })
    expect(here.status('a')).toBe('saving')
    await vi.advanceTimersByTimeAsync(1000)
    expect(here.status('a')).toBe('synced')
    here.sync.dispose()
  })

  it('tries a failed save again, marked as failed until it lands', async () => {
    const env = environment()
    const here = env.client()
    await vi.advanceTimersByTimeAsync(0)
    env.failNextSave(new EnvironmentClientError('unavailable', 'The environment is busy.'))
    here.sync.edit('a', FIRST, { text: 'keep me' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(here.status('a')).toBe('failed')
    expect(here.text('a')).toBe('keep me')

    await vi.advanceTimersByTimeAsync(1000)
    expect(here.status('a')).toBe('synced')
    expect(env.saves.map((save) => save.content.text)).toEqual(['keep me'])
    here.sync.dispose()
  })

  it('marks a save cut off by a dropped connection as offline and saves it on reconnect', async () => {
    const env = environment()
    const here = env.client()
    await vi.advanceTimersByTimeAsync(0)
    const release = env.hold()
    here.sync.edit('a', FIRST, { text: 'mid-flight' })
    await vi.advanceTimersByTimeAsync(1000)
    here.setPhase('reconnecting')
    env.failNextSave(new EnvironmentClientError('unavailable', 'The connection closed.'))
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(here.status('a')).toBe('offline')
    expect(here.store.getState().draftEdits.a?.stalled).toBe('offline')

    here.setPhase('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(here.status('a')).toBe('synced')
    expect(env.rows.get('a')).toMatchObject({ content: { text: 'mid-flight' } })
    here.sync.dispose()
  })

  it('marks a draft too big to sync, and clears the mark once it fits and is saved', async () => {
    const env = environment()
    const here = env.client()
    await vi.advanceTimersByTimeAsync(0)
    here.sync.edit('a', FIRST, { text: 'x'.repeat(70_000) })
    await vi.advanceTimersByTimeAsync(1000)
    expect(here.status('a')).toBe('too_large')
    here.sync.edit('a', FIRST, { text: 'x'.repeat(70_001) })
    // The mark holds while typing on: nothing has reached the environment.
    expect(here.status('a')).toBe('too_large')

    here.sync.edit('a', FIRST, { text: 'short again' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(here.status('a')).toBe('synced')
    here.sync.dispose()
  })

  it('marks waiting edits while the listing that must come first keeps failing', async () => {
    const env = environment()
    const here = env.client('closed')
    here.sync.edit('a', FIRST, { text: 'waiting' })
    here.commands.listDrafts.mockRejectedValueOnce(new Error('busy'))
    here.setPhase('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(here.status('a')).toBe('failed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(here.status('a')).toBe('synced')
    here.sync.dispose()
  })

  it('does not count a draft being sent as unsynced', async () => {
    const env = environment()
    const here = env.client('closed')
    here.sync.edit('a', FIRST, { text: 'sending' } satisfies DraftContent)
    here.sync.beginLaunch('a')
    expect(here.status('a')).toBe('synced')
    here.sync.dispose()
  })

  it('forgets a draft cleared offline that the environment never had, with nothing to sync', async () => {
    const env = environment()
    const here = env.client('closed')
    here.sync.edit('a', FIRST, { text: 'never sent anywhere' })
    here.sync.discard('a')
    await vi.advanceTimersByTimeAsync(1000)
    expect(here.store.getState().draftEdits.a).toBeUndefined()
    expect(here.status('a')).toBe('synced')
    here.sync.dispose()
  })

  it('leaves a save on the wire alone when a listing fails, so it is written once', async () => {
    const env = environment()
    const here = env.client()
    await vi.advanceTimersByTimeAsync(0)
    const release = env.hold()
    here.sync.edit('a', FIRST, { text: 'once' })
    await vi.advanceTimersByTimeAsync(1000)
    here.commands.listDrafts.mockRejectedValueOnce(new Error('busy'))
    here.store.update(applyDraftsUnlisted)
    await vi.advanceTimersByTimeAsync(0)
    expect(here.store.getState().draftEdits.a?.stalled).toBeUndefined()

    release()
    await vi.advanceTimersByTimeAsync(5000)
    expect(env.saves.map((save) => save.content.text)).toEqual(['once'])
    expect(here.status('a')).toBe('synced')
    here.sync.dispose()
  })

  it('says so when the environment is reached but keeps no drafts', async () => {
    const store = createEnvironmentStore(withPhase('connected')(createInitialState()))
    const sync = createDraftSync({
      store,
      commands: {
        listDrafts: vi.fn(),
        saveDraft: vi.fn(),
        deleteDraft: vi.fn(),
      },
      supported: () => false,
      debounceMs: 1000,
    })
    sync.edit('a', FIRST, { text: 'kept here' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(selectDraftSyncStatus(store.getState(), 'a')).toBe('unsupported')
    sync.dispose()
  })

  it('keeps the mark on text typed while the reconnecting save is on the wire, until that text lands', async () => {
    const env = environment()
    const here = env.client('closed')
    here.sync.edit('a', FIRST, { text: 'offline' })
    await vi.advanceTimersByTimeAsync(1000)
    const release = env.hold()
    here.setPhase('connected')
    await vi.advanceTimersByTimeAsync(0)
    here.sync.edit('a', FIRST, { text: 'offline, and more' })
    release()
    await vi.advanceTimersByTimeAsync(0)
    // The first save landed, but not the newer text.
    expect(env.saves.map((save) => save.content.text)).toEqual(['offline'])
    expect(here.status('a')).not.toBe('saving')
    expect(here.status('a')).not.toBe('synced')

    await vi.advanceTimersByTimeAsync(1000)
    expect(env.saves.map((save) => save.content.text)).toEqual(['offline', 'offline, and more'])
    expect(here.status('a')).toBe('synced')
    here.sync.dispose()
  })
})
