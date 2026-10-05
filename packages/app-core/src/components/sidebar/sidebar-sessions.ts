import { isProviderId, type ProviderId } from '@agentpack/contract'
import type { DraftContent, DraftTarget } from '@openmanager/protocol'
import {
  hasDraftContent,
  selectDraftSyncStatus,
  type DraftStall,
  type EnvironmentState,
} from '@openmanager/environment-client'

// The sidebar's view of sessions and projects, independent of any host.

export interface SidebarSession {
  externalId: string
  title?: string
  status: string
  providerId?: ProviderId
  parentExternalId?: string
  /** Its project folder is unreachable, so the row cannot run until it is back. */
  workspaceUnavailable?: boolean
  /** ISO time of the last activity, when the host tracks it. */
  updatedAt?: string
  /** ISO time the user settled it; null or absent while it is active. */
  settledAt?: string | null
  /** Its composer holds text or an image that was not sent. */
  hasUnsentDraft?: boolean
}

/**
 * A new-session draft as its sidebar card shows it. Only what the card
 * shows, so a card compares equal while anything else about the draft
 * changes.
 */
export interface SidebarDraft {
  draftId: string
  /**
   * The id its session will get. Cards are keyed by it, so sending the draft
   * turns its card into the session's card in place, with nothing folding
   * away or growing in between.
   */
  sessionId: string
  /** Its project; null once that project was removed. */
  workspaceId: string | null
  providerId: ProviderId
  /** The first line written, or empty for a draft of images alone. */
  preview: string
  imageCount: number
  /**
   * When it was last edited, in ms; orders the cards, newest first. An edit
   * waiting here is on this client's clock and a saved copy on the
   * environment's, so a skewed clock can misorder two drafts edited moments
   * apart on different devices; nothing worse.
   */
  editedAt: number
  /** Why the environment does not have its latest edit. Absent while it is synced or only saving. */
  unsynced?: DraftStall
  /** A send has it: it is the session's now, and cannot be discarded. */
  sending?: true
}

/** Marks a draft card's button with its draft id, for focus to find it again. */
export const DRAFT_CARD_ATTRIBUTE = 'data-draft-card'

/** How a draft card's discard was made. */
export interface DraftDiscardOptions {
  /** Made from the keyboard: the notice takes focus, so Undo is a keypress away. */
  fromKeyboard?: boolean
  /** Where focus goes when the notice closes with focus on it: the next card over. */
  returnFocus?: HTMLElement | null
}

/** Long enough for any card width; the rest is never shown. */
const PREVIEW_MAX = 160

/** The first line with something on it, trimmed for a card. */
export function draftPreview(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed.length > PREVIEW_MAX ? trimmed.slice(0, PREVIEW_MAX) : trimmed
  }
  return ''
}

/**
 * Each project's last-run provider (its most recently active top-level
 * session's), as the draft's composer seeds it. Kept per sessions object, so
 * reading it on every keystroke costs one lookup.
 */
const lastProviders = new WeakMap<EnvironmentState['sessions'], Map<string, ProviderId>>()
function lastProviderOf(state: EnvironmentState, workspaceId: string | null) {
  if (!workspaceId) return undefined
  let byWorkspace = lastProviders.get(state.sessions)
  if (!byWorkspace) {
    const newest = new Map<string, { at: string; providerId: ProviderId }>()
    for (const session of Object.values(state.sessions)) {
      if (!session || session.parentSessionId || !isProviderId(session.providerId)) continue
      const at = session.updatedAt ?? ''
      const best = newest.get(session.workspaceId)
      if (!best || at > best.at)
        newest.set(session.workspaceId, { at, providerId: session.providerId })
    }
    byWorkspace = new Map([...newest].map(([id, { providerId }]) => [id, providerId]))
    lastProviders.set(state.sessions, byWorkspace)
  }
  return byWorkspace.get(workspaceId)
}

/**
 * The card a new-session draft gets, or null when it gets none: only text or
 * an image makes a card, never a model or mode pick alone.
 */
