/**
 * The sessions home, as rows: which status mark a session shows, which view
 * it belongs to, and how the list groups and orders. Pure, so it is tested
 * without React Native, and shaped on the sidebar's shared session and draft
 * entries so the environment providers slot in unchanged.
 */
import {
  sessionBusyTone,
  type SessionBusyTone,
} from '@openmanager/app-core/components/sidebar/session-busy-tone'
import type {
  SidebarDraft,
  SidebarSessionEntry,
  WorkspaceEntry,
} from '@openmanager/app-core/providers/sidebar-provider'

/** All is what is unsettled; Settled is the long tail. */
export type HomeTab = 'all' | 'settled'

/** One glyph per state: the web sidebar's tones, plus the ring at rest. */
export type StatusMark = SessionBusyTone | 'idle'

/** The environment a row runs on, for a home that spans more than one. */
export interface HomeEnvironmentRef {
  environmentId: string
  label: string
}

export interface HomeSession extends SidebarSessionEntry {
  workspacePath: string
  environment?: HomeEnvironmentRef
}

/** A draft card exactly as the shared sidebar serves it, with where it is saved. */
export type HomeDraft = SidebarDraft & { environment?: HomeEnvironmentRef }

export interface HomeRow {
  kind: 'session'
  session: HomeSession
  workspace: WorkspaceEntry | undefined
  mark: StatusMark
  /** 0 for a top-level session; 1 under its parent. */
  depth: number
}

export interface HomeDraftRow {
  kind: 'draft'
  draft: HomeDraft
  workspace: WorkspaceEntry | undefined
}

export interface HomeGroup<Row> {
  key: string
  /** The small caps heading above the rows; null for a list with none. */
  label: string | null
  rows: Row[]
}

/**
 * The server's lifecycle plus what it says it waits on, read as one mark by
 * the web sidebar's own mapping: `done` until someone opens it, `busy` as
 * working, and `ready` / `idle` (or anything new) at rest.
 */
export function statusMarkOf(
  session: Pick<SidebarSessionEntry, 'status' | 'waitingOn' | 'inBackground'>,
): StatusMark {
  return (
    sessionBusyTone(session.status, {
      waitingOn: session.waitingOn,
      inBackground: session.inBackground,
    }) ?? 'idle'
  )
}

/**
 * A short line under the title for what the session is up to, in the web
 * sidebar's words (`STATUS_COPY`), drawn in the state's colour.
 */
export function statusLineOf(session: HomeSession): string | null {
  switch (statusMarkOf(session)) {
    case 'working':
      return 'Working'
    case 'background':
      return 'Background'
    case 'needs':
      return session.waitingOn === 'plan' ? 'Plan ready' : 'Needs input'
    case 'question':
      return 'Has a question'
    case 'error':
      return 'Failed'
    case 'done':
      return 'Done'
    default:
      return null
  }
}

/**
 * How much background work a live session carries, beside its status line
 * ("Background · 2"); null when none or when it is not running. Web says it
 * for background work alone; the phone says it while a turn runs too, since
 * there is no hover to name the tasks.
 */
export function statusCountOf(session: HomeSession): number | null {
  const mark = statusMarkOf(session)
  if (mark !== 'working' && mark !== 'background') return null
  return session.backgroundTaskCount ? session.backgroundTaskCount : null
}

/**
 * Pinned to the top, as web's sidebar keeps it: only active work, so a
 * session settled while pinned goes to the long tail with the rest.
 */
export function isPinnedSession(session: Pick<SidebarSessionEntry, 'settledAt' | 'pinnedAt'>) {
  return !!session.pinnedAt && !session.settledAt
}

/** The group pinned sessions sit in, above every other in All. */
export const PINNED_GROUP = 'pinned'

/** The group the draft cards sit in, above everything in All. */
export const DRAFTS_GROUP = 'drafts'

/** The one group of the Settled view, with no heading. */
export const SETTLED_GROUP = 'settled'

/** Active is everything the user has not settled. */
export function isActiveSession(session: Pick<SidebarSessionEntry, 'settledAt'>): boolean {
  return !session.settledAt
}

