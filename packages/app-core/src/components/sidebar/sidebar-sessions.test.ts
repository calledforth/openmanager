import { describe, expect, it } from 'vitest'
import {
  createInitialState,
  type DraftEdit,
  type EnvironmentState,
} from '@openmanager/environment-client'
import type { Draft } from '@openmanager/protocol'
import {
  arrangeSidebarDrafts,
  draftPreview,
  flattenSidebarSessions,
  sameSidebarDraftFacts,
  selectSessionsWithUnsentDraft,
  selectSidebarDrafts,
  sidebarDraftCard,
  type SidebarDraft,
  type SidebarSession,
} from './sidebar-sessions'
import { sessionBusyTone } from './SessionBusyLoader'

const session = (
  externalId: string,
  parentExternalId?: string,
  status: string = 'idle',
): SidebarSession => ({
  externalId,
  parentExternalId,
  status,
  providerId: 'opencode',
})

describe('sessionBusyTone', () => {
  it('maps waiting to needs, unseen completions to done, and in-flight statuses to working', () => {
    expect(sessionBusyTone('waiting')).toBe('needs')
    expect(sessionBusyTone('done')).toBe('done')
    expect(sessionBusyTone('running')).toBe('working')
    expect(sessionBusyTone('busy')).toBe('working')
    expect(sessionBusyTone('error')).toBe('error')
    // At rest (and already seen): no glyph, the card shows its age.
    expect(sessionBusyTone('ready')).toBe(null)
    expect(sessionBusyTone('idle')).toBe(null)
  })
})

describe('flattenSidebarSessions', () => {
  it('places nested subagent transcripts directly beneath their ancestry', () => {
    const rows = flattenSidebarSessions([
      session('new-root'),
      session('grandchild', 'child'),
      session('child', 'root'),
      session('root'),
    ])

    expect(
      rows.map(({ session: row, depth, isChild }) => ({
        id: row.externalId,
        depth,
        isChild,
      })),
    ).toEqual([
      { id: 'new-root', depth: 0, isChild: false },
      { id: 'root', depth: 0, isChild: false },
      { id: 'child', depth: 1, isChild: true },
      { id: 'grandchild', depth: 2, isChild: true },
    ])
  })

  it('keeps orphaned and cyclic child sessions visible', () => {
    const rows = flattenSidebarSessions([
      session('orphan', 'missing'),
      session('cycle-a', 'cycle-b'),
      session('cycle-b', 'cycle-a'),
    ])

    expect(rows.map(({ session: row }) => row.externalId).sort()).toEqual([
      'cycle-a',
      'cycle-b',
      'orphan',
    ])
    expect(rows.find(({ session: row }) => row.externalId === 'orphan')).toMatchObject({
      depth: 0,
      isChild: true,
      isOrphan: true,
    })
  })
})

const connected = (state: EnvironmentState): EnvironmentState => ({
  ...state,
  connection: { ...state.connection, phase: 'connected' },
})

const newDraft = (workspaceId: string | null, sessionId: string): DraftEdit['target'] => ({
  type: 'new_session',
  workspaceId,
  sessionId,
})

/** An environment holding `saved` drafts, with `edits` waiting on top. */
function draftState({
  saved = [],
  edits = {},
  sessions = [],
}: {
  saved?: Array<Pick<Draft, 'draftId' | 'target' | 'content'> & { updatedAt?: string }>
  edits?: Record<string, DraftEdit>
  sessions?: Array<{
    sessionId: string
    workspaceId: string
    providerId: string
    updatedAt?: string
  }>
}): EnvironmentState {
  const state = connected(createInitialState())
  return {
    ...state,
    drafts: Object.fromEntries(
      saved.map((draft) => [
        draft.draftId,
        {
          ...draft,
          revision: 1,
          createdAt: '2026-10-05T10:00:00.000Z',
          updatedAt: draft.updatedAt ?? '2026-10-05T10:00:00.000Z',
          updatedByClientId: null,
        } as Draft,
      ]),
    ),
    draftEdits: edits,
    sessions: Object.fromEntries(
      sessions.map((session) => [
        session.sessionId,
        {
          status: 'idle',
          title: null,
          ...session,
        } as unknown as EnvironmentState['sessions'][string],
      ]),
    ),
  }
}

