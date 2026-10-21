/**
 * The sessions home, as rows: which status mark a session shows, which tab it
 * belongs to, and how the list groups and orders. Pure, so it is tested
 * without React Native, and shaped on the sidebar's shared session entry so
 * the environment providers slot in unchanged.
 */
import type {
  SidebarSessionEntry,
  WorkspaceEntry,
} from '@openmanager/app-core/providers/sidebar-provider'

export type HomeTab = 'all' | 'active' | 'drafts'

/** One glyph per state; the colours are the `--status-*` tokens. */
export type StatusMark = 'working' | 'background' | 'needs' | 'question' | 'done' | 'error' | 'idle'

export interface HomeSession extends SidebarSessionEntry {
  workspacePath: string
  /** Finished since the reader last looked; the environment clears it on acknowledge. */
  doneUnseen?: boolean
}

export interface HomeDraft {
  draftId: string
  workspacePath: string
  preview: string
  updatedAt: string
  providerLabel?: string
  synced: boolean
  imageCount?: number
}

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

/** The server's lifecycle plus what it says it waits on, read as one mark. */
export function statusMarkOf(
  session: Pick<SidebarSessionEntry, 'status' | 'waitingOn' | 'inBackground'> & {
    doneUnseen?: boolean
  },
): StatusMark {
  switch (session.status) {
    case 'running':
      return session.inBackground ? 'background' : 'working'
    case 'waiting':
      return session.waitingOn === 'question' ? 'question' : 'needs'
    case 'error':
      return 'error'
    default:
      return session.doneUnseen ? 'done' : 'idle'
  }
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

export function isActiveSession(
  session: Pick<SidebarSessionEntry, 'status' | 'settledAt'>,
): boolean {
  if (session.settledAt) return false
  return true
}

const DAY_MS = 24 * 60 * 60 * 1000

// Built once: an Intl formatter is costly to create and cheap to reuse.
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
const month = new Intl.DateTimeFormat(undefined, { month: 'long' })
const monthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

/** Today, Yesterday, the weekday within the week, else the month. */
export function dayLabel(iso: string | undefined, now: Date): string {
  if (!iso) return 'Earlier'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'Earlier'
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfThat = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
  const days = Math.round((startOfToday - startOfThat) / DAY_MS)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return weekday.format(at)
  if (at.getFullYear() === now.getFullYear()) return month.format(at)
  return monthYear.format(at)
}

const time = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0)

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

/**
 * Sessions as the home lists them for a tab. Children sit under their parent
 * at depth 1, in their own order, and never start a group.
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
  const topLevel = visible.filter(
    (session) => !session.parentExternalId || !ids.has(session.parentExternalId),
  )
  const children = new Map<string, HomeSession[]>()
  for (const session of visible) {
    if (session.parentExternalId && ids.has(session.parentExternalId)) {
      const list = children.get(session.parentExternalId) ?? []
      list.push(session)
      children.set(session.parentExternalId, list)
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
  const withChildren = (session: HomeSession): HomeRow[] => [
    row(session, 0),
    ...(children.get(session.externalId) ?? []).sort(byRecent).map((child) => row(child, 1)),
  ]

  if (tab === 'active') {
    const live = topLevel
      .filter((session) => activityRank(statusMarkOf(session)) < 4)
      .sort(
        (a, b) => activityRank(statusMarkOf(a)) - activityRank(statusMarkOf(b)) || byRecent(a, b),
      )
    const rest = topLevel
      .filter((session) => activityRank(statusMarkOf(session)) === 4)
      .sort(byRecent)
    const groups: HomeGroup<HomeRow>[] = []
    if (live.length)
      groups.push({ key: 'live', label: 'Working', rows: live.flatMap(withChildren) })
    if (rest.length)
      groups.push({ key: 'recent', label: 'Recent', rows: rest.flatMap(withChildren) })
    return groups
  }

  const groups = new Map<string, HomeGroup<HomeRow>>()
  for (const session of [...topLevel].sort(byRecent)) {
    const label = dayLabel(session.updatedAt, now)
    const group = groups.get(label) ?? { key: label, label, rows: [] }
    group.rows.push(...withChildren(session))
    groups.set(label, group)
  }
  return [...groups.values()]
}

/** Drafts for the drafts tab, newest first, grouped by day. */
export function selectDraftRows({
  drafts,
  workspaces,
  now = new Date(),
}: {
  drafts: readonly HomeDraft[]
  workspaces: readonly WorkspaceEntry[]
  now?: Date
}): HomeGroup<HomeDraftRow>[] {
  const byPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
  const groups = new Map<string, HomeGroup<HomeDraftRow>>()
  for (const draft of [...drafts].sort((a, b) => time(b.updatedAt) - time(a.updatedAt))) {
    const label = dayLabel(draft.updatedAt, now)
    const group = groups.get(label) ?? { key: label, label, rows: [] }
    group.rows.push({ kind: 'draft', draft, workspace: byPath.get(draft.workspacePath) })
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
