import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Draft,
  DraftContent,
  DraftList,
  DraftSaveInput,
  DraftTarget,
  DraftTombstone,
  ProofEvent,
} from '@openmanager/protocol'
import {
  applyDraftDeleted,
  applyDraftList,
  applyDraftSaved,
  selectDraftContent,
  selectNewSessionDraftId,
} from '../src/draft-state'
import { createDraftSync } from '../src/draft-sync'
import { EnvironmentClientError } from '../src/errors'
import { createMockEnvironmentClient } from '../src/mock'
import { applyEvent, applySessionList, applyWorkspaceList, createInitialState } from '../src/state'
import { createEnvironmentStore } from '../src/store'
import type { EnvironmentState } from '../src/types'
import { SESSION_SUMMARY, WORKSPACE, environmentScope, event } from './fixtures'

const NEW: DraftTarget = {
  type: 'new_session',
  workspaceId: WORKSPACE.workspaceId,
  sessionId: 's-new',
}
const AT = '2026-10-01T10:00:00.000Z'

const draft = (
  draftId: string,
  revision: number,
  content: DraftContent,
  target: DraftTarget = NEW,
): Draft => ({
  draftId,
  target,
  content,
  revision,
  createdAt: AT,
  updatedAt: AT,
  updatedByClientId: null,
})

const connected = (state: EnvironmentState): EnvironmentState => ({
  ...state,
  connection: { ...state.connection, phase: 'connected' },
})

describe('draft state', () => {
  it('keeps the newest revision and never revives a draft from before its deletion', () => {
    let state = applyDraftSaved(createInitialState(), draft('d', 2, { text: 'two' }))
    expect(applyDraftSaved(state, draft('d', 1, { text: 'one' }))).toBe(state)
    state = applyDraftDeleted(state, { draftId: 'd', revision: 3 })
    expect(state.drafts.d).toBeUndefined()
    expect(applyDraftSaved(state, draft('d', 3, { text: 'late' }))).toBe(state)
    // A session's next draft, saved on top of the deletion.
    state = applyDraftSaved(state, draft('d', 4, { text: 'next' }))
    expect(state.drafts.d?.content.text).toBe('next')
    expect(state.draftTombstones.d).toBeUndefined()
  })

  it('drops an edit made before a deletion and keeps one made on top of it', () => {
    const base = applyDraftSaved(createInitialState(), draft('d', 1, { text: 'a' }))
    const edited = (baseRevision: number): EnvironmentState => ({
      ...base,
      draftEdits: { d: { target: NEW, content: { text: 'ab' }, baseRevision, editedAt: 1 } },
    })
    expect(applyDraftDeleted(edited(1), { draftId: 'd', revision: 2 }).draftEdits.d).toBeUndefined()
    expect(applyDraftDeleted(edited(2), { draftId: 'd', revision: 2 }).draftEdits.d).toBeDefined()
  })

  it('lets an edit put back after a failed send outlive the deletion that send made', () => {
    const state: EnvironmentState = {
      ...createInitialState(),
      draftEdits: {
        d: {
          target: NEW,
          content: { text: 'retry me' },
          baseRevision: 1,
          editedAt: 1,
          outlivesDeletion: true,
        },
      },
    }
    const next = applyDraftDeleted(state, { draftId: 'd', revision: 2 })
    expect(next.draftEdits.d).toEqual({
      target: NEW,
      content: { text: 'retry me' },
      baseRevision: 2,
      editedAt: 1,
    })
  })

  it('forgets a new-session tombstone at the next listing once no edit needs it', () => {
    let state = applyDraftDeleted(createInitialState(), { draftId: 'sent', revision: 2 })
    state = {
      ...state,
      draftEdits: { kept: { target: NEW, content: { text: 'x' }, baseRevision: 1, editedAt: 1 } },
    }
    state = applyDraftDeleted(state, { draftId: 'kept', revision: 2 })
    state = {
      ...state,
      draftEdits: { kept: { target: NEW, content: { text: 'y' }, baseRevision: 2, editedAt: 2 } },
    }
    state = applyDraftList(state, { drafts: [], tombstones: [] })
    expect(state.draftTombstones).toEqual({ kept: 2 })
  })

  it("drops a session's draft with the session and keeps a removed project's drafts", () => {
    let state = applySessionList(applyWorkspaceList(createInitialState(), [WORKSPACE]), [
      SESSION_SUMMARY,
    ])
    const sessionId = SESSION_SUMMARY.sessionId
    state = applyDraftSaved(
      state,
      draft(sessionId, 1, { text: 'in the session' }, { type: 'session', sessionId }),
    )
    state = applyDraftSaved(state, draft('d', 1, { text: 'new chat' }))

    state = applyEvent(
      state,
      event<Extract<ProofEvent, { name: 'workspace.removed' }>>({
        name: 'workspace.removed',
        scope: environmentScope,
        payload: { workspaceId: WORKSPACE.workspaceId },
      }),
    )
    expect(state.drafts[sessionId]).toBeUndefined()
    expect(state.drafts.d?.target).toEqual({ ...NEW, workspaceId: null })
  })

  it("names a project's newest draft, passing over one that is being sent", () => {
    let state = applyDraftList(createInitialState(), {
      drafts: [
        { ...draft('old', 1, { text: 'old' }), updatedAt: '2026-10-01T09:00:00.000Z' },
        draft('new', 1, { text: 'new' }),
      ],
      tombstones: [],
    })
    expect(selectNewSessionDraftId(state, WORKSPACE.workspaceId)).toBe('new')
    state = {
      ...state,
      draftEdits: {
        new: {
          target: NEW,
          content: { text: 'new' },
          baseRevision: 1,
          editedAt: 0,
          launching: true,
        },
      },
    }
    expect(selectNewSessionDraftId(state, WORKSPACE.workspaceId)).toBe('old')
    expect(selectNewSessionDraftId(state, 'elsewhere')).toBeUndefined()
  })
})