const edit = (
  target: DraftEdit['target'],
  content: DraftEdit['content'],
  editedAt: number,
  extra: Partial<DraftEdit> = {},
): DraftEdit => ({ target, content, baseRevision: 0, editedAt, ...extra })

const card = (draftId: string, editedAt: number): SidebarDraft => ({
  draftId,
  sessionId: `s-${draftId}`,
  workspaceId: 'alpha',
  providerId: 'opencode',
  preview: draftId,
  imageCount: 0,
  editedAt,
})

describe('draft cards', () => {
  it('gives a card to text or an image, never to picks alone or to a session draft', () => {
    const state = draftState({
      edits: {
        text: edit(newDraft('alpha', 's-text'), { text: '  \n  first line \nsecond' }, 3),
        image: edit(newDraft('alpha', 's-image'), { text: '', artifactIds: ['a1', 'a2'] }, 2),
        picks: edit(
          newDraft('alpha', 's-picks'),
          { text: ' ', providerId: 'opencode', preference: { modelId: 'opus' } },
          1,
        ),
        'session-1': edit({ type: 'session', sessionId: 'session-1' }, { text: 'reply' }, 4),
      },
    })
    expect(sidebarDraftCard(state, 'text', 'opencode')).toMatchObject({
      preview: 'first line',
      imageCount: 0,
    })
    expect(sidebarDraftCard(state, 'image', 'opencode')).toMatchObject({
      preview: '',
      imageCount: 2,
    })
    expect(sidebarDraftCard(state, 'picks', 'opencode')).toBeNull()
    expect(sidebarDraftCard(state, 'session-1', 'opencode')).toBeNull()
    expect(sidebarDraftCard(state, 'unknown', 'opencode')).toBeNull()
  })

  it('shows the provider picked, else the one the project last ran, else the default', () => {
    const state = draftState({
      sessions: [
        { sessionId: 'old', workspaceId: 'alpha', providerId: 'claude', updatedAt: '2026-10-01' },
        { sessionId: 'new', workspaceId: 'alpha', providerId: 'cursor', updatedAt: '2026-10-04' },
      ],
      edits: {
        picked: edit(newDraft('alpha', 's1'), { text: 'a', providerId: 'claude' }, 1),
        seeded: edit(newDraft('alpha', 's2'), { text: 'b' }, 1),
        elsewhere: edit(newDraft('beta', 's3'), { text: 'c' }, 1),
      },
    })
    expect(sidebarDraftCard(state, 'picked', 'opencode')?.providerId).toBe('claude')
    expect(sidebarDraftCard(state, 'seeded', 'opencode')?.providerId).toBe('cursor')
    expect(sidebarDraftCard(state, 'elsewhere', 'opencode')?.providerId).toBe('opencode')
  })

  it('keeps a card for a draft being sent, with what the environment last had', () => {
    const state = draftState({
      saved: [{ draftId: 'sending', target: newDraft('alpha', 's1'), content: { text: 'go' } }],
      // The composer emptied it as it was sent.
      edits: { sending: edit(newDraft('alpha', 's1'), { text: '' }, 5, { launching: true }) },
    })
    expect(sidebarDraftCard(state, 'sending', 'opencode')?.preview).toBe('go')
  })

  it('marks a card whose latest edit has not reached the environment, as the composer does', () => {
    const state = draftState({
      edits: {
        saving: edit(newDraft('alpha', 's1'), { text: 'a' }, 1),
        stuck: edit(newDraft('alpha', 's2'), { text: 'b' }, 1, { stalled: 'too_large' }),
      },
    })
    expect(sidebarDraftCard(state, 'saving', 'opencode')?.unsynced).toBeUndefined()
    expect(sidebarDraftCard(state, 'stuck', 'opencode')?.unsynced).toBe('too_large')
    const offline: EnvironmentState = {
      ...state,
      connection: { ...state.connection, phase: 'reconnecting' },
    }
    expect(sidebarDraftCard(offline, 'saving', 'opencode')?.unsynced).toBe('offline')
  })

  it('lists drafts newest edit first, less the one on screen and any already a session', () => {
    const state = draftState({
      sessions: [{ sessionId: 's-sent', workspaceId: 'alpha', providerId: 'opencode' }],
      saved: [
        {
          draftId: 'remote',
          target: newDraft('beta', 's-remote'),
          content: { text: 'from the phone' },
          updatedAt: new Date(2_000).toISOString(),
        },
      ],
      edits: {
        older: edit(newDraft('alpha', 's-older'), { text: 'older' }, 1_000),
        newer: edit(newDraft(null, 's-newer'), { text: 'newer' }, 3_000),
        open: edit(newDraft('alpha', 's-open'), { text: 'typing' }, 4_000),
        sent: edit(newDraft('alpha', 's-sent'), { text: 'sent' }, 5_000, { launching: true }),
      },
    })
    const facts = selectSidebarDrafts(state, 'open', 's-open', 'opencode')
    expect(facts.cards.map((shown) => shown.draftId)).toEqual(['newer', 'remote', 'older'])
    // A removed project's draft still has its card.
    expect(facts.cards[0]).toMatchObject({ workspaceId: null })
    expect(facts.openSent).toBe(false)
    expect(selectSidebarDrafts(state, 'sent', 's-sent', 'opencode').openSent).toBe(true)
  })

  it('compares equal while only the draft on screen changes', () => {
    const before = draftState({
      edits: {
        open: edit(newDraft('alpha', 's-open'), { text: 'a' }, 1),
        other: edit(newDraft('alpha', 's-other'), { text: 'b' }, 2),
      },
    })
    const after: EnvironmentState = {
      ...before,
      draftEdits: {
        ...before.draftEdits,
        open: edit(newDraft('alpha', 's-open'), { text: 'ab' }, 3),
      },
    }
    expect(
      sameSidebarDraftFacts(
        selectSidebarDrafts(before, 'open', null, 'opencode'),
        selectSidebarDrafts(after, 'open', null, 'opencode'),
      ),
    ).toBe(true)
    // Not once it is left: its card moves up with what was typed.
    expect(
      sameSidebarDraftFacts(
        selectSidebarDrafts(before, null, null, 'opencode'),
        selectSidebarDrafts(after, null, null, 'opencode'),
      ),
    ).toBe(false)
  })

  it('keeps the open draft’s frozen card in its place, and drops it once sent, gone or discarded', () => {
    const facts = {
      cards: [card('c', 3), card('a', 1)],
      openSent: false,
      openGone: false,
      openSending: false,
      openSendingCard: null,
    }
    const frozen = card('b', 2)
    const ids = (cards: SidebarDraft[]) => cards.map((shown) => shown.draftId)
    expect(ids(arrangeSidebarDrafts({ facts, frozen, hidden: null }))).toEqual(['c', 'b', 'a'])
    // No snapshot: a draft first written on this page has no card yet.
    expect(ids(arrangeSidebarDrafts({ facts, frozen: null, hidden: null }))).toEqual(['c', 'a'])
    expect(
      ids(arrangeSidebarDrafts({ facts: { ...facts, openSent: true }, frozen, hidden: null })),
    ).toEqual(['c', 'a'])
    // Deleted elsewhere, or emptied here: the snapshot's text is stale.
    expect(
      ids(arrangeSidebarDrafts({ facts: { ...facts, openGone: true }, frozen, hidden: null })),
    ).toEqual(['c', 'a'])
    expect(ids(arrangeSidebarDrafts({ facts, frozen, hidden: 'b' }))).toEqual(['c', 'a'])
    expect(ids(arrangeSidebarDrafts({ facts, frozen, hidden: 'c' }))).toEqual(['b', 'a'])
    // Being sent from its page: what is being sent, not the snapshot, in the
    // snapshot's place, and no longer discardable.
    const sending = arrangeSidebarDrafts({
      facts: {
        ...facts,
        openSending: true,
        openSendingCard: { ...card('b', 9), preview: 'as sent', sending: true },
      },
      frozen,
      hidden: null,
    })
    expect(ids(sending)).toEqual(['c', 'b', 'a'])
    expect(sending[1]).toMatchObject({ preview: 'as sent', sending: true })
    // Nothing to show of what is being sent: the snapshot stays, still not
    // discardable.
    const blank = arrangeSidebarDrafts({
      facts: { ...facts, openSending: true },
      frozen,
      hidden: null,
    })
    expect(blank[1]).toMatchObject({ preview: 'b', sending: true })
  })

  it('says which draft is being sent, and when the one on screen is gone', () => {
    const state = draftState({
      saved: [{ draftId: 'sending', target: newDraft('alpha', 's1'), content: { text: 'go' } }],
      edits: {
        sending: edit(newDraft('alpha', 's1'), { text: '' }, 5, { launching: true }),
        open: edit(newDraft('alpha', 's2'), { text: 'typing' }, 6, { launching: true }),
        // Emptied by its composer before the send was held, and never saved:
        // what went is the capture.
        captured: edit(newDraft('alpha', 's3'), { text: '' }, 7, {
          launching: true,
          sent: { text: 'what went' },
        }),
        blank: edit(newDraft('alpha', 's4'), { text: '' }, 8, { launching: true }),
      },
    })
    expect(sidebarDraftCard(state, 'sending', 'opencode')).toMatchObject({ sending: true })
    expect(selectSidebarDrafts(state, 'open', 's2', 'opencode')).toMatchObject({
      openSending: true,
      openSendingCard: { preview: 'typing', sending: true },
      openGone: false,
    })
    expect(sidebarDraftCard(state, 'captured', 'opencode')).toMatchObject({
      preview: 'what went',
      sending: true,
    })
    // No card to show, but still being sent.
    expect(selectSidebarDrafts(state, 'blank', 's4', 'opencode')).toMatchObject({
      openSending: true,
      openSendingCard: null,
    })
    expect(selectSidebarDrafts(state, 'deleted', null, 'opencode').openGone).toBe(true)
  })

  it('previews the first written line, trimmed and capped', () => {
    expect(draftPreview('\n\n  hello  \nworld')).toBe('hello')
    expect(draftPreview('   ')).toBe('')
    expect(draftPreview('x'.repeat(500))).toHaveLength(160)
  })
})

describe('unsent session drafts', () => {
  it('lists sessions whose composer holds text, less the one on screen', () => {
    const session = (sessionId: string): DraftEdit['target'] => ({ type: 'session', sessionId })
    const state = draftState({
      saved: [
        { draftId: 'b', target: session('b'), content: { text: 'saved text' } },
        { draftId: 'c', target: session('c'), content: { text: 'cleared here' } },
        { draftId: 'n', target: newDraft('alpha', 's-n'), content: { text: 'not a session' } },
      ],
      edits: {
        a: edit(session('a'), { text: 'typing' }, 1),
        c: edit(session('c'), { text: '' }, 2),
        open: edit(session('open'), { text: 'mine' }, 3),
      },
    })
    expect(selectSessionsWithUnsentDraft(state, 'open')).toEqual(['a', 'b'])
    expect(selectSessionsWithUnsentDraft(state, null)).toEqual(['a', 'b', 'open'])
  })
})
