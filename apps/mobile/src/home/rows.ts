/**
 * The sessions home, as rows: which status mark a session shows, which tab it
 * belongs to, and how the list groups and orders. Pure, so it is tested
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

export type HomeTab = 'all' | 'active' | 'drafts'

/** One glyph per state: the web sidebar's tones, plus the ring at rest. */
export type StatusMark = SessionBusyTone | 'idle'

export interface HomeSession extends SidebarSessionEntry {
  workspacePath: string
}

/** A draft card exactly as the shared sidebar serves it. */
export type HomeDraft = SidebarDraft

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
  label: string
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

/** A short line under the title for what the session is up to. */
export function statusLineOf(session: HomeSession): string | null {
  switch (statusMarkOf(session)) {
    case 'working':
      return 'Working'
    case 'background':
      return session.backgroundTaskCount
        ? `${session.backgroundTaskCount} in the background`
        : 'In the background'
    case 'needs':
      return session.waitingOn === 'plan' ? 'Plan ready' : 'Needs you'
    case 'question':
      return 'Asked a question'
    case 'error':
      return 'Failed'
    case 'done':
      return 'Done'
    default:
      return null
  }
}

/** Active is everything the user has not settled. */
export function isActiveSession(session: Pick<SidebarSessionEntry, 'settledAt'>): boolean {
  return !session.settledAt
}

const DAY_MS = 24 * 60 * 60 * 1000

// Built once: an Intl formatter is costly to create and cheap to reuse.
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
const month = new Intl.DateTimeFormat(undefined, { month: 'long' })
const monthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

/** An ISO time or epoch ms as ms; null when it is missing or unreadable. */
function msOf(at: string | number | undefined): number | null {
  if (at === undefined) return null
  const ms = typeof at === 'number' ? at : Date.parse(at)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

/**
 * Today, Yesterday, the weekday within the week, "Earlier this month", the
 * month within the year, else the month and the year.
 */
export function dayLabel(at: string | number | undefined, now: Date): string {
  const ms = msOf(at)
  if (ms === null) return 'Earlier'
  const then = new Date(ms)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfThat = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()
  const days = Math.round((startOfToday - startOfThat) / DAY_MS)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return weekday.format(then)
  if (then.getFullYear() !== now.getFullYear()) return monthYear.format(then)
  if (then.getMonth() === now.getMonth()) return 'Earlier this month'
  return month.format(then)
}

const time = (at: string | number | undefined) => msOf(at) ?? 0

/** Live work first (needs you before working), then the newest. */
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
    default:
      return 4
  }
}

/** The Active tab's groups, most urgent first; a tree lands by its most urgent member. */
const ACTIVE_GROUPS: { key: string; label: string; ranks: readonly number[] }[] = [
  { key: 'needs', label: 'Needs you', ranks: [0] },
  { key: 'working', label: 'Working', ranks: [1, 2] },
  { key: 'failed', label: 'Failed', ranks: [3] },
  { key: 'recent', label: 'Recent', ranks: [4] },
]

interface Tree {
  rows: HomeRow[]
  /** The most urgent mark anywhere in it, as a rank. */
  rank: number
  /** Its newest activity anywhere in it, in ms; 0 when none is known. */
  newest: number
}

/**
 * Sessions as the home lists them for a tab. Children sit under their parent,
 * one level deeper per generation, in their own order, and never start a
 * group. A parent the tab can't show makes its child top-level; a cycle
 * (both ends visible, neither a root) stays visible as a top-level row,
 * as the web sidebar does. A tree is ranked by its most urgent member and
 * dated by its newest, so live work in a child is never buried under a
 * quiet parent. Display order only: no session's own state changes.
 */
export function selectHomeRows({
  sessions,
  workspaces,
  tab,
  now = new Date(),
}: {
  sessions: readonly HomeSession[]
  workspaces: readonly WorkspaceEntry[]
  tab: Exclude<HomeTab, 'drafts'>
  now?: Date
}): HomeGroup<HomeRow>[] {
  const byPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
  const visible = tab === 'active' ? sessions.filter(isActiveSession) : sessions
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

  if (tab === 'active') {
    return ACTIVE_GROUPS.flatMap(({ key, label, ranks }) => {
      const members = trees
        .filter((t) => ranks.includes(t.rank))
        .sort((a, b) => a.rank - b.rank || byNewest(a, b))
      return members.length ? [{ key, label, rows: members.flatMap((t) => t.rows) }] : []
    })
  }

  const groups = new Map<string, HomeGroup<HomeRow>>()
  for (const t of [...trees].sort(byNewest)) {
    const label = dayLabel(t.newest || undefined, now)
    const group = groups.get(label) ?? { key: label, label, rows: [] }
    group.rows.push(...t.rows)
    groups.set(label, group)
  }
  return [...groups.values()]
}

/** Drafts for the drafts tab, newest edit first, grouped by day. */
export function selectDraftRows({
  drafts,
  workspaces,
  now = new Date(),
}: {
  drafts: readonly HomeDraft[]
  workspaces: readonly WorkspaceEntry[]
  now?: Date
}): HomeGroup<HomeDraftRow>[] {
  // A workspace's id is its path, as the shared sidebar places draft cards.
  const byPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
  const groups = new Map<string, HomeGroup<HomeDraftRow>>()
  for (const draft of [...drafts].sort((a, b) => b.editedAt - a.editedAt)) {
    const label = dayLabel(draft.editedAt, now)
    const group = groups.get(label) ?? { key: label, label, rows: [] }
    group.rows.push({
      kind: 'draft',
      draft,
      workspace: draft.workspaceId === null ? undefined : byPath.get(draft.workspaceId),
    })
    groups.set(label, group)
  }
  return [...groups.values()]
}

/** How many sessions wait on the reader: the inbox badge. */
export function countNeedsYou(sessions: readonly HomeSession[]): number {
  return sessions.filter((session) => {
    const mark = statusMarkOf(session)
    return mark === 'needs' || mark === 'question'
  }).length
}

/** Counts for the tab labels. */
export function tabCounts(sessions: readonly HomeSession[], drafts: readonly HomeDraft[]) {
  return {
    all: sessions.length,
    active: sessions.filter(isActiveSession).length,
    drafts: drafts.length,
  }
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