describe('draft sync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(initial: EnvironmentState = connected(createInitialState())) {
    const store = createEnvironmentStore(initial)
    const saves: DraftSaveInput[] = []
    const deletes: string[] = []
    const server = new Map<string, Draft | number>()
    let gate: Promise<void> = Promise.resolve()
    const commands = {
      listDrafts: vi.fn(async (): Promise<DraftList> => {
        const list: DraftList = {
          drafts: [...server.values()].filter((row): row is Draft => typeof row !== 'number'),
          tombstones: [],
        }
        store.update((state) => applyDraftList(state, list))
        return list
      }),
      saveDraft: vi.fn(async (input: DraftSaveInput): Promise<Draft> => {
        saves.push(input)
        await gate
        const row = server.get(input.draftId)
        if (typeof row === 'number' && input.baseRevision < row) {
          throw new EnvironmentClientError('conflict', 'This draft was sent or deleted.', {
            draftId: input.draftId,
            revision: row,
          })
        }
        const revision = (typeof row === 'number' ? row : (row?.revision ?? 0)) + 1
        const saved = draft(input.draftId, revision, input.content, input.target)
        server.set(input.draftId, saved)
        // As the environment does: the event goes out before the answer.
        store.update((state) => applyDraftSaved(state, saved))
        return saved
      }),
      deleteDraft: vi.fn(async ({ draftId }: { draftId: string }): Promise<DraftTombstone> => {
        deletes.push(draftId)
        await gate
        const row = server.get(draftId)
        const revision = (typeof row === 'number' ? row : (row?.revision ?? 0)) + 1
        server.set(draftId, revision)
        store.update((state) => applyDraftDeleted(state, { draftId, revision }))
        return { draftId, revision }
      }),
    }
    const sync = createDraftSync({ store, commands, supported: () => true, debounceMs: 1000 })
    return {
      store,
      sync,
      saves,
      deletes,
      server,
      commands,
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

  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }

  it('lists drafts once connected, then saves a burst of typing as one write', async () => {
    const { store, sync, saves, commands } = setup()
    await vi.advanceTimersByTimeAsync(0)
    expect(commands.listDrafts).toHaveBeenCalledTimes(1)
    expect(store.getState().draftsListed).toBe(true)

    sync.edit('d', NEW, { text: 'H' })
    sync.edit('d', NEW, { text: 'Hi' })
    sync.edit('d', NEW, { text: 'Hi there' })
    // In the state at once, so the host's cache keeps it across a reload.
    expect(selectDraftContent(store.getState(), 'd')).toEqual({ text: 'Hi there' })
    expect(saves).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1000)
    expect(saves).toEqual([
      { draftId: 'd', baseRevision: 0, target: NEW, content: { text: 'Hi there' } },
    ])
    expect(store.getState().draftEdits.d).toBeUndefined()
    expect(store.getState().drafts.d?.revision).toBe(1)
    sync.dispose()
  })

  it('waits while offline and saves what is waiting on connect', async () => {
    const { store, sync, saves } = setup(createInitialState())
    sync.edit('d', NEW, { text: 'offline words' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(saves).toHaveLength(0)

    store.update(connected)
    await vi.advanceTimersByTimeAsync(0)
    expect(saves.map((save) => save.content.text)).toEqual(['offline words'])
    sync.dispose()
  })

  it('never lets a later edit overtake an earlier one, and rebases it on the earlier write', async () => {
    const { store, sync, saves, hold } = setup()
    await vi.advanceTimersByTimeAsync(0)
    sync.edit('d', NEW, { text: 'one' })
    const release = hold()
    await vi.advanceTimersByTimeAsync(1000)
    sync.edit('d', NEW, { text: 'one two' })
    sync.flush()
    await settle()
    expect(saves).toHaveLength(1)
    release()
    await settle()
    expect(saves.map((save) => [save.content.text, save.baseRevision])).toEqual([
      ['one', 0],
      ['one two', 1],
    ])
    expect(store.getState().drafts.d?.content.text).toBe('one two')
    sync.dispose()
  })

  it('deletes a draft emptied by sending, and keeps what was typed after as the next one', async () => {
    // The deletion is announced before it is answered, so the text typed
    // meanwhile has to outlive the announcement, not only the answer.
    const { store, sync, saves, deletes, hold } = setup()
    const sessionId = 'session-9'
    const target: DraftTarget = { type: 'session', sessionId }
    await vi.advanceTimersByTimeAsync(0)
    sync.edit(sessionId, target, { text: 'Fix it' })
    await vi.advanceTimersByTimeAsync(1000)

    const release = hold()
    sync.edit(sessionId, target, { text: '' })
    sync.flush()
    await settle()
    expect(deletes).toEqual([sessionId])
    sync.edit(sessionId, target, { text: 'And the docs' })
    release()
    await settle()
    expect(store.getState().draftEdits[sessionId]?.baseRevision).toBe(2)
    expect(store.getState().draftTombstones[sessionId]).toBe(2)

    await vi.advanceTimersByTimeAsync(1000)
    expect(saves.at(-1)).toMatchObject({ baseRevision: 2, content: { text: 'And the docs' } })
    expect(store.getState().drafts[sessionId]?.revision).toBe(3)
    sync.dispose()
  })

  it('lets a draft discarded elsewhere stay gone', async () => {
    const { store, sync, server } = setup()
    await vi.advanceTimersByTimeAsync(0)
    sync.edit('d', NEW, { text: 'mine' })
    await vi.advanceTimersByTimeAsync(1000)
    server.set('d', 2)
    sync.edit('d', NEW, { text: 'mine, more' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.getState().draftEdits.d).toBeUndefined()
    expect(store.getState().drafts.d).toBeUndefined()
    expect(store.getState().draftTombstones.d).toBe(2)
    sync.dispose()
  })

  it('shows a remote save unless an edit is waiting, which then wins', async () => {
    const { store, sync, server } = setup()
    await vi.advanceTimersByTimeAsync(0)
    const remote = (revision: number, text: string) => {
      server.set('d', draft('d', revision, { text }))
      store.update((state) => applyDraftSaved(state, draft('d', revision, { text })))
    }
    remote(1, 'from the phone')
    expect(selectDraftContent(store.getState(), 'd')).toEqual({ text: 'from the phone' })

    sync.edit('d', NEW, { text: 'from the laptop' })
    remote(2, 'phone again')
    expect(selectDraftContent(store.getState(), 'd')).toEqual({ text: 'from the laptop' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(selectDraftContent(store.getState(), 'd')).toEqual({ text: 'from the laptop' })
    sync.dispose()
  })

  it('holds saves while the draft is sent and forgets it once the session exists', async () => {
    const { store, sync, saves } = setup()
    await vi.advanceTimersByTimeAsync(0)
    sync.edit('d', NEW, { text: 'Ship it', providerId: 'cursor' })
    sync.edit('d', NEW, { text: '', providerId: 'cursor' })
    sync.beginLaunch('d')
    await vi.advanceTimersByTimeAsync(5000)
    expect(saves).toHaveLength(0)
    // Typing meanwhile goes to the project's next draft.
    expect(selectNewSessionDraftId(store.getState(), WORKSPACE.workspaceId)).toBeUndefined()
    sync.endLaunch('d', 'sent')
    expect(store.getState().draftEdits.d).toBeUndefined()
    sync.dispose()
  })

  it('lets another device take a draft whose send stopped before it asked', async () => {
    const { store, sync } = setup()
    await vi.advanceTimersByTimeAsync(0)
    sync.edit('d', NEW, { text: 'hello' })
    await vi.advanceTimersByTimeAsync(1000)
    sync.edit('d', NEW, { text: '' })
    sync.beginLaunch('d')
    // The upload failed; the composer puts the text back.
    sync.endLaunch('d', 'aborted')
    sync.edit('d', NEW, { text: 'hello' })
    // Meanwhile the phone sent the same draft.
    store.update((state) => applyDraftDeleted(state, { draftId: 'd', revision: 2 }))
    expect(store.getState().draftEdits.d).toBeUndefined()
    sync.dispose()
  })

  it('saves a draft put back after a failed send, over the deletion the send made', async () => {
    const { store, sync, saves, server } = setup()
    await vi.advanceTimersByTimeAsync(0)
    sync.edit('d', NEW, { text: 'Ship it' })
    await vi.advanceTimersByTimeAsync(1000)
    sync.edit('d', NEW, { text: '' })
    sync.beginLaunch('d')
    // The environment deleted it with the session, which then failed to start.
    server.set('d', 2)
    sync.endLaunch('d', 'refused')
    sync.edit('d', NEW, { text: 'Ship it' })
    await vi.advanceTimersByTimeAsync(1000)
    await settle()
    expect(saves.map((save) => [save.content.text, save.baseRevision])).toEqual([
      ['Ship it', 0],
      ['Ship it', 1],
      ['Ship it', 2],
    ])
    expect(store.getState().drafts.d).toMatchObject({ revision: 3, content: { text: 'Ship it' } })
    sync.dispose()
  })
})

describe('mock environment drafts', () => {
  it('sends a draft as the session it names and deletes it with the session', async () => {
    const client = createMockEnvironmentClient({ seed: { workspaces: [WORKSPACE] } })
    await client.commands.listDrafts()
    const saved = await client.commands.saveDraft({
      draftId: 'd',
      baseRevision: 0,
      target: { ...NEW, sessionId: 'session-launch' },
      content: { text: 'Hello' },
    })
    expect(client.getState().drafts.d).toEqual(saved)
    const created = await client.commands.createSession({
      environmentId: client.getState().environment!.environmentId,
      workspaceId: WORKSPACE.workspaceId,
      providerId: WORKSPACE.capabilities.providers[0]!,
      sessionId: 'session-launch',
      draftId: 'd',
    })
    expect(created.session.sessionId).toBe('session-launch')
    expect(client.getState().drafts.d).toBeUndefined()
    await expect(
      client.commands.saveDraft({
        draftId: 'd',
        baseRevision: 1,
        target: { ...NEW, sessionId: 'session-launch' },
        content: { text: 'late' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    client.dispose()
  })
})