export function sidebarDraftCard(
  state: EnvironmentState,
  draftId: string,
  defaultProviderId: ProviderId,
): SidebarDraft | null {
  const edit = state.draftEdits[draftId]
  const saved = state.drafts[draftId]
  const target: DraftTarget | undefined = edit?.target ?? saved?.target
  if (target?.type !== 'new_session') return null
  // A draft being sent was emptied by its composer; what it was sent with is
  // the environment's last copy, and its card shows that until the session
  // takes its place.
  let content: DraftContent | undefined = edit?.content ?? saved?.content
  if (edit?.launching && !hasDraftContent(content)) content = saved?.content
  if (!content || !hasDraftContent(content)) return null
  const picked = content.providerId
  const status = selectDraftSyncStatus(state, draftId)
  return {
    draftId,
    sessionId: target.sessionId,
    workspaceId: target.workspaceId,
    providerId:
      (isProviderId(picked) ? picked : undefined) ??
      lastProviderOf(state, target.workspaceId) ??
      defaultProviderId,
    preview: draftPreview(content.text),
    imageCount: content.artifactIds?.length ?? 0,
    editedAt: edit ? edit.editedAt : saved ? Date.parse(saved.updatedAt) || 0 : 0,
    ...(status !== 'synced' && status !== 'saving' ? { unsynced: status } : {}),
    ...(edit?.launching ? { sending: true as const } : {}),
  }
}

/** What the sidebar reads off the environment for its draft cards. */
export interface SidebarDraftFacts {
  /** Every draft with a card, newest edit first, less the one on screen. */
  cards: SidebarDraft[]
  /** The draft on screen has become its session (sent here or elsewhere). */
  openSent: boolean
  /**
   * The draft on screen is gone: deleted on another device, or emptied here
   * and deleted. Its snapshot would show text the composer no longer has.
   */
  openGone: boolean
  /**
   * The draft on screen while it is being sent: its card as sent, read live,
   * so the card shows what went rather than the snapshot. Null otherwise.
   */
  openSending: SidebarDraft | null
}

export const NO_DRAFT_FACTS: SidebarDraftFacts = {
  cards: [],
  openSent: false,
  openGone: false,
  openSending: null,
}

/**
 * The draft cards, read live. The draft on screen is left out: its card is
 * the snapshot taken when it was opened, so typing never repaints the
 * sidebar. A draft whose session exists is left out too, from the same
 * update that lists the session, so a send swaps one card for the other with
 * no frame showing both or neither.
 */
export function selectSidebarDrafts(
  state: EnvironmentState,
  openDraftId: string | null,
  openSessionId: string | null,
  defaultProviderId: ProviderId,
): SidebarDraftFacts {
  const cards: SidebarDraft[] = []
  const ids = new Set([...Object.keys(state.draftEdits), ...Object.keys(state.drafts)])
  for (const draftId of ids) {
    if (draftId === openDraftId) continue
    const card = sidebarDraftCard(state, draftId, defaultProviderId)
    if (card && !state.sessions[card.sessionId]) cards.push(card)
  }
  return {
    cards: cards.sort(newestDraftFirst),
    openSent: openSessionId !== null && state.sessions[openSessionId] !== undefined,
    openGone: openDraftId !== null && !state.drafts[openDraftId] && !state.draftEdits[openDraftId],
    openSending:
      openDraftId !== null && state.draftEdits[openDraftId]?.launching
        ? sidebarDraftCard(state, openDraftId, defaultProviderId)
        : null,
  }
}

function newestDraftFirst(left: SidebarDraft, right: SidebarDraft) {
  return right.editedAt - left.editedAt || (right.draftId > left.draftId ? 1 : -1)
}

function sameDraft(left: SidebarDraft, right: SidebarDraft) {
  return (
    left === right ||
    (left.draftId === right.draftId &&
      left.sessionId === right.sessionId &&
      left.workspaceId === right.workspaceId &&
      left.providerId === right.providerId &&
      left.preview === right.preview &&
      left.imageCount === right.imageCount &&
      left.editedAt === right.editedAt &&
      left.unsynced === right.unsynced &&
      left.sending === right.sending)
  )
}

