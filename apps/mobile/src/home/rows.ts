/**
 * The sessions home, as rows: which status mark a session shows, where the
 * reader put it (active, cooking, settled), and how the one list orders.
 * The web sidebar's board (`partitionSidebarSessions`), on the phone's rows.
 * Pure, so it is tested without React Native, and shaped on the sidebar's
 * shared session and draft entries so the environment providers slot in
 * unchanged.
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

/** One environment's projects, as the home source lists them per environment. */
export interface EnvironmentProjects {
  environmentId: string
  workspaces: readonly WorkspaceEntry[]
}

/**
 * A session row's key: its environment and its id, since ids are only
 * unique within one environment. `id` names another session of the same
 * environment (its parent, say).
 */
export function homeSessionKey(session: HomeSession, id: string = session.externalId): string {
  return `${session.environment?.environmentId ?? ''}
${id}`
}

/**
 * A row's project, looked up in its own environment's projects: two
 * environments can hold the same path. A row with no environment (the
 * sample home, a host that knows one), or one whose environment lists
 * nothing yet, is looked up in `workspaces`.
 */
function projectLookup(
  workspaces: readonly WorkspaceEntry[],
  environments: readonly EnvironmentProjects[] | undefined,
) {
  const byPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
  const own = new Map(
    (environments ?? []).map((environment) => [
      environment.environmentId,
      new Map(environment.workspaces.map((workspace) => [workspace.path, workspace])),
    ]),
  )
  return (environment: HomeEnvironmentRef | undefined, path: string) => {
    const mine = environment ? own.get(environment.environmentId) : undefined
    return mine ? mine.get(path) : byPath.get(path)
  }
}

/** One glyph per state: the web sidebar's tones, plus the ring at rest. */
export type StatusMark = SessionBusyTone | 'idle'

/** The environment a row runs on, for a home that spans more than one. */
export interface HomeEnvironmentRef {
  environmentId: string
  label: string
}