/** An ISO time or epoch ms as ms; null when it is missing or unreadable. */
function msOf(at: string | number | undefined): number | null {
  if (at === undefined) return null
  const ms = typeof at === 'number' ? at : Date.parse(at)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

const time = (at: string | number | undefined) => msOf(at) ?? 0

/**
 * What a session asks of the reader, as a rank: waiting on you, then live
 * work, then what failed (something to act on), then what finished since you
 * looked (something to read), then the rest.
 */
function activityRank(mark: StatusMark): number {
  switch (mark) {
    case 'needs':
    case 'question':
      return 0
    case 'working':
      return 1
    case 'background':
      return 2
    case 'error':
      return 3
    case 'done':
      return 4
    default:
      return 5
  }
}

/**
 * All's groups, most urgent first; a tree lands by its most urgent member.
 * These are what the inbox listed (needs you, failed, done since you looked)
 * in the one place, so nothing waits on a second screen.
 */
const ALL_GROUPS: { key: string; label: string; ranks: readonly number[] }[] = [
  { key: 'needs', label: 'Needs you', ranks: [0] },
  { key: 'working', label: 'Working', ranks: [1, 2] },
  { key: 'failed', label: 'Failed', ranks: [3] },
  { key: 'done', label: 'Done', ranks: [4] },
  { key: 'recent', label: 'Recent', ranks: [5] },
]

interface Tree {
  rows: HomeRow[]
  /** The most urgent mark anywhere in it, as a rank. */
  rank: number
  /** Its newest activity anywhere in it, in ms; 0 when none is known. */
  newest: number
  /** When its top row was pinned, in ms; 0 while it is not. */
  pinned: number
}

/**
 * Sessions as the home lists them for a view. Children sit under their
 * parent, one level deeper per generation, in their own order, and never
 * start a group. A parent the view can't show makes its child top-level; a
 * cycle (both ends visible, neither a root) stays visible as a top-level
 * row, as the web sidebar does. A tree is ranked by its most urgent member
 * and dated by its newest, so live work in a child is never buried under a
 * quiet parent.
 *
 * All: Pinned first (most recently pinned first, keeping its place as
 * others get activity), then Needs you, Working, Failed, Done, Recent, each
 * newest first. Settled: one flat list, newest first, with no heading.
 * Display order only: no session's own state changes.
 */
export function selectHomeRows({
  sessions,
  workspaces,
  tab,
}: {
  sessions: readonly HomeSession[]
  workspaces: readonly WorkspaceEntry[]
  tab: HomeTab
}): HomeGroup<HomeRow>[] {
  const byPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
  const visible = sessions.filter((session) =>
    tab === 'all' ? isActiveSession(session) : !isActiveSession(session),
  )
  const ids = new Set(visible.map((session) => session.externalId))
  const roots: HomeSession[] = []
  const children = new Map<string, HomeSession[]>()
  for (const session of visible) {
    if (session.parentExternalId && ids.has(session.parentExternalId)) {
      const list = children.get(session.parentExternalId) ?? []
      list.push(session)
      children.set(session.parentExternalId, list)
    } else {
      roots.push(session)
    }
  }
  const row = (session: HomeSession, depth: number): HomeRow => ({
    kind: 'session',
    session,
    workspace: byPath.get(session.workspacePath),
    mark: statusMarkOf(session),
    depth,
  })
  const byRecent = (a: HomeSession, b: HomeSession) => time(b.updatedAt) - time(a.updatedAt)
  const visited = new Set<string>()
  const subtree = (session: HomeSession, depth: number): HomeRow[] => {
    if (visited.has(session.externalId)) return []
    visited.add(session.externalId)
    return [
      row(session, depth),
      ...(children.get(session.externalId) ?? [])
        .sort(byRecent)
        .flatMap((child) => subtree(child, depth + 1)),
    ]
  }
  const tree = (root: HomeSession): Tree => {
    const rows = subtree(root, 0)
    return {
      rows,
      rank: Math.min(...rows.map((r) => activityRank(r.mark))),
      newest: Math.max(...rows.map((r) => time(r.session.updatedAt))),
      pinned: isPinnedSession(root) ? time(root.pinnedAt ?? undefined) || 1 : 0,
    }
  }
  // One tree per top-level row; whatever no root reaches is a cycle, and
  // its members become top-level rather than vanish.
  const trees: Tree[] = []
  for (const root of roots) trees.push(tree(root))
  for (const session of visible) {
    if (!visited.has(session.externalId)) trees.push(tree(session))
  }
  const byNewest = (a: Tree, b: Tree) => b.newest - a.newest

  if (tab === 'settled') {
    const rows = [...trees].sort(byNewest).flatMap((t) => t.rows)
    return rows.length ? [{ key: SETTLED_GROUP, label: null, rows }] : []
  }

  const pinned = trees.filter((t) => t.pinned).sort((a, b) => b.pinned - a.pinned || byNewest(a, b))
  const unpinned = trees.filter((t) => !t.pinned)
  const pinnedGroups: HomeGroup<HomeRow>[] = pinned.length
    ? [{ key: PINNED_GROUP, label: 'Pinned', rows: pinned.flatMap((t) => t.rows) }]
    : []
  return [
    ...pinnedGroups,
    ...ALL_GROUPS.flatMap(({ key, label, ranks }) => {
      const members = unpinned
        .filter((t) => ranks.includes(t.rank))
        .sort((a, b) => a.rank - b.rank || byNewest(a, b))
      return members.length ? [{ key, label, rows: members.flatMap((t) => t.rows) }] : []
    }),
  ]
}

/** The draft cards, newest edit first. */
export function selectDraftRows({
  drafts,
  workspaces,
}: {
  drafts: readonly HomeDraft[]
  workspaces: readonly WorkspaceEntry[]
}): HomeDraftRow[] {
  // A workspace's id is its path, as the shared sidebar places draft cards.
  const byPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
  return [...drafts]
    .sort((a, b) => b.editedAt - a.editedAt)
    .map((draft) => ({
      kind: 'draft',
      draft,
      workspace: draft.workspaceId === null ? undefined : byPath.get(draft.workspaceId),
    }))
}

/** A row of either view: a session, or a draft. */
export type HomeListRow = HomeRow | HomeDraftRow

/**
 * A view's rows: All opens with the draft cards, as the web sidebar's Drafts
 * section sits above Active, then the session groups; Settled is the
 * sessions alone.
 */
export function selectTabRows({
  sessions,
  drafts,
  workspaces,
  tab,
}: {
  sessions: readonly HomeSession[]
  drafts: readonly HomeDraft[]
  workspaces: readonly WorkspaceEntry[]
  tab: HomeTab
}): HomeGroup<HomeListRow>[] {
  const sessionGroups = selectHomeRows({ sessions, workspaces, tab })
  if (tab === 'settled') return sessionGroups
  const draftRows = selectDraftRows({ drafts, workspaces })
  return draftRows.length
    ? [{ key: DRAFTS_GROUP, label: 'Drafts', rows: draftRows }, ...sessionGroups]
    : sessionGroups
}

/** Counts for the view labels: sessions only, since All's drafts are cards, not sessions. */
export function tabCounts(sessions: readonly HomeSession[]) {
  const all = sessions.filter(isActiveSession).length
  return { all, settled: sessions.length - all }
}

/**
 * How many environments the rows come from. The home names an environment
 * on a row only when they span more than one; a row that says nothing of
 * its environment (a host that knows one alone) counts for none.
 */
export function countEnvironments(rows: readonly { environment?: HomeEnvironmentRef }[]): number {
  const ids = new Set<string>()
  for (const row of rows) if (row.environment) ids.add(row.environment.environmentId)
  return ids.size
}

/**
 * Where every row stands: its group and its place in it, by key. Changes
 * when rows come, go or move, never with what a row shows.
 */
export function listShapeOf<Row>(
  sections: readonly { key: string; data: readonly Row[] }[],
  keyOf: (row: Row) => string,
): string {
  return sections.map((section) => `${section.key}:${section.data.map(keyOf).join(',')}`).join('|')
}