/** Equal while every card shows the same: what keeps the sidebar still as a draft is typed in. */
export function sameSidebarDraftFacts(left: SidebarDraftFacts, right: SidebarDraftFacts) {
  return (
    left.openSent === right.openSent &&
    left.openGone === right.openGone &&
    (left.openSending === right.openSending ||
      (left.openSending !== null &&
        right.openSending !== null &&
        sameDraft(left.openSending, right.openSending))) &&
    left.cards.length === right.cards.length &&
    left.cards.every((card, index) => sameDraft(card, right.cards[index]!))
  )
}

/**
 * The cards to show: the live ones, plus the open draft's frozen card where
 * it had one when it was opened, less any discard waiting out its undo. The
 * frozen card keeps its place: it was taken before the typing that would
 * move it, and moves when the draft is left. While the draft is being sent
 * it shows what is being sent, still in its place; it goes once its draft is
 * a session or is gone.
 */
export function arrangeSidebarDrafts({
  facts,
  frozen,
  hidden,
}: {
  facts: SidebarDraftFacts
  frozen: SidebarDraft | null
  hidden: string | null
}): SidebarDraft[] {
  const shown =
    frozen &&
    !facts.openSent &&
    !facts.openGone &&
    !facts.cards.some((card) => card.draftId === frozen.draftId)
      ? facts.openSending
        ? { ...facts.openSending, editedAt: frozen.editedAt, sending: true as const }
        : frozen
      : null
  const cards = shown ? [...facts.cards, shown].sort(newestDraftFirst) : facts.cards
  return hidden === null ? cards : cards.filter((card) => card.draftId !== hidden)
}

/**
 * Sessions whose composer holds unsent text or an image, sorted. The session
 * on screen is left out: its composer is the one being typed in, and a mark
 * that came and went with each emptied line would only flicker.
 */
export function selectSessionsWithUnsentDraft(
  state: EnvironmentState,
  openSessionId: string | null,
): string[] {
  const ids: string[] = []
  const consider = (draftId: string, target: DraftTarget, content: DraftContent) => {
    if (target.type === 'session' && draftId !== openSessionId && hasDraftContent(content)) {
      ids.push(draftId)
    }
  }
  for (const [draftId, edit] of Object.entries(state.draftEdits)) {
    consider(draftId, edit.target, edit.content)
  }
  for (const draft of Object.values(state.drafts)) {
    if (!state.draftEdits[draft.draftId]) consider(draft.draftId, draft.target, draft.content)
  }
  return ids.sort()
}

export interface SidebarWorkspace {
  path: string
  name: string
  /** Registered but not on disk right now; no session can start here. */
  missing?: boolean
  availability?: 'available' | 'missing' | 'inaccessible'
  /** The checkout's branch (null when detached) and whether it is a linked worktree. */
  git?: { branch: string | null; worktree: boolean }
  sessions: SidebarSession[]
}

export interface SidebarSessionRow {
  session: SidebarSession
  depth: number
  isChild: boolean
  isOrphan: boolean
}

/** Preserve recency order within each level while placing child transcripts
 * directly beneath their parent. Missing parents and cycles remain visible. */
export function flattenSidebarSessions(sessions: SidebarSession[]): SidebarSessionRow[] {
  const byId = new Map(sessions.map((session) => [session.externalId, session]))
  const children = new Map<string, SidebarSession[]>()
  const roots: SidebarSession[] = []
  for (const session of sessions) {
    if (session.parentExternalId && byId.has(session.parentExternalId)) {
      const siblings = children.get(session.parentExternalId) ?? []
      siblings.push(session)
      children.set(session.parentExternalId, siblings)
    } else {
      roots.push(session)
    }
  }

  const rows: SidebarSessionRow[] = []
  const visited = new Set<string>()
  const visit = (session: SidebarSession, depth: number, isOrphan: boolean) => {
    if (visited.has(session.externalId)) return
    visited.add(session.externalId)
    rows.push({
      session,
      depth,
      isChild: !!session.parentExternalId,
      isOrphan,
    })
    for (const child of children.get(session.externalId) ?? []) {
      visit(child, depth + 1, false)
    }
  }

  for (const root of roots) {
    visit(root, 0, !!root.parentExternalId)
  }
  for (const session of sessions) {
    if (!visited.has(session.externalId)) visit(session, 0, true)
  }
  return rows
}