export interface HomeSession extends SidebarSessionEntry {
  workspacePath: string
  /** The environment it is on; ids are only unique within one. Absent on fixture rows. */
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
 * session settled or sent cooking while pinned goes with the rest.
 */
export function isPinnedSession(
  session: Pick<SidebarSessionEntry, 'settledAt' | 'pinnedAt' | 'cookingAt'>,
) {
  return !!session.pinnedAt && !session.settledAt && !session.cookingAt
}

/** Where the reader put a session. Settled wins: it is put away, whatever else it was. */
export type HomePlace = 'active' | 'cooking' | 'settled'

export function placeOf(session: Pick<SidebarSessionEntry, 'settledAt' | 'cookingAt'>): HomePlace {
  return session.settledAt ? 'settled' : session.cookingAt ? 'cooking' : 'active'
}

/** Active is everything the user has not settled. */
export function isActiveSession(session: Pick<SidebarSessionEntry, 'settledAt'>): boolean {
  return !session.settledAt
}

/**
 * Whether a session can be sent cooking, by the server's rule (web's
 * `canCookHere`): anything except one that already needs the reader (asking,
 * done or failed), since what would bring it back has already happened.
 */
export function canCook(mark: StatusMark): boolean {
  return mark !== 'needs' && mark !== 'question' && mark !== 'done' && mark !== 'error'
}

/** Live work cannot be settled: nothing would bring it back once it finished. */
export function canSettle(mark: StatusMark, inBackground: boolean): boolean {
  return (
    !inBackground &&
    mark !== 'working' &&
    mark !== 'background' &&
    mark !== 'needs' &&
    mark !== 'question'
  )
}

/** An ISO time or epoch ms as ms; 0 when it is missing or unreadable. */
function time(at: string | number | null | undefined): number {
  if (at === undefined || at === null) return 0
  const ms = typeof at === 'number' ? at : Date.parse(at)
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

/** A top-level session with the child sessions that ride with it. */
export interface HomeCard {
  kind: 'card'
  root: HomeRow
  /** Its children at any depth, in order, each one level deeper per generation. */
  children: HomeRow[]
}

/** The home's three places, as the web sidebar's board. */
export interface HomeBoard {
  active: HomeCard[]
  /** Sent off to work out of sight, until it needs the reader again. */
  cooking: HomeCard[]
  settled: HomeCard[]
}

/**
 * Every environment's sessions in one board, split by where the reader put
 * them, exactly as the web sidebar does (`partitionSidebarSessions`). Active
 * is newest activity first under anything pinned (most recently pinned
 * first); cooking is most recently sent first; settled most recently settled
 * first. Children ride with their parent, so a settled or cooking parent
 * takes them along; a parent that is not listed makes its child top-level,
 * and a cycle stays visible as top-level rows. Ids mean something only
 * within one environment, so a parent is looked up in its own. Display order
 * only: no session's own state changes.
 */
export function selectHomeBoard({
  sessions,
  workspaces,
  environments,
}: {
  sessions: readonly HomeSession[]
  workspaces: readonly WorkspaceEntry[]
  /** Each environment's own projects, where a row's is looked up. */
  environments?: readonly EnvironmentProjects[]
}): HomeBoard {
  const projectOf = projectLookup(workspaces, environments)
  const ordered = sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => time(b.session.updatedAt) - time(a.session.updatedAt) || a.index - b.index)
    .map(({ session }) => session)
  const ids = new Set(ordered.map((session) => homeSessionKey(session)))
  const roots: HomeSession[] = []
  const children = new Map<string, HomeSession[]>()
  for (const session of ordered) {
    const parent = session.parentExternalId
      ? homeSessionKey(session, session.parentExternalId)
      : null
    if (parent && ids.has(parent)) {
      const list = children.get(parent) ?? []
      list.push(session)
      children.set(parent, list)
    } else {
      roots.push(session)
    }
  }
  const row = (session: HomeSession, depth: number): HomeRow => ({
    kind: 'session',
    session,
    workspace: projectOf(session.environment, session.workspacePath),
    mark: statusMarkOf(session),
    depth,
  })
  const visited = new Set<string>()
  const subtree = (session: HomeSession, depth: number): HomeRow[] => {
    const key = homeSessionKey(session)
    if (visited.has(key)) return []
    visited.add(key)
    return [
      row(session, depth),
      ...(children.get(key) ?? []).flatMap((child) => subtree(child, depth + 1)),
    ]
  }
  const board: HomeBoard = { active: [], cooking: [], settled: [] }
  const place = (root: HomeSession) => {
    const [first, ...rest] = subtree(root, 0)
    if (first) board[placeOf(root)].push({ kind: 'card', root: first, children: rest })
  }
  for (const root of roots) place(root)
  // Whatever no root reaches is a cycle: its members become top-level
  // rather than vanish.
  for (const session of ordered) if (!visited.has(homeSessionKey(session))) place(session)

  // The environment breaks a tie, so two rows that tie keep their order
  // whichever environment is listed first. Stable otherwise.
  const newest = (field: 'updatedAt' | 'settledAt' | 'cookingAt') => (a: HomeCard, b: HomeCard) =>
    time(b.root.session[field]) - time(a.root.session[field]) ||
    (a.root.session.environment?.environmentId ?? '').localeCompare(
      b.root.session.environment?.environmentId ?? '',
    )
  board.active.sort(
    (a, b) =>
      time(isPinnedSession(b.root.session) ? b.root.session.pinnedAt : null) -
        time(isPinnedSession(a.root.session) ? a.root.session.pinnedAt : null) ||
      newest('updatedAt')(a, b),
  )
  board.cooking.sort(newest('cookingAt'))
  board.settled.sort(newest('settledAt'))
  return board
}

/** The draft cards, newest edit first. */
export function selectDraftRows({
  drafts,
  workspaces,
  environments,
}: {
  drafts: readonly HomeDraft[]
  workspaces: readonly WorkspaceEntry[]
  environments?: readonly EnvironmentProjects[]
}): HomeDraftRow[] {
  // A workspace's id is its path, as the shared sidebar places draft cards.
  const projectOf = projectLookup(workspaces, environments)
  return [...drafts]
    .sort((a, b) => b.editedAt - a.editedAt)
    .map((draft) => ({
      kind: 'draft',
      draft,
      workspace:
        draft.workspaceId === null ? undefined : projectOf(draft.environment, draft.workspaceId),
    }))
}

/** The two shelves under the active list. */
export type HomeShelf = 'cooking' | 'settled'

/** A one-line row of a shelf: a put-away session, or a child under it. */
export interface HomeShelfRow {
  kind: 'shelf'
  shelf: HomeShelf
  row: HomeRow
}

/** The end of a long Settled shelf: how many more there are to show. */
export interface HomeMoreRow {
  kind: 'more'
  hidden: number
}

/** A row of the home: a draft card, an active card, a shelf's row, or Show more. */
export type HomeListRow = HomeDraftRow | HomeCard | HomeShelfRow | HomeMoreRow

/** The draft cards, above everything. */
export const DRAFTS_GROUP = 'drafts'
/** The active cards: no heading, as web's. */
export const ACTIVE_GROUP = 'active'
export const COOKING_GROUP = 'cooking'
export const SETTLED_GROUP = 'settled'

/** How many settled sessions a page of the shelf shows, as web's. */
export const SETTLED_PAGE_SIZE = 25

export interface HomeShelfHead {
  shelf: HomeShelf
  /** Top-level sessions on it. */
  count: number
  open: boolean
  /** The busiest any of its sessions is, for a folded Cooking to still say so. */
  live: 'working' | 'background' | null
}

export interface HomeSection {
  key: string
  /** The heading above the rows; null for the active cards, which have none. */
  label: string | null
  /** Set for a shelf: its heading folds and unfolds it. */
  shelf?: HomeShelfHead
  rows: HomeListRow[]
}

const shelfRows = (shelf: HomeShelf, cards: readonly HomeCard[]): HomeShelfRow[] =>
  cards.flatMap((card) =>
    [card.root, ...card.children].map((row): HomeShelfRow => ({ kind: 'shelf', shelf, row })),
  )

/**
 * The home as one list, in the web sidebar's order: the draft cards under
 * "Drafts", the active cards under no heading, then Cooking and Settled as
 * shelves that fold. A folded shelf keeps its heading and lists nothing;
 * a shelf with nothing on it is not there at all. Settled shows a page at a
 * time (`settledShown`).
 */
export function selectHomeSections({
  board,
  drafts,
  open,
  settledShown = SETTLED_PAGE_SIZE,
}: {
  board: HomeBoard
  drafts: readonly HomeDraftRow[]
  open: Record<HomeShelf, boolean>
  settledShown?: number
}): HomeSection[] {
  const sections: HomeSection[] = []
  if (drafts.length) sections.push({ key: DRAFTS_GROUP, label: 'Drafts', rows: [...drafts] })
  if (board.active.length) sections.push({ key: ACTIVE_GROUP, label: null, rows: board.active })
  if (board.cooking.length) {
    const marks = board.cooking.map((card) => card.root.mark)
    sections.push({
      key: COOKING_GROUP,
      label: 'Cooking',
      shelf: {
        shelf: 'cooking',
        count: board.cooking.length,
        open: open.cooking,
        live: marks.includes('working')
          ? 'working'
          : marks.includes('background')
            ? 'background'
            : null,
      },
      rows: open.cooking ? shelfRows('cooking', board.cooking) : [],
    })
  }
  if (board.settled.length) {
    const shown = board.settled.slice(0, settledShown)
    const hidden = board.settled.length - shown.length
    sections.push({
      key: SETTLED_GROUP,
      label: 'Settled',
      shelf: { shelf: 'settled', count: board.settled.length, open: open.settled, live: null },
      rows: open.settled
        ? [...shelfRows('settled', shown), ...(hidden ? [{ kind: 'more' as const, hidden }] : [])]
        : [],
    })
  }
  return sections
}

/**
 * What the home's title says beside it: how many sessions wait on the
 * reader and how many are at work. Top-level sessions only, as the board
 * places them: a child rides in its parent's card and is not counted again,
 * a cooking session still works, and what is settled (with everything under
 * it) is put away and counts for neither.
 */
export function homeSummary(board: Pick<HomeBoard, 'active' | 'cooking'>): {
  needs: number
  working: number
} {
  let needs = 0
  let working = 0
  for (const { root } of [...board.active, ...board.cooking]) {
    if (root.mark === 'needs' || root.mark === 'question') needs += 1
    else if (root.mark === 'working' || root.mark === 'background') working += 1
  }
  return { needs, working }
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
 * when rows come, go or move (a shelf folding included), never with what a
 * row shows.
 */
export function listShapeOf<Row>(
  sections: readonly { key: string; data: readonly Row[] }[],
  keyOf: (row: Row) => string,
): string {
  return sections.map((section) => `${section.key}:${section.data.map(keyOf).join(',')}`).join('|')
}
