import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion, useReducedMotion, type MotionProps } from 'motion/react'
import {
  ArrowUUpLeftIcon,
  ArrowUpRightIcon,
  CaretDownIcon,
  CheckIcon,
  CloudSlashIcon,
  CookingPotIcon,
  FolderDashedIcon,
  FolderPlusIcon,
  GitBranchIcon,
  RobotIcon,
  GitForkIcon,
  NotePencilIcon,
  PencilSimpleLineIcon,
  PushPinIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { ProviderId } from '@agentpack/contract'
import type { SidebarRowEnvironment } from '../../providers/sidebar-provider'
import { describeUnavailableWorkspace } from '../../lib/workspace-availability'
import { formatRelativeTime, useNow } from '../../lib/relative-time'
import { noticeAnchorRef } from '../../lib/notice-anchors'
import { cn } from '../../lib/utils'
import { DRAFT_SYNC_EXPLANATION } from '../chat/DraftSyncIndicator'
import {
  phosphorIcon,
  type IconComponent,
  type IconComponentProps,
} from '../fluid/lib/icon-context'
import { SIDEBAR_MENU_GRID } from '../fluid/lib/sidebar-menu-grid'
import { spring } from '../fluid/lib/springs'
import { DropdownContent, DropdownMenu, DropdownTrigger } from '../fluid/ui/dropdown'
import { MenuItem } from '../fluid/ui/menu-item'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuActions,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '../fluid/ui/sidebar'
import { ProviderIcon } from '../providers/ProviderIcon'
import { EnvironmentPlatformIcon, nameWithoutPlatform } from '../ui/EnvironmentPlatformIcon'
import { Tooltip } from '../ui/Tooltip'
import { ProjectIcon } from './ProjectIcon'
import { SessionBusyLoader, sessionBusyTone, type SessionBusyTone } from './SessionBusyLoader'
import {
  DRAFT_CARD_ATTRIBUTE,
  DRAFT_CARD_ENVIRONMENT_ATTRIBUTE,
  flattenSidebarSessions,
  sidebarRowKey,
  type DraftDiscardOptions,
  type SidebarDraft,
  type SidebarSession,
  type SidebarWorkspace,
} from './sidebar-sessions'

const SETTLED_PREVIEW_LIMIT = 10
const SETTLED_PAGE_SIZE = 25
const SETTLED_OPEN_KEY = 'openmanager.sidebar.settled-open'
const COOKING_OPEN_KEY = 'openmanager.sidebar.cooking-open'
/** The share of the sidebar's scroll area kept below the active list for an
 *  open Settled while the cards fit above it: its default spot. */
const SETTLED_SHARE = 0.3
// Positioned so the card's status washes and dither paint beneath its text.
// Done and failed cards take their hover and selection fills from the status
// palette, so on light themes the tint deepens instead of greying over.
// A session holding an unsent reply takes a draft card's fill, so it reads as
// a draft at a glance; open, it takes the selection fill like any card.
function cardFillClass(tone: SessionBusyTone | null, isActive: boolean, unsent: boolean): string {
  if (unsent && !isActive) return draftFillClass(false)
  if (tone === 'done') {
    return isActive ? 'bg-(--basis-status-done-active)' : 'hover:bg-(--basis-status-done-hover)'
  }
  if (tone === 'error') {
    return isActive ? 'bg-(--basis-status-error-active)' : 'hover:bg-(--basis-status-error-hover)'
  }
  return isActive ? 'bg-active' : 'hover:bg-hover'
}

// A new-session draft is filled with the accent at rest and deepens on hover.
// Open, it takes the selection fill a session card takes, so the selected card
// reads the same whatever it is; its Draft label still says what it is.
function draftFillClass(isActive: boolean): string {
  return isActive ? 'bg-active' : 'bg-(--basis-draft-fill) hover:bg-(--basis-draft-hover)'
}

const cardBodyClass =
  'relative flex w-full min-w-0 flex-col gap-1 rounded-[10px] px-3 py-2.5 text-left'

// Fluid rows take an icon component that maps their stroke to a Phosphor weight.
const NewAgentIcon = phosphorIcon(NotePencilIcon)
const AddProjectIcon = phosphorIcon(FolderPlusIcon)
const ShowMoreIcon = phosphorIcon(CaretDownIcon)
const ChildSessionIcon = phosphorIcon(GitBranchIcon)
const SubagentSessionIcon = phosphorIcon(RobotIcon)
const OpenDraftIcon = phosphorIcon(ArrowUpRightIcon)
const DiscardDraftIcon = phosphorIcon(TrashIcon)

export interface SidebarBoardRow {
  session: SidebarSession
  workspace: SidebarWorkspace
  depth: number
}

/** A top-level session and the subagent transcripts filed beneath it. */
export interface SidebarBoardEntry {
  root: SidebarBoardRow
  children: SidebarBoardRow[]
}

const timeOf = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : Number.NaN
  return Number.isNaN(at) ? 0 : at
}

/** The sidebar's three places for a session. */
export interface SidebarBoard {
  active: SidebarBoardEntry[]
  /** Sent off to work out of sight, until it needs the user again. */
  cooking: SidebarBoardEntry[]
  settled: SidebarBoardEntry[]
}

/**
 * Every project's sessions in one list, split by where the user put them:
 * settled, cooking, or neither (active). Active work is newest activity first,
 * under anything pinned, which is most recently pinned first; cooking work is
 * most recently sent first; settled work is most recently settled first.
 * Child transcripts ride with their parent, so a settled or cooking parent
 * takes its subagents with it. Several environments share the one list, each
 * arranged on its own first, since a session's id and its parent's mean
 * something only within its environment.
 */
export function partitionSidebarSessions(workspaces: SidebarWorkspace[]): SidebarBoard {
  const byEnvironment = new Map<string | undefined, SidebarWorkspace[]>()
  for (const workspace of workspaces) {
    const group = byEnvironment.get(workspace.environmentId)
    if (group) group.push(workspace)
    else byEnvironment.set(workspace.environmentId, [workspace])
  }
  if (byEnvironment.size <= 1) return partitionEnvironmentSessions(workspaces)
  const parts = [...byEnvironment.values()].map(partitionEnvironmentSessions)
  // The open environment is listed first, so a tie left to the order given
  // would swap places whenever it changed.
  const newest =
    (field: 'updatedAt' | 'settledAt' | 'cookingAt') =>
    (a: SidebarBoardEntry, b: SidebarBoardEntry) =>
      timeOf(b.root.session[field]) - timeOf(a.root.session[field]) ||
      (a.root.session.environmentId ?? '').localeCompare(b.root.session.environmentId ?? '')
  return {
    // Pins first, most recently pinned on top, whichever environment they are
    // on; then the rest by activity, as within one environment.
    active: parts
      .flatMap((part) => part.active)
      .sort(
        (a, b) =>
          timeOf(b.root.session.pinnedAt) - timeOf(a.root.session.pinnedAt) ||
          newest('updatedAt')(a, b),
      ),
    cooking: parts.flatMap((part) => part.cooking).sort(newest('cookingAt')),
    settled: parts.flatMap((part) => part.settled).sort(newest('settledAt')),
  }
}

function partitionEnvironmentSessions(workspaces: SidebarWorkspace[]): SidebarBoard {
  const workspaceOf = new Map<string, SidebarWorkspace>()
  const indexed: Array<{ session: SidebarSession; index: number }> = []
  for (const workspace of workspaces) {
    for (const session of workspace.sessions) {
      workspaceOf.set(session.externalId, workspace)
      indexed.push({ session, index: indexed.length })
    }
  }
  const ordered = indexed
    .sort((a, b) => timeOf(b.session.updatedAt) - timeOf(a.session.updatedAt) || a.index - b.index)
    .map(({ session }) => session)

  const active: SidebarBoardEntry[] = []
  const cooking: SidebarBoardEntry[] = []
  const settled: SidebarBoardEntry[] = []
  let current: SidebarBoardEntry | undefined
  for (const { session, depth } of flattenSidebarSessions(ordered)) {
    const row = { session, workspace: workspaceOf.get(session.externalId)!, depth }
    if (depth === 0 || !current) {
      current = { root: row, children: [] }
      // Settled wins: a settled session is put away, whatever else it was.
      ;(session.settledAt ? settled : session.cookingAt ? cooking : active).push(current)
    } else {
      current.children.push(row)
    }
  }
  settled.sort((a, b) => timeOf(b.root.session.settledAt) - timeOf(a.root.session.settledAt))
  cooking.sort((a, b) => timeOf(b.root.session.cookingAt) - timeOf(a.root.session.cookingAt))
  // Stable, so everything unpinned (time 0) keeps its order from above.
  active.sort((a, b) => timeOf(b.root.session.pinnedAt) - timeOf(a.root.session.pinnedAt))
  return { active, cooking, settled }
}

const NO_DRAFTS: SidebarDraft[] = []
const NO_DRAFT_ROWS: SidebarDraftRow[] = []

/** A draft's card: the draft, and its project when that is listed. */
export interface SidebarDraftRow {
  kind: 'draft'
  draft: SidebarDraft
  /** Absent once the project was removed (or is not listed). */
  workspace?: SidebarWorkspace
}

/** One card in the list: a draft, or an active session with its subagents. */
type ActiveItem = SidebarDraftRow | { kind: 'session'; entry: SidebarBoardEntry }

/** Each draft with its project, in the order given. */
export function placeSidebarDrafts(
  drafts: SidebarDraft[],
  workspaces: SidebarWorkspace[],
): SidebarDraftRow[] {
  if (drafts.length === 0) return NO_DRAFT_ROWS
  const byPath = new Map(
    workspaces.map((workspace) => [
      sidebarRowKey(workspace.environmentId, workspace.path),
      workspace,
    ]),
  )
  return drafts.map((draft) => {
    const workspace =
      draft.workspaceId === null
        ? undefined
        : byPath.get(sidebarRowKey(draft.environmentId, draft.workspaceId))
    return workspace ? { kind: 'draft', draft, workspace } : { kind: 'draft', draft }
  })
}

function readSettledOpen(): boolean {
  try {
    // Open until the user folds it: the shelf is where settling lands.
    return globalThis.localStorage?.getItem(SETTLED_OPEN_KEY) !== 'false'
  } catch {
    return true
  }
}

/**
 * The active list's floor: everything above Settled's default spot. The list
 * fills at least that much of the scroll area, so Settled rests there while
 * the cards fit and is pushed down, the whole sidebar scrolling, once they
 * don't. Open, Settled keeps a share of the area; folded, it is just its
 * label, resting on the bottom edge. Read off the scroller (the scroll area's
 * viewport, or the content itself in the mobile sheet) and Settled's own
 * height, so a folding shelf glides down as it closes.
 *
 * Takes the elements, not refs: both groups mount only once projects load,
 * after the first render, and the measurement has to start over when they do.
 */
function useActiveFloor(
  active: HTMLElement | null,
  shelves: HTMLElement | null,
  settledOpen: boolean,
): number | undefined {
  const [floor, setFloor] = useState<number>()
  useLayoutEffect(() => {
    const scroller =
      active?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ??
      active?.closest<HTMLElement>('[data-sidebar="content"]')
    if (!scroller || typeof ResizeObserver === 'undefined') return
    // Cooking, when there is any, sits above Settled and takes its room from
    // the active list's floor, not from Settled's share.
    const measure = () => {
      const settled = shelves?.lastElementChild as HTMLElement | null | undefined
      const cooking = shelves && settled ? shelves.offsetHeight - settled.offsetHeight : 0
      setFloor(
        settledOpen || !shelves
          ? Math.max(0, Math.round(scroller.clientHeight * (1 - SETTLED_SHARE)) - cooking)
          : Math.max(0, scroller.clientHeight - shelves.offsetHeight),
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    if (shelves) observer.observe(shelves)
    return () => observer.disconnect()
  }, [active, shelves, settledOpen])
  return floor
}

// A card is the largest thing that moves here, so the room it takes or gives
// up moves on the slow tier, without the tier's bounce: a height that
// overshoots opens a gap under the card.
const ROOM = { ...spring.slow, bounce: 0 }

/**
 * How a row joins and leaves a list: it grows from nothing and fades in, or
 * fades and then folds away, and the rows around it close the gap as it
 * goes. Leaving, the row fades a tier quicker than its room closes, so it is
 * gone before the space is and nothing is seen squashing. Rows present when
 * the list first fills in appear as they are, so opening the app animates
 * nothing.
 *
 * Only height and opacity move. The rows around one close the gap in normal
 * flow as its height changes, so they need no layout animation of their own;
 * one would make Motion measure every row on each render of the list, right
 * as a settle starts. A row that changes places (newer activity) moves at once.
 */
function useRowMotion(armed: boolean): MotionProps {
  const reduceMotion = useReducedMotion() ?? false
  return useMemo(() => {
    const still = { duration: 0 }
    return {
      initial: armed ? { height: 0, opacity: 0 } : false,
      animate: {
        height: 'auto',
        opacity: 1,
        transition: reduceMotion ? still : { height: ROOM, opacity: spring.slow },
      },
      exit: {
        height: 0,
        opacity: 0,
        transition: reduceMotion
          ? still
          : { height: spring.slow.exit, opacity: spring.moderate.exit },
      },
    }
  }, [armed, reduceMotion])
}

/**
 * How a card that changes places moves: a sent draft's card going down to
 * the top of the sessions past the drafts still waiting, and those drafts
 * closing up. Nothing else moves this way: a card only takes a layout measurement
 * when its place changes (`layoutDependency`), not on every render of the
 * list, and a session that changes places with newer activity still moves at
 * once.
 */
function useCardLayoutTransition(): MotionProps['transition'] {
  const reduceMotion = useReducedMotion() ?? false
  return useMemo(() => ({ layout: reduceMotion ? { duration: 0 } : ROOM }), [reduceMotion])
}

/** A card's key among the cards of every environment. */
function entryKey(entry: SidebarBoardEntry): string {
  const { environmentId, externalId } = entry.root.session
  return sidebarRowKey(environmentId, externalId)
}

/** A sent draft whose session took its card over. */
interface Handoff {
  /** The session each handed-over card belongs to (`entryKey`), and the draft it was. */
  from: ReadonlyMap<string, string>
  /** What each handed-over card read as a draft: its title until the session is named. By `entryKey`. */
  previews: ReadonlyMap<string, string>
}

const NO_HANDOFF: Handoff = { from: new Map(), previews: new Map() }

/**
 * Notices a draft's card becoming its session's: a key that was a draft in
 * the last render and is an active session now. The two lists never share a
 * key in one render, since a draft whose session is listed is left out of
 * the drafts in the same update. Read during render, so the frame that
 * moves the card already knows.
 */
function useHandoff(drafts: SidebarDraft[], active: SidebarBoardEntry[]): Handoff {
  // Keyed on the drafts as the host hands them over, which change only when a
  // card does: a session update must not set state here and render the whole
  // view a second time.
  const [seen, setSeen] = useState<{ drafts: SidebarDraft[]; handoff: Handoff }>({
    drafts,
    handoff: NO_HANDOFF,
  })
  if (seen.drafts === drafts) return seen.handoff
  const before = new Map(
    seen.drafts.map((draft) => [sidebarRowKey(draft.environmentId, draft.sessionId), draft]),
  )
  const from = new Map<string, string>()
  // A sent card reads as its draft until its session is named, through any
  // later change to the drafts or another hand-off.
  const previews = new Map<string, string>()
  for (const entry of active) {
    const id = entryKey(entry)
    const preview = seen.handoff.previews.get(id)
    if (preview !== undefined && !entry.root.session.title) previews.set(id, preview)
  }
  if (before.size > 0) {
    for (const entry of active) {
      const id = entryKey(entry)
      const draft = before.get(id)
      if (draft === undefined) continue
      from.set(id, draft.draftId)
      if (draft.preview) previews.set(id, draft.preview)
    }
  }
  let handoff = seen.handoff
  if (from.size > 0) {
    handoff = { from, previews }
  } else if (seen.handoff.from.size > 0 || seen.handoff.previews.size !== previews.size) {
    handoff = { from: NO_HANDOFF.from, previews }
  }
  setSeen({ drafts, handoff })
  return handoff
}

/**
 * The surface behind an element: the first ancestor that paints a background.
 * A card moving past another takes it as its own for the move, so the card on
 * top hides the one beneath rather than both showing through each other's
 * translucent fills; at rest it is the same colour as what is behind.
 */
function surfaceBehind(element: HTMLElement): string {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor
    if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color
  }
  return ''
}

/** A session card that was a selected draft stays selected through the hand-off. */
function handedSelection(
  entry: SidebarBoardEntry,
  handoff: Handoff,
  activeDraftId: string | null,
  activeEnvironmentId: string | undefined,
): string | null {
  const { environmentId, externalId } = entry.root.session
  return activeDraftId !== null &&
    environmentId === activeEnvironmentId &&
    handoff.from.get(entryKey(entry)) === activeDraftId
    ? externalId
    : null
}

/** The id a card shows selected: the session on screen if it is this card or one of its subagents. */
function entrySelection(
  entry: SidebarBoardEntry,
  activeSessionId: string | null,
  activeEnvironmentId: string | undefined,
): string | null {
  if (activeSessionId === null) return null
  if (entry.root.session.environmentId !== activeEnvironmentId) return null
  if (entry.root.session.externalId === activeSessionId) return activeSessionId
  return entry.children.some((child) => child.session.externalId === activeSessionId)
    ? activeSessionId
    : null
}

function writeSettledOpen(open: boolean) {
  try {
    globalThis.localStorage?.setItem(SETTLED_OPEN_KEY, String(open))
  } catch {
    /* best effort */
  }
}

function readCookingOpen(): boolean {
  try {
    // Open until the user folds it: a session sent cooking is seen landing.
    return globalThis.localStorage?.getItem(COOKING_OPEN_KEY) !== 'false'
  } catch {
    return true
  }
}

function writeCookingOpen(open: boolean) {
  try {
    globalThis.localStorage?.setItem(COOKING_OPEN_KEY, String(open))
  } catch {
    /* best effort */
  }
}

const STATUS_COPY: Record<SessionBusyTone, string> = {
  working: 'Working',
  background: 'Background',
  question: 'Has a question',
  needs: 'Needs input',
  done: 'Done',
  error: 'Failed',
}

const STATUS_TEXT: Record<SessionBusyTone, string> = {
  working: 'text-[color:var(--basis-status-working)]',
  background: 'text-[color:var(--basis-status-background)]',
  question: 'text-[color:var(--basis-status-question)]',
  needs: 'text-[color:var(--basis-status-needs)]',
  done: 'text-[color:var(--basis-status-done)]',
  error: 'text-[color:var(--basis-status-error)]',
}

/** A one-off change worth marking, keyed so each one replays its effect. */
type StatusMoment = { tone: SessionBusyTone; key: number }

/**
 * Changes are events, not only states: when a session finishes, asks, or
 * fails while the sidebar is watching, mark it once. What the card already
 * showed when it first rendered is left alone, so opening the app is quiet.
 *
 * While its environment is offline the card shows no status, and what it last
 * had is kept: coming back with the same status is no news, a new one still is.
 */
function useStatusMoment(tone: SessionBusyTone | null, offline = false): StatusMoment | null {
  const previous = useRef(tone)
  const [moment, setMoment] = useState<StatusMoment | null>(null)
  useEffect(() => {
    if (offline) {
      setMoment(null)
      return
    }
    if (previous.current === tone) return
    previous.current = tone
    // Work going on, in a turn or behind one, is not news.
    setMoment(
      tone && tone !== 'working' && tone !== 'background' ? { tone, key: Date.now() } : null,
    )
  }, [offline, tone])
  return moment
}

/** Live work says what it is doing; anything at rest says how long ago. */
function StatusOrAge({
  tone,
  iso,
  now,
  moment,
  backgroundTaskCount,
  backgroundTaskNames,
}: {
  tone: SessionBusyTone | null
  iso?: string
  now: number
  moment?: StatusMoment | null
  backgroundTaskCount?: number
  /** What is running in the background, one per line, for the hover. */
  backgroundTaskNames?: string
}) {
  if (tone) {
    // Background work says how much of it there is, and names it on hover.
    const count = tone === 'background' ? backgroundTaskCount : undefined
    return (
      <span
        className={cn('flex items-center gap-1.5', STATUS_TEXT[tone])}
        title={tone === 'background' ? backgroundTaskNames : undefined}
      >
        <SessionBusyLoader
          tone={tone}
          className={moment?.tone === tone ? 'session-busy-ring--moment' : undefined}
          burst={moment?.tone === 'done' && tone === 'done' ? moment.key : undefined}
        />
        {STATUS_COPY[tone]}
        {count ? <span className="tabular-nums opacity-70">· {count}</span> : null}
      </span>
    )
  }
  const age = formatRelativeTime(iso, now)
  return age ? <span className="tabular-nums">{age}</span> : null
}

/** The tap on the shoulder when a session starts waiting on the user. */
const NUDGE: Keyframe[] = [
  { transform: 'translateX(0)' },
  { transform: 'translateX(-3px)', offset: 0.2 },
  { transform: 'translateX(3px)', offset: 0.45 },
  { transform: 'translateX(-1.5px)', offset: 0.7 },
  { transform: 'translateX(0)' },
]

function CardAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: (event: ReactMouseEvent) => void
  children: ReactNode
}) {
  return (
    <Tooltip content={label} side="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-80 hover:bg-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring [&_svg]:size-3.5 [&_svg]:stroke-[1.75]"
      >
        {children}
      </button>
    </Tooltip>
  )
}

export interface WorkspaceSidebarViewProps {
  environmentLabel?: string
  /**
   * Set when more than one environment is saved: each card then shows the
   * name of the environment it is on, which is also what it can do there.
   * Rows are told apart by environment from then on.
   */
  rowEnvironments?: Readonly<Record<string, SidebarRowEnvironment>>
  /** Some environment's rows may yet arrive, and are no news when they do. */
  rowsFilling?: boolean
  workspaces: SidebarWorkspace[]
  /** The environment the open session and `activeWorkspacePath` belong to. */
  activeEnvironmentId?: string
  activeWorkspacePath: string | null
  activeSessionId: string | null
  /** A new agent where the open environment has nowhere to start one is told whose project it is. */
  onCreateSession: (workspacePath: string, environmentId?: string) => void
  /** What a row does is told the row's environment, last. */
  onSelectSession: (
    workspacePath: string,
    externalId: string,
    providerId: ProviderId,
    environmentId?: string,
  ) => void
  /** Rename and delete stay on the contract, but the rows do not offer them
   *  for now: settling is the one thing a row does besides opening. */
  onRenameSession?: (
    workspacePath: string,
    externalId: string,
    title: string | null,
    environmentId?: string,
  ) => void
  /** Absent when the host cannot keep a settled session; the action is hidden.
   *  The host shows the move at once (the environment client does), and a
   *  refusal moves the row back through the same data. */
  onSettleSession?: (
    workspacePath: string,
    externalId: string,
    settled: boolean,
    environmentId?: string,
  ) => void | Promise<unknown>
  /** Absent when the host cannot keep a pin; a pinned card keeps its mark, not
   *  the button. Moves the same way a settle does. */
  onPinSession?: (
    workspacePath: string,
    externalId: string,
    pinned: boolean,
    environmentId?: string,
  ) => void | Promise<unknown>
  /** Absent when the host cannot keep a cooking session; the action is hidden.
   *  Moves the same way a settle does. */
  onCookSession?: (
    workspacePath: string,
    externalId: string,
    cooking: boolean,
    environmentId?: string,
  ) => void | Promise<unknown>
  onDeleteSession?: (
    workspacePath: string,
    externalId: string,
    providerId: ProviderId,
    environmentId?: string,
  ) => void
  /**
   * Unsent new-session drafts, shown as cards in a Drafts section above the active
   * sessions, in the order given (newest edit first). Hosts without draft pages leave
   * them out.
   */
  drafts?: SidebarDraft[]
  /** The draft on screen; its card shows selected. */
  activeDraftId?: string | null
  onOpenDraft?: (draftId: string, environmentId?: string) => void
  /** Absent when drafts cannot be discarded here; the card offers no discard. */
  onDiscardDraft?: (draftId: string, options?: DraftDiscardOptions) => void
  onAddWorkspace: () => void
  /** There is nowhere to add a project just now. */
  addWorkspaceDisabled?: boolean
  /** The name a provider goes by; the raw id when the host has no catalog. */
  providerLabel?: (providerId: ProviderId) => string
  /** Above the header: a frameless window's drag strip, for one. */
  titlebar?: ReactNode
  /** Rows under the session list, anchored to the sidebar's outer edge. */
  footer?: ReactNode
}

/**
 * The session sidebar on Fluid Functionalism's sidebar. Projects are not
 * groups here: every session is either active (a card with its project,
 * branch, provider and age) or settled, put away in a folded list below
 * until it is needed again. Must render inside a Fluid `SidebarProvider`.
 */
export function WorkspaceSidebarView({
  environmentLabel,
  rowEnvironments,
  rowsFilling = false,
  workspaces,
  activeEnvironmentId,
  activeWorkspacePath,
  activeSessionId,
  onCreateSession,
  onSelectSession: requestSelect,
  onSettleSession: requestSettle,
  onPinSession: requestPin,
  onCookSession: requestCook,
  drafts = NO_DRAFTS,
  activeDraftId = null,
  onOpenDraft: requestOpenDraft,
  onDiscardDraft: requestDiscardDraft,
  onAddWorkspace,
  addWorkspaceDisabled = false,
  providerLabel,
  titlebar,
  footer,
}: WorkspaceSidebarViewProps) {
  // Rows are memoized, so they get one callback of each kind for good.
  const selectRef = useRef(requestSelect)
  const settleRef = useRef(requestSettle)
  const pinRef = useRef(requestPin)
  const cookRef = useRef(requestCook)
  const openDraftRef = useRef(requestOpenDraft)
  const discardDraftRef = useRef(requestDiscardDraft)
  const createSessionRef = useRef(onCreateSession)
  const addWorkspaceRef = useRef(onAddWorkspace)
  useLayoutEffect(() => {
    selectRef.current = requestSelect
    settleRef.current = requestSettle
    pinRef.current = requestPin
    cookRef.current = requestCook
    openDraftRef.current = requestOpenDraft
    discardDraftRef.current = requestDiscardDraft
    createSessionRef.current = onCreateSession
    addWorkspaceRef.current = onAddWorkspace
  })
  // The header's two actions, stable too, so a session update leaves it be.
  const onCreateSessionStable = useCallback(
    (workspacePath: string, environmentId?: string) =>
      createSessionRef.current(workspacePath, environmentId),
    [],
  )
  const onAddWorkspaceStable = useCallback(() => addWorkspaceRef.current(), [])
  const onSelectSession = useCallback<WorkspaceSidebarViewProps['onSelectSession']>(
    (...args) => selectRef.current(...args),
    [],
  )
  const onOpenDraft = useCallback(
    (draftId: string, environmentId?: string) => openDraftRef.current?.(draftId, environmentId),
    [],
  )
  const canDiscardDraft = requestDiscardDraft !== undefined
  const onDiscardDraft = useMemo(
    () =>
      canDiscardDraft
        ? (draftId: string, options?: DraftDiscardOptions) =>
            discardDraftRef.current?.(draftId, options)
        : undefined,
    [canDiscardDraft],
  )
  const canSettle = requestSettle !== undefined
  const onSettleSession = useMemo<WorkspaceSidebarViewProps['onSettleSession']>(
    () =>
      canSettle
        ? (...args) => {
            // A refusal already moved the row back; there is nothing to add.
            void Promise.resolve(settleRef.current?.(...args)).catch(() => undefined)
          }
        : undefined,
    [canSettle],
  )
  const canPin = requestPin !== undefined
  const onPinSession = useMemo<WorkspaceSidebarViewProps['onPinSession']>(
    () =>
      canPin
        ? (...args) => {
            // A refusal already moved the card back; there is nothing to add.
            void Promise.resolve(pinRef.current?.(...args)).catch(() => undefined)
          }
        : undefined,
    [canPin],
  )
  const canCook = requestCook !== undefined
  const onCookSession = useMemo<WorkspaceSidebarViewProps['onCookSession']>(
    () =>
      canCook
        ? (...args) => {
            // A refusal already moved the card back; there is nothing to add.
            void Promise.resolve(cookRef.current?.(...args)).catch(() => undefined)
          }
        : undefined,
    [canCook],
  )
  // A new agent starts in the open environment. One with nowhere to start it
  // hands over to the first reachable environment that has, in that project:
  // the page that opens says which, and offers the others.
  const startable = workspaces.filter(
    (workspace) => workspace.environmentId === activeEnvironmentId && !workspace.missing,
  )
  const elsewhere =
    startable.length > 0
      ? undefined
      : workspaces.find(
          (workspace) =>
            !workspace.missing &&
            workspace.environmentId !== undefined &&
            rowEnvironments?.[workspace.environmentId]?.reachable === true,
        )
  // "No project" is where it starts only from inside it, or with no project to pick.
  const newThreadTarget = startable.some((workspace) => workspace.path === activeWorkspacePath)
    ? activeWorkspacePath
    : ((startable.find((workspace) => !workspace.scratch) ?? startable[0])?.path ??
      elsewhere?.path ??
      null)

  const { active, cooking, settled } = useMemo(
    () => partitionSidebarSessions(workspaces),
    [workspaces],
  )
  const draftRows = useMemo(() => placeSidebarDrafts(drafts, workspaces), [drafts, workspaces])
  const now = useNow()
  const [settledOpen, setSettledOpen] = useState(readSettledOpen)
  const [settledVisible, setSettledVisible] = useState(SETTLED_PREVIEW_LIMIT)
  const [activeGroup, setActiveGroup] = useState<HTMLDivElement | null>(null)
  const [cookingOpen, setCookingOpen] = useState(readCookingOpen)
  // Cooking and Settled rest together below the active list: the floor makes
  // room for both.
  const [shelves, setShelves] = useState<HTMLDivElement | null>(null)
  const activeFloor = useActiveFloor(activeGroup, shelves, settledOpen)
  // Armed once the first sessions have rendered, so the initial load lands
  // still and only later settles, unsettles and new threads move.
  const [armed, setArmed] = useState(false)
  const hasSessions = active.length + cooking.length + settled.length + draftRows.length > 0
  useEffect(() => {
    if (hasSessions && !rowsFilling) setArmed(true)
  }, [hasSessions, rowsFilling])
  const rowMotion = useRowMotion(armed)
  const onSettledOpenChange = useCallback((open: boolean) => {
    setSettledOpen(open)
    writeSettledOpen(open)
    if (!open) setSettledVisible(SETTLED_PREVIEW_LIMIT)
  }, [])
  const onCookingOpenChange = useCallback((open: boolean) => {
    setCookingOpen(open)
    writeCookingOpen(open)
  }, [])
  const onShowMoreSettled = useCallback(
    () => setSettledVisible((count) => count + SETTLED_PAGE_SIZE),
    [],
  )
  // The shelf hears about the selection only when it is one of its rows.
  const activeRow =
    activeSessionId === null ? null : sidebarRowKey(activeEnvironmentId, activeSessionId)
  const settledSelection =
    activeRow !== null &&
    settled
      .slice(0, settledVisible)
      .some((entry) => entrySelection(entry, activeSessionId, activeEnvironmentId) !== null)
      ? activeRow
      : null
  const cookingSelection =
    activeRow !== null &&
    cooking.some((entry) => entrySelection(entry, activeSessionId, activeEnvironmentId) !== null)
      ? activeRow
      : null
  // Selection is handed to each row as its own (`selected`), not as the id
  // on screen: opening another session re-renders the two rows it moves
  // between, not the whole list.
  const shared = {
    environmentLabel,
    rowEnvironments,
    now,
    onSelectSession,
    onSettleSession,
    onPinSession,
    onCookSession,
    onOpenDraft,
    onDiscardDraft,
    providerLabel,
    rowMotion,
  }
  const cardLayout = useCardLayoutTransition()
  const handoff = useHandoff(drafts, active)

  // Rows at Tend's 15px body size.
  return (
    <Sidebar className="text-[15px]">
      {titlebar}
      <MemoSidebarActions
        newThreadTarget={newThreadTarget}
        newThreadEnvironmentId={elsewhere?.environmentId}
        onCreateSession={onCreateSessionStable}
        onAddWorkspace={onAddWorkspaceStable}
        addWorkspaceDisabled={addWorkspaceDisabled}
      />
      <SidebarContent>
        {workspaces.length === 0 ||
        (drafts.length === 0 &&
          workspaces.every((workspace) => workspace.scratch && workspace.sessions.length === 0)) ? (
          <p className="px-4 py-5 text-[13px] text-muted-foreground">No projects yet</p>
        ) : (
          // The drafts and the active sessions share the floor, so Settled
          // keeps its spot whether or not drafts are waiting above the cards.
          <div ref={setActiveGroup} className="flex flex-col" style={{ minHeight: activeFloor }}>
            {/* Drafts, newest edit first, then the active sessions: one list.
                The drafts are labelled, the sessions are not: they start
                straight below the drafts, or at the top. A draft's card is
                keyed by the session it will become, so its send hands the same
                row to the session's card, which slides down to the top of the
                sessions rather than folding away here and growing in there. */}
            <SidebarGroup>
              <CardList>
                {/* The Drafts label comes and goes with the first and last
                    draft. When the last one is sent, it and the gap below the
                    drafts fold away together, in the flow: the card they held
                    rises into the label's place and the sessions follow it,
                    every row moving as one. */}
                {draftRows.length > 0 ? (
                  <SectionLabel key="drafts-label" rowMotion={rowMotion}>
                    Drafts
                  </SectionLabel>
                ) : null}
                {draftRows.map((row, index) => (
                  <MemoActiveCard
                    key={sidebarRowKey(row.draft.environmentId, row.draft.sessionId)}
                    item={row}
                    place={index}
                    layoutTransition={cardLayout}
                    untitled={undefined}
                    selected={
                      row.draft.draftId === activeDraftId &&
                      row.draft.environmentId === activeEnvironmentId
                        ? row.draft.draftId
                        : null
                    }
                    {...shared}
                  />
                ))}
                {draftRows.length > 0 && active.length > 0 ? (
                  <SectionGap key="drafts-gap" rowMotion={rowMotion} />
                ) : null}
                {active.map((entry) => (
                  <MemoActiveCard
                    key={entryKey(entry)}
                    item={{ kind: 'session', entry }}
                    place={entry.root.session.pinnedAt ? 'pinned' : 'session'}
                    layoutTransition={cardLayout}
                    untitled={handoff.previews.get(entryKey(entry))}
                    selected={
                      entrySelection(entry, activeSessionId, activeEnvironmentId) ??
                      handedSelection(entry, handoff, activeDraftId, activeEnvironmentId)
                    }
                    {...shared}
                  />
                ))}
              </CardList>
              {/* Only when the list is empty: under drafts it would say nothing. */}
              <EmptyNote show={active.length + draftRows.length === 0} rowMotion={rowMotion}>
                {settled.length + cooking.length > 0 ? 'All caught up.' : 'No sessions yet.'}
              </EmptyNote>
            </SidebarGroup>
          </div>
        )}

        {/* Settled follows the active list in the same scroll. It rests at its
            default spot (the active list's floor), on the bottom edge when
            folded, and moves only when the cards outgrow that, riding down as
            they grow in. */}
        {workspaces.length > 0 || settled.length > 0 || cooking.length > 0 ? (
          <div ref={setShelves} className="flex flex-col">
            {/* Cooking comes and goes with its first and last session, above
                Settled: work still going, out of sight until it needs you. */}
            <AnimatePresence initial={false}>
              {cooking.length > 0 ? (
                <motion.div key="cooking" className="overflow-hidden" {...rowMotion}>
                  <MemoCookingShelf
                    cooking={cooking}
                    open={cookingOpen}
                    onOpenChange={onCookingOpenChange}
                    selected={cookingSelection}
                    {...shared}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
            <MemoSettledShelf
              settled={settled}
              open={settledOpen}
              onOpenChange={onSettledOpenChange}
              visible={settledVisible}
              onShowMore={onShowMoreSettled}
              selected={settledSelection}
              {...shared}
            />
          </div>
        ) : null}
      </SidebarContent>

      {footer ? (
        <SidebarFooter ref={noticeAnchorRef('sidebar-foot')}>{footer}</SidebarFooter>
      ) : null}
    </Sidebar>
  )
}

/**
 * The Settled shelf. Its own memoized piece: an update to an active session
 * re-renders the session list, and a shelf whose rows are all as they were
 * (and whose selection, page and fold are too) has nothing to show for it.
 */
function SettledShelf({
  settled,
  open,
  onOpenChange,
  visible,
  onShowMore,
  selected,
  ...shared
}: Omit<RowHandlers, 'selected'> & {
  settled: SidebarBoardEntry[]
  open: boolean
  onOpenChange: (open: boolean) => void
  visible: number
  onShowMore: () => void
  /** The open session's `sidebarRowKey` when it is one of the shelf's rows, else null. */
  selected: string | null
}) {
  return (
    <SidebarGroup collapsible className="pb-1" open={open} onOpenChange={onOpenChange}>
      {/* The toggle is a button, which inherits the row size; the spans
          carry the label size themselves. */}
      <SidebarGroupLabel>
        <span className="text-[12px]">Settled</span>
        <span className="text-[12px] tabular-nums text-faint">{settled.length}</span>
      </SidebarGroupLabel>
      <EmptyNote show={settled.length === 0} rowMotion={shared.rowMotion}>
        Settle a finished thread and it waits here.
      </EmptyNote>
      {/* Mounted while empty too, so the last row still folds away. */}
      <SidebarMenu>
        <AnimatePresence initial={false} presenceAffectsLayout={false}>
          {settled
            .slice(0, visible)
            .flatMap((entry) => [entry.root, ...entry.children])
            .map((row) => (
              <MemoShelfRow
                key={sidebarRowKey(row.session.environmentId, row.session.externalId)}
                shelf="settled"
                row={row}
                selected={
                  sidebarRowKey(row.session.environmentId, row.session.externalId) === selected
                    ? row.session.externalId
                    : null
                }
                {...shared}
              />
            ))}
        </AnimatePresence>
        {settled.length > visible ? (
          <SidebarMenuItem>
            <SidebarMenuButton
              icon={ShowMoreIcon}
              className="text-muted-foreground"
              onClick={onShowMore}
            >
              Show more
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </SidebarGroup>
  )
}

type SettledShelfProps = Parameters<typeof SettledShelf>[0]

/** Same entries, row for row, by what a settled row shows. */
function sameEntries(a: SidebarBoardEntry[], b: SidebarBoardEntry[]): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every(
        (entry, index) =>
          sameRow(entry.root, b[index]!.root) &&
          entry.children.length === b[index]!.children.length &&
          entry.children.every((child, at) => sameRow(child, b[index]!.children[at]!)),
      ))
  )
}

const MemoSettledShelf = memo(
  SettledShelf,
  (a: SettledShelfProps, b: SettledShelfProps) =>
    a.open === b.open &&
    a.onOpenChange === b.onOpenChange &&
    a.visible === b.visible &&
    a.onShowMore === b.onShowMore &&
    sameHandlers({ ...a, selected: a.selected }, { ...b, selected: b.selected }) &&
    sameEntries(a.settled, b.settled),
)

/**
 * The Cooking group: sessions the user sent off to work out of sight. Each
 * comes back to the active list by itself once it finishes, asks or fails, so
 * what is here is working, or idle and put aside. Folded, its label still
 * shows that something is working. Memoized as the Settled shelf is.
 */
function CookingShelf({
  cooking,
  open,
  onOpenChange,
  selected,
  ...shared
}: Omit<RowHandlers, 'selected'> & {
  cooking: SidebarBoardEntry[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The open session's `sidebarRowKey` when it is one of the group's rows, else null. */
  selected: string | null
}) {
  // What the folded label says is going on: the busiest any row is.
  const live = cooking.some((entry) => liveTone(entry.root.session) === 'working')
    ? 'working'
    : cooking.some((entry) => liveTone(entry.root.session) === 'background')
      ? 'background'
      : null
  return (
    <SidebarGroup collapsible className="pb-1" open={open} onOpenChange={onOpenChange}>
      <SidebarGroupLabel>
        <span className="text-[12px]">Cooking</span>
        <span className="text-[12px] tabular-nums text-faint">{cooking.length}</span>
        {live && !open ? (
          <span className="flex items-center" title={STATUS_COPY[live]}>
            <SessionBusyLoader tone={live} />
          </span>
        ) : null}
      </SidebarGroupLabel>
      <SidebarMenu>
        <AnimatePresence initial={false} presenceAffectsLayout={false}>
          {cooking
            .flatMap((entry) => [entry.root, ...entry.children])
            .map((row) => (
              <MemoShelfRow
                key={sidebarRowKey(row.session.environmentId, row.session.externalId)}
                shelf="cooking"
                row={row}
                selected={
                  sidebarRowKey(row.session.environmentId, row.session.externalId) === selected
                    ? row.session.externalId
                    : null
                }
                {...shared}
              />
            ))}
        </AnimatePresence>
      </SidebarMenu>
    </SidebarGroup>
  )
}

/** A session's running tone, if it is running; what a folded Cooking label shows. */
function liveTone(session: SidebarSession): 'working' | 'background' | null {
  const tone = sessionBusyTone(session.status, session)
  return tone === 'working' || tone === 'background' ? tone : null
}

type CookingShelfProps = Parameters<typeof CookingShelf>[0]

const MemoCookingShelf = memo(
  CookingShelf,
  (a: CookingShelfProps, b: CookingShelfProps) =>
    a.open === b.open &&
    a.onOpenChange === b.onOpenChange &&
    sameHandlers({ ...a, selected: a.selected }, { ...b, selected: b.selected }) &&
    sameEntries(a.cooking, b.cooking),
)

/**
 * New agent and Add project. Its own memoized piece: server updates re-render
 * the session list, and these two buttons (and their tooltips) have no part
 * in that. Only where a new agent would start changes them.
 */
function SidebarActions({
  newThreadTarget,
  newThreadEnvironmentId,
  onCreateSession,
  onAddWorkspace,
  addWorkspaceDisabled,
}: {
  newThreadTarget: string | null
  /** Set when that project is another environment's. */
  newThreadEnvironmentId?: string
  onCreateSession: (workspacePath: string, environmentId?: string) => void
  onAddWorkspace: () => void
  addWorkspaceDisabled: boolean
}) {
  return (
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            icon={NewAgentIcon}
            disabled={!newThreadTarget}
            onClick={() => {
              if (newThreadTarget) onCreateSession(newThreadTarget, newThreadEnvironmentId)
            }}
          >
            New agent
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            icon={AddProjectIcon}
            disabled={addWorkspaceDisabled}
            onClick={onAddWorkspace}
          >
            Add project
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
  )
}

const MemoSidebarActions = memo(SidebarActions)

/**
 * A list of cards. Divs, not ul/li: the app's unlayered list rules outrank
 * utilities. Cards space themselves (padding, not gap) so a leaving card folds
 * its spacing away with it. The list stays mounted when it empties, so the
 * last card still folds away. Focusable from script alone: where focus lands
 * when the card it was on is gone and no other card is near.
 *
 * A card coming or going does not re-render the others: nothing here measures
 * its neighbours for it (`presenceAffectsLayout`). They close the gap in normal
 * flow as its height changes.
 */
function CardList({ children }: { children: ReactNode }) {
  return (
    <div
      role="list"
      aria-label="Sessions"
      tabIndex={-1}
      className="relative flex flex-col outline-none"
    >
      <AnimatePresence initial={false} presenceAffectsLayout={false}>
        {children}
      </AnimatePresence>
    </div>
  )
}

/**
 * A section's label as a row of the card list: it comes and goes as a card
 * does. Not a list item; a heading, so the sections can be found by one.
 */
function SectionLabel({ rowMotion, children }: { rowMotion: MotionProps; children: ReactNode }) {
  return (
    <motion.div role="presentation" className="overflow-hidden" {...rowMotion}>
      <SidebarGroupLabel role="heading" aria-level={2}>
        {children}
      </SidebarGroupLabel>
    </motion.div>
  )
}

/** The room between the last draft and the first session. */
const SECTION_GAP = 16

/**
 * The gap that sets the drafts off from the sessions below them, a row of the
 * card list: it opens and closes as a row comes and goes, so when the last
 * draft is sent it folds away in step with the Drafts label.
 */
function SectionGap({ rowMotion }: { rowMotion: MotionProps }) {
  return (
    <motion.div role="presentation" className="overflow-hidden" {...rowMotion}>
      <div style={{ height: SECTION_GAP }} />
    </motion.div>
  )
}

/** What an empty list says, coming and going the way a row does. */
function EmptyNote({
  show,
  rowMotion,
  children,
}: {
  show: boolean
  rowMotion: MotionProps
  children: ReactNode
}) {
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div key="empty" className="overflow-hidden" {...rowMotion}>
          <p className="px-2 pb-2 pt-1 text-[13px] leading-5 text-faint">{children}</p>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

// Every change to any session hands the sidebar a fresh copy of every row, so
// the rows compare what they show rather than which object it came in.
function sameFields(a: object, b: object): boolean {
  if (a === b) return true
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) =>
    Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}

function sameWorkspace(a: SidebarWorkspace, b: SidebarWorkspace): boolean {
  return (
    a === b ||
    (a.path === b.path &&
      a.name === b.name &&
      a.missing === b.missing &&
      a.availability === b.availability &&
      a.git?.branch === b.git?.branch &&
      a.git?.worktree === b.git?.worktree &&
      a.scratch === b.scratch)
  )
}

function sameRow(a: SidebarBoardRow, b: SidebarBoardRow): boolean {
  return (
    a.depth === b.depth &&
    sameFields(a.session, b.session) &&
    sameWorkspace(a.workspace, b.workspace)
  )
}

function sameHandlers(a: RowHandlers, b: RowHandlers): boolean {
  return (
    a.selected === b.selected &&
    a.environmentLabel === b.environmentLabel &&
    a.rowEnvironments === b.rowEnvironments &&
    a.now === b.now &&
    a.onSelectSession === b.onSelectSession &&
    a.onSettleSession === b.onSettleSession &&
    a.onPinSession === b.onPinSession &&
    a.onCookSession === b.onCookSession &&
    a.onOpenDraft === b.onOpenDraft &&
    a.onDiscardDraft === b.onDiscardDraft &&
    a.providerLabel === b.providerLabel &&
    a.rowMotion === b.rowMotion
  )
}

interface RowHandlers {
  /**
   * The id this row shows selected: its session's, a subagent's under it, or
   * its draft's. Null when the selection is elsewhere, so moving it touches
   * only the rows it leaves and reaches.
   */
  selected: string | null
  environmentLabel?: string
  rowEnvironments?: WorkspaceSidebarViewProps['rowEnvironments']
  now: number
  onSelectSession: WorkspaceSidebarViewProps['onSelectSession']
  onSettleSession?: WorkspaceSidebarViewProps['onSettleSession']
  onPinSession?: WorkspaceSidebarViewProps['onPinSession']
  onCookSession?: WorkspaceSidebarViewProps['onCookSession']
  onOpenDraft?: (draftId: string, environmentId?: string) => void
  onDiscardDraft?: (draftId: string, options?: DraftDiscardOptions) => void
  providerLabel?: WorkspaceSidebarViewProps['providerLabel']
  rowMotion: MotionProps
}

interface ActiveCardProps extends RowHandlers {
  item: ActiveItem
  /**
   * Where the card is, as far as moving goes: a draft's index among the
   * drafts, or whether a session is `pinned`. The card is measured for a move
   * only when this changes, so a draft handed to its session (or closing up
   * after one) moves, as does a card being pinned or unpinned, and nothing
   * else measures.
   */
  place: number | 'session' | 'pinned'
  /** How the card moves when its place changes (`useCardLayoutTransition`). */
  layoutTransition: MotionProps['transition']
  /** What a session card reads while its session has no title yet: the draft's first line, after a hand-off. */
  untitled: string | undefined
}

/** A card in the list: a new-session draft, or an active session. */
function ActiveCard({ item, place, layoutTransition, untitled, ...handlers }: ActiveCardProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  return (
    // The clip lets the card fold to nothing on its way out; the padding
    // inside it is the space between cards, so it folds away too.
    <motion.div
      ref={rowRef}
      role="listitem"
      layout="position"
      layoutDependency={place}
      transition={layoutTransition}
      className="overflow-hidden"
      // Moving past another card, it is lifted: opaque (`surfaceBehind`), on
      // top, with the floating shadow, so the card it covers for a moment
      // reads as passed over rather than gone.
      onLayoutAnimationStart={() => {
        const row = rowRef.current
        if (!row) return
        row.style.backgroundColor = surfaceBehind(row)
        row.style.position = 'relative'
        row.style.zIndex = '1'
        row.style.borderRadius = '10px'
        row.style.boxShadow = 'var(--shadow-float-rest)'
      }}
      onLayoutAnimationComplete={() => {
        const row = rowRef.current
        if (!row) return
        row.style.backgroundColor = ''
        row.style.position = ''
        row.style.zIndex = ''
        row.style.borderRadius = ''
        row.style.boxShadow = ''
      }}
      {...handlers.rowMotion}
    >
      {item.kind === 'draft' ? (
        <DraftCardBody row={item} {...handlers} />
      ) : (
        <SessionCardBody
          entry={item.entry}
          untitled={untitled}
          pinned={place === 'pinned'}
          {...handlers}
        />
      )}
    </motion.div>
  )
}

function sameItem(a: ActiveItem, b: ActiveItem): boolean {
  if (a.kind === 'draft' || b.kind === 'draft') {
    if (a.kind !== 'draft' || b.kind !== 'draft') return false
    return (
      sameFields(a.draft, b.draft) &&
      (a.workspace === b.workspace ||
        (!!a.workspace && !!b.workspace && sameWorkspace(a.workspace, b.workspace)))
    )
  }
  return (
    sameRow(a.entry.root, b.entry.root) &&
    a.entry.children.length === b.entry.children.length &&
    a.entry.children.every((child, index) => sameRow(child, b.entry.children[index]!))
  )
}

const MemoActiveCard = memo(
  ActiveCard,
  (a, b) =>
    a.place === b.place &&
    a.untitled === b.untitled &&
    sameHandlers(a, b) &&
    sameItem(a.item, b.item),
)

/**
 * Unsent text in a session's composer: a pen in the draft accent beside its
 * provider. On an active card the card also takes the draft fill; a settled
 * row has the mark alone.
 */
function UnsentMark() {
  return (
    <span
      className="flex shrink-0 items-center text-[color:var(--basis-draft)]"
      title="Unsent draft"
    >
      <PencilSimpleLineIcon className="h-3 w-3" aria-hidden />
      <span className="sr-only">Has an unsent draft</span>
    </span>
  )
}

/** Said for an offline environment's row: what's on it is from the last time it was seen. */
const offlineExplanation = (name: string) => `${name} is offline. This is what was last seen.`

/** The word beside an offline environment's name. It stays when the name truncates. */
function OfflineWord() {
  return <span className="shrink-0">· offline</span>
}

/**
 * The environment a card is on, when there is more than one to tell apart:
 * set quietly at the foot of the card, opposite what the card is about. Screen
 * readers get it with the card's title.
 */
function EnvironmentName({ environment }: { environment: SidebarRowEnvironment }) {
  const { name, platform, distro, offline, reachable } = environment
  return (
    <span
      aria-hidden
      className={cn(
        'ml-auto flex min-w-0 shrink-0 items-center gap-1 pl-1',
        offline ? 'max-w-[65%]' : 'max-w-[55%]',
      )}
      title={offline ? offlineExplanation(name) : name}
    >
      <EnvironmentPlatformIcon
        platform={platform}
        distro={distro}
        muted={offline === true || reachable !== true}
        aria-hidden
      />
      <span className="min-w-0 truncate">{nameWithoutPlatform(name, platform)}</span>
      {offline ? <OfflineWord /> : null}
    </span>
  )
}

/** A row's own environment, and the name to read out for it. */
function rowEnvironmentOf(
  environmentId: string | undefined,
  rowEnvironments: RowHandlers['rowEnvironments'],
  environmentLabel: string | undefined,
) {
  const environment = environmentId ? rowEnvironments?.[environmentId] : undefined
  return {
    environment,
    spokenName: environment?.offline
      ? `${environment.name}, offline`
      : (environment?.name ?? environmentLabel),
    // What the row's environment says, or the host's one answer for every row.
    iconLookup: rowEnvironments ? (environment?.iconLookup ?? null) : undefined,
  }
}

function SessionCardBody({
  entry,
  untitled,
  pinned,
  selected,
  environmentLabel,
  rowEnvironments,
  now,
  onSelectSession,
  onSettleSession,
  onPinSession,
  onCookSession,
  providerLabel,
}: RowHandlers & { entry: SidebarBoardEntry; untitled?: string; pinned: boolean }) {
  const { session, workspace } = entry.root
  const providerId = session.providerId
  const isActive = session.externalId === selected
  const unavailable = workspace.missing
    ? describeUnavailableWorkspace(workspace.availability)
    : null
  const git = workspace.git
  const { environmentId } = session
  const { environment, spokenName, iconLookup } = rowEnvironmentOf(
    environmentId,
    rowEnvironments,
    environmentLabel,
  )
  const settleHere = !rowEnvironments || environment?.canSettle ? onSettleSession : undefined
  const pinHere = !rowEnvironments || environment?.canPin ? onPinSession : undefined
  const cookHere = !rowEnvironments || environment?.canCook ? onCookSession : undefined
  const select = () =>
    onSelectSession(workspace.path, session.externalId, providerId, environmentId)
  const providerName = providerLabel?.(providerId) ?? providerId
  // What an offline environment's session was last doing isn't what it's doing
  // now: its card rests and says how old it is.
  const offline = environment?.offline === true
  const lastSeen = sessionBusyTone(session.status, session)
  const tone = offline ? null : lastSeen
  const moment = useStatusMoment(lastSeen, offline)
  // Live work cannot be settled. Anything can go cooking except a session
  // that already needs the user (asking, done, or failed): what would bring
  // it back has already happened.
  const canSettleHere =
    Boolean(settleHere) &&
    tone !== 'working' &&
    tone !== 'background' &&
    tone !== 'needs' &&
    tone !== 'question'
  const canCookHere =
    Boolean(cookHere) &&
    tone !== 'needs' &&
    tone !== 'question' &&
    tone !== 'done' &&
    tone !== 'error'
  // The status makes room for the actions on hover, when there are any.
  const hasActions = canSettleHere || canCookHere
  const reduceMotion = useReducedMotion() ?? false
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if ((moment?.tone !== 'needs' && moment?.tone !== 'question') || reduceMotion) return
    const card = cardRef.current
    // Web Animations is everywhere the app runs, but not in every test DOM.
    if (typeof card?.animate === 'function') {
      card.animate(NUDGE, { duration: 500, easing: 'ease-in-out' })
    }
  }, [moment, reduceMotion])

  const projectLine = (
    <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-muted-foreground">
      <ProjectIcon
        workspacePath={workspace.path}
        scratch={workspace.scratch}
        className="opacity-80"
        iconLookup={iconLookup}
      />
      <span className={cn('truncate', workspace.missing && 'line-through decoration-faint')}>
        {workspace.name}
      </span>
      {unavailable ? (
        <span
          className="shrink-0 rounded-sm px-1 text-[10px] leading-none text-faint"
          title={unavailable.reason}
        >
          {unavailable.badge}
        </span>
      ) : null}
      {/* Gives way to the hover actions, which sit over this corner. Keyed to
          keyboard focus, not focus-within: a clicked card keeps focus, and
          the selected card should keep showing its status. */}
      <span
        className={cn(
          'ml-auto flex shrink-0 items-center pl-2 transition-opacity duration-80',
          hasActions &&
            'group-has-[:focus-visible]/card:opacity-0 group-hover/card:opacity-0 pointer-coarse:opacity-0',
        )}
      >
        <StatusOrAge
          tone={tone}
          iso={session.updatedAt}
          now={now}
          moment={moment}
          backgroundTaskCount={session.backgroundTaskCount}
          backgroundTaskNames={session.backgroundTaskNames}
        />
      </span>
    </span>
  )
  // Not on the session on screen: the host leaves it out there, so the card
  // does not flicker as its composer empties and fills.
  const unsent = Boolean(session.hasUnsentDraft) && !isActive
  const metaLine = (
    // The padding keeps a long branch name out from under the pin.
    <span className="flex min-w-0 items-center gap-2 pr-5 text-[12px] leading-4 text-faint">
      {/* The mark alone; its name is for hover and assistive tech. */}
      <span className="flex shrink-0 items-center" title={providerName}>
        <ProviderIcon providerId={providerId} className="h-3 w-3 opacity-80" />
        <span className="sr-only">{providerName}</span>
      </span>
      {unsent ? <UnsentMark /> : null}
      {git ? (
        <span
          className="flex min-w-0 items-center gap-1"
          title={git.worktree ? 'Worktree' : undefined}
        >
          {git.worktree ? (
            <GitForkIcon className="h-3 w-3 shrink-0" aria-label="Worktree" />
          ) : (
            <GitBranchIcon className="h-3 w-3 shrink-0" aria-hidden />
          )}
          <span className="truncate">{git.branch ?? 'detached'}</span>
        </span>
      ) : null}
      {environment ? <EnvironmentName environment={environment} /> : null}
    </span>
  )

  return (
    <div className="group/card relative pb-1">
      <div
        ref={cardRef}
        className={cn(
          // Selection is a fill, never an outline, on every scheme.
          'relative rounded-[10px] transition-colors duration-100',
          cardFillClass(tone, isActive, unsent),
        )}
      >
        {tone === 'needs' || tone === 'question' ? (
          <span
            aria-hidden="true"
            className={cn('session-row-dither', `session-row-dither--${tone}`)}
          />
        ) : null}
        {tone === 'done' || tone === 'error' ? (
          <span
            aria-hidden="true"
            className={cn('session-card-wash', `session-card-wash--${tone}`)}
          />
        ) : null}
        {moment?.tone === 'done' || moment?.tone === 'error' ? (
          <span
            key={moment.key}
            aria-hidden="true"
            className={cn('session-card-flash', `session-card-flash--${moment.tone}`)}
          />
        ) : null}
        <button
          type="button"
          aria-current={isActive ? 'page' : undefined}
          onClick={select}
          className={cn(
            cardBodyClass,
            'outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
            session.workspaceUnavailable && 'opacity-70',
          )}
        >
          {projectLine}
          <span className="truncate text-[14px] leading-5 text-foreground">
            {session.title || untitled || 'New session'}
            {spokenName ? <span className="sr-only"> on {spokenName}</span> : null}
          </span>
          {metaLine}
        </button>
        {entry.children.length > 0 ? (
          <div role="list" className="mb-2 ml-5 mr-2 flex flex-col">
            {entry.children.map((child) => (
              <ChildRow
                key={child.session.externalId}
                row={child}
                selected={selected}
                now={now}
                onSelectSession={onSelectSession}
                offline={environment?.offline}
              />
            ))}
          </div>
        ) : null}
      </div>
      {/* Live work cannot be settled: the environment refuses it, since
            nothing would bring the card back once the turn finished. */}
      {hasActions ? (
        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-80 group-has-[:focus-visible]/card:opacity-100 group-hover/card:opacity-100 pointer-coarse:opacity-100 [:root[data-draft-discard-guard]_&]:opacity-0">
          {canCookHere && cookHere ? (
            <CardAction
              label="Send to Cooking"
              onClick={(event) => {
                // As with Settle below: the card that slid up under a discard
                // ignores the second click. A keypress still sends it.
                if (event.detail > 0 && onDiscardGuardedSpot(event)) return
                cookHere(workspace.path, session.externalId, true, environmentId)
              }}
            >
              <CookingPotIcon />
            </CardAction>
          ) : null}
          {canSettleHere && settleHere ? (
            <CardAction
              label="Settle"
              onClick={(event) => {
                // The second half of a double click that discarded the draft
                // above: this card slid up under it. A keypress still settles.
                if (event.detail > 0 && onDiscardGuardedSpot(event)) return
                settleHere(workspace.path, session.externalId, true, environmentId)
              }}
            >
              <CheckIcon />
            </CardAction>
          ) : null}
        </div>
      ) : null}
      {/* On the meta line, where any card has room: the top corner is the
          status of live work, which pins too. A pinned card always shows it. */}
      <div
        className={cn(
          'absolute right-1.5 top-[50px] flex items-center transition-opacity duration-80',
          !pinned &&
            'opacity-0 group-has-[:focus-visible]/card:opacity-100 group-hover/card:opacity-100 pointer-coarse:opacity-100',
        )}
      >
        {pinHere ? (
          <CardAction
            label={pinned ? 'Unpin' : 'Pin to top'}
            onClick={(event) => {
              // The card leaves on the first click, so a double click's second
              // would land on whichever card took its place.
              if (event.detail <= 1) {
                pinHere(workspace.path, session.externalId, !pinned, environmentId)
              }
            }}
          >
            <PushPinIcon weight={pinned ? 'fill' : 'regular'} />
          </CardAction>
        ) : pinned ? (
          <span className="flex h-6 w-6 items-center justify-center text-muted-foreground">
            <PushPinIcon weight="fill" className="size-3.5" aria-hidden />
            <span className="sr-only">Pinned</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** What a draft with no text says in place of its first line. */
const imagesLabel = (count: number) => (count === 1 ? '1 image' : `${count} images`)

/** Where a draft card's menu opens: at the pointer, or the card's corner from the keyboard. */
interface MenuAnchor {
  x: number
  y: number
}

/**
 * After a discard by pointer the next card slides up under it, ✕ (or a
 * session's Settle) and all, so a double click would act on that one too.
 * Every card's action is hidden, and a pointer click on one at the same spot
 * ignored, until the pointer moves away (or a moment passes, so a touch
 * screen is not left waiting for a move that never comes). Keypresses are
 * never held back. The root carries the mark, for the cards' CSS.
 */
const DISCARD_GUARD_ATTRIBUTE = 'data-draft-discard-guard'
const DISCARD_GUARD_SLOP_PX = 4
const DISCARD_GUARD_MS = 1_500
let discardGuard: { x: number; y: number; release: () => void } | null = null

const near = (point: { x: number; y: number }, x: number, y: number) =>
  Math.abs(point.x - x) <= DISCARD_GUARD_SLOP_PX && Math.abs(point.y - y) <= DISCARD_GUARD_SLOP_PX

/** Whether a pointer at this spot is where the last discard was, still guarded. */
function onDiscardGuardedSpot(at: { clientX: number; clientY: number }): boolean {
  return discardGuard !== null && near(discardGuard, at.clientX, at.clientY)
}

/** Whether a pointer discard at this spot may go ahead; if so, guards the spot. */
function armDiscardGuard(at: { clientX: number; clientY: number }): boolean {
  if (onDiscardGuardedSpot(at)) return false
  discardGuard?.release()
  if (typeof document === 'undefined') return true
  const root = document.documentElement
  const onMove = (event: PointerEvent) => {
    if (guard && !near(guard, event.clientX, event.clientY)) guard.release()
  }
  const timer = setTimeout(() => guard.release(), DISCARD_GUARD_MS)
  const guard = {
    x: at.clientX,
    y: at.clientY,
    release: () => {
      clearTimeout(timer)
      window.removeEventListener('pointermove', onMove)
      if (discardGuard === guard) {
        discardGuard = null
        root.removeAttribute(DISCARD_GUARD_ATTRIBUTE)
      }
    },
  }
  discardGuard = guard
  root.setAttribute(DISCARD_GUARD_ATTRIBUTE, '')
  window.addEventListener('pointermove', onMove)
  return true
}

/** The card beside this one (below it, else above), or the list once it is the last. */
function neighbourCard(card: HTMLElement | null): HTMLElement | null {
  const row = card?.closest('[role="listitem"]')
  // Section labels are rows of the list too; they are passed over.
  const sibling = (direction: 'nextElementSibling' | 'previousElementSibling') => {
    let at = row?.[direction]
    while (at && at.getAttribute('role') !== 'listitem') at = at[direction]
    return at
  }
  const next = sibling('nextElementSibling') ?? sibling('previousElementSibling')
  return (
    next?.querySelector<HTMLElement>('button') ?? row?.closest<HTMLElement>('[role="list"]') ?? null
  )
}

/**
 * An unsent new-session draft: a card like a session's (project, first line,
 * provider and branch), filled with the draft tint and labelled Draft where a
 * session shows its status. Opening it goes to the draft's page; ✕ and the
 * card's menu (right click, or the menu key) discard it, with an undo.
 */
function DraftCardBody({
  row,
  selected,
  environmentLabel,
  rowEnvironments,
  onOpenDraft,
  onDiscardDraft,
  providerLabel,
}: RowHandlers & { row: SidebarDraftRow }) {
  const { draft, workspace } = row
  const { environmentId } = draft
  const { environment, spokenName, iconLookup } = rowEnvironmentOf(
    environmentId,
    rowEnvironments,
    environmentLabel,
  )
  const isActive = draft.draftId === selected
  const providerName = providerLabel?.(draft.providerId) ?? draft.providerId
  const unavailable = workspace?.missing
    ? describeUnavailableWorkspace(workspace.availability)
    : null
  const git = workspace?.git
  const preview = draft.preview || imagesLabel(draft.imageCount)
  const unsynced = draft.unsynced ? DRAFT_SYNC_EXPLANATION[draft.unsynced] : undefined
  const open = () => onOpenDraft?.(draft.draftId, environmentId)
  // A draft being sent is the send's: nothing here discards it. A click
  // with no pointer behind it (detail 0) came from the keyboard: the undo
  // notice takes focus, and hands it to the next card over when it goes.
  const discard =
    onDiscardDraft && !draft.sending
      ? (event: { detail: number; clientX: number; clientY: number }) => {
          const fromKeyboard = event.detail === 0
          if (!fromKeyboard && !armDiscardGuard(event)) return
          onDiscardDraft(draft.draftId, {
            fromKeyboard,
            returnFocus: fromKeyboard ? neighbourCard(cardRef.current) : null,
            ...(environmentId ? { environmentId } : {}),
          })
        }
      : undefined

  const cardRef = useRef<HTMLButtonElement>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [menuAt, setMenuAt] = useState<MenuAnchor | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const openMenu = (anchor: MenuAnchor) => {
    setMenuAt(anchor)
    setMenuOpen(true)
  }

  const projectLine = (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-muted-foreground',
        // Touch has no hover: ✕ stays out, beside the label rather than over it.
        discard && 'pointer-coarse:pr-7',
      )}
    >
      {workspace ? (
        <>
          <ProjectIcon
            workspacePath={workspace.path}
            scratch={workspace.scratch}
            className="opacity-80"
            iconLookup={iconLookup}
          />
          <span className={cn('truncate', workspace.missing && 'line-through decoration-faint')}>
            {workspace.name}
          </span>
          {unavailable ? (
            <span
              className="shrink-0 rounded-sm px-1 text-[10px] leading-none text-faint"
              title={unavailable.reason}
            >
              {unavailable.badge}
            </span>
          ) : null}
        </>
      ) : (
        // Its project was removed: the draft is kept, and its page lets
        // another project take it.
        <span
          className="flex min-w-0 items-center gap-1.5 text-faint"
          title="Its project was removed. Open the draft to pick another."
        >
          <FolderDashedIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">No project</span>
        </span>
      )}
      {/* Where a session shows its status. Gives way to ✕ on hover, as the
          status gives way to Settle; on touch the two sit side by side. */}
      <span
        className={cn(
          'ml-auto flex shrink-0 items-center gap-1 pl-2 text-[color:var(--basis-draft)] transition-opacity duration-80',
          discard &&
            'pointer-fine:group-has-[:focus-visible]/card:opacity-0 pointer-fine:group-hover/card:opacity-0',
        )}
      >
        <PencilSimpleLineIcon className="h-3 w-3" aria-hidden />
        Draft
      </span>
    </span>
  )
  const metaLine = (
    <span className="flex min-w-0 items-center gap-2 text-[12px] leading-4 text-faint">
      <span className="flex shrink-0 items-center" title={providerName}>
        <ProviderIcon providerId={draft.providerId} className="h-3 w-3 opacity-80" />
        <span className="sr-only">{providerName}</span>
      </span>
      {git ? (
        <span
          className="flex min-w-0 items-center gap-1"
          title={git.worktree ? 'Worktree' : undefined}
        >
          {git.worktree ? (
            <GitForkIcon className="h-3 w-3 shrink-0" aria-label="Worktree" />
          ) : (
            <GitBranchIcon className="h-3 w-3 shrink-0" aria-hidden />
          )}
          <span className="truncate">{git.branch ?? 'detached'}</span>
        </span>
      ) : null}
      {environment ? <EnvironmentName environment={environment} /> : null}
      {/* The composer's "Not synced", made quiet: the mark, and its reason on hover. */}
      {unsynced ? (
        <Tooltip content={unsynced}>
          <span className={cn('flex shrink-0 items-center gap-1', !environment && 'ml-auto')}>
            <CloudSlashIcon className="h-3 w-3" aria-hidden />
            <span className="sr-only">Not synced. {unsynced}</span>
          </span>
        </Tooltip>
      ) : null}
    </span>
  )

  return (
    <div
      className="group/card relative pb-1"
      onContextMenu={
        discard
          ? (event) => {
              event.preventDefault()
              const box = event.currentTarget.getBoundingClientRect()
              openMenu({ x: event.clientX - box.left, y: event.clientY - box.top })
            }
          : undefined
      }
    >
      <div
        className={cn(
          'relative rounded-[10px] transition-colors duration-100',
          draftFillClass(isActive),
        )}
      >
        <button
          ref={cardRef}
          type="button"
          {...{ [DRAFT_CARD_ATTRIBUTE]: draft.draftId }}
          {...(environmentId ? { [DRAFT_CARD_ENVIRONMENT_ATTRIBUTE]: environmentId } : {})}
          aria-current={isActive ? 'page' : undefined}
          onClick={open}
          onKeyDown={(event) => {
            if (!discard) return
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault()
              openMenu({ x: event.currentTarget.offsetWidth - 8, y: 8 })
            }
          }}
          className={cn(
            cardBodyClass,
            'outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
          )}
        >
          {projectLine}
          <span className="truncate text-[14px] leading-5 text-foreground">
            {preview}
            {spokenName ? <span className="sr-only"> on {spokenName}</span> : null}
          </span>
          {metaLine}
        </button>
      </div>
      {discard ? (
        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-80 group-has-[:focus-visible]/card:opacity-100 group-hover/card:opacity-100 pointer-coarse:opacity-100 [:root[data-draft-discard-guard]_&]:opacity-0">
          <CardAction label="Discard draft" onClick={discard}>
            <XIcon />
          </CardAction>
        </div>
      ) : null}
      {/* Mounted on first use, then kept, so closing plays its exit. */}
      {discard && menuAt ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownTrigger
            ref={anchorRef}
            render={
              <span
                aria-hidden
                tabIndex={-1}
                className="pointer-events-none absolute size-px"
                style={{ left: menuAt.x, top: menuAt.y }}
              />
            }
          />
          <DropdownContent
            className={cn('w-52', SIDEBAR_MENU_GRID)}
            sideOffset={2}
            // The anchor is a hidden point, no place to leave focus: back to
            // the card, unless the user has put focus somewhere else.
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              const active = document.activeElement
              if (!active || active === document.body || active === anchorRef.current) {
                cardRef.current?.focus()
              }
            }}
          >
            <MenuItem index={0} icon={OpenDraftIcon} label="Open draft" onSelect={open} />
            <MenuItem index={1} icon={DiscardDraftIcon} label="Discard draft" onClick={discard} />
          </DropdownContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}

/** A subagent transcript, kept under the card of the session that started it. */
function ChildRow({
  row,
  selected,
  now,
  onSelectSession,
  offline,
}: Pick<RowHandlers, 'selected' | 'now' | 'onSelectSession'> & {
  row: SidebarBoardRow
  /** Its environment is offline, so this is its last known state. */
  offline?: boolean
}) {
  const { session, workspace, depth } = row
  const providerId = session.providerId
  const isActive = session.externalId === selected
  const tone = offline ? null : sessionBusyTone(session.status, session)
  return (
    // Buttons inherit their font, so the size is set on the wrapper.
    <div role="listitem" className="text-[13px]">
      <button
        type="button"
        aria-current={isActive ? 'page' : undefined}
        onClick={() =>
          onSelectSession(workspace.path, session.externalId, providerId, session.environmentId)
        }
        style={depth > 1 ? { paddingLeft: 8 + Math.min(depth - 1, 3) * 12 } : undefined}
        className={cn(
          'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left outline-none transition-colors duration-80',
          'focus-visible:ring-1 focus-visible:ring-focus-ring',
          isActive
            ? 'bg-active text-foreground'
            : 'text-muted-foreground hover:bg-hover hover:text-foreground',
        )}
      >
        {session.subagent ? (
          <RobotIcon className="h-3 w-3 shrink-0 opacity-70" aria-label="Subagent" />
        ) : (
          <GitBranchIcon className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
        )}
        <span className="truncate">{session.title || 'Subagent'}</span>
        <span className="ml-auto shrink-0 pl-2 text-[11px] text-faint">
          {tone ? <SessionBusyLoader tone={tone} /> : formatRelativeTime(session.updatedAt, now)}
        </span>
      </button>
    </div>
  )
}

// A menu row that can grow in and fold away (see useRowMotion).
const MotionMenuItem = motion.create(SidebarMenuItem)

// Project marks need the project bound in: one component per project and
// lookup, so a row keeps the same icon from render to render.
const CONTEXT_ICONS = {}
const NO_ICONS = {}
const projectIcons = new WeakMap<object, Map<string, IconComponent>>()
function projectIcon(
  workspacePath: string,
  iconLookup: ReturnType<typeof rowEnvironmentOf>['iconLookup'],
): IconComponent {
  // Undefined reads the host's lookup from context; null means there is none.
  const owner = iconLookup === undefined ? CONTEXT_ICONS : (iconLookup ?? NO_ICONS)
  let icons = projectIcons.get(owner)
  if (!icons) {
    icons = new Map()
    projectIcons.set(owner, icons)
  }
  let icon = icons.get(workspacePath)
  if (!icon) {
    const ProjectRowIcon = ({ size = 16, className }: IconComponentProps) => (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', className)}
        style={{ width: size, height: size }}
      >
        <ProjectIcon workspacePath={workspacePath} iconLookup={iconLookup} className="opacity-80" />
      </span>
    )
    icon = ProjectRowIcon
    icons.set(workspacePath, icon)
  }
  return icon
}

/**
 * A one-line row in Cooking or Settled: the project it is in, what it was,
 * and either what it is doing or when it was last touched (put away, for a
 * settled row). On hover it offers to bring the session back to the active
 * list. Subagents sit indented under their parent and come back with it.
 */
function ShelfRow({
  shelf,
  row,
  selected,
  environmentLabel,
  rowEnvironments,
  now,
  onSelectSession,
  onSettleSession,
  onCookSession,
  rowMotion,
}: RowHandlers & { shelf: 'cooking' | 'settled'; row: SidebarBoardRow }) {
  const { session, workspace, depth } = row
  const providerId = session.providerId
  const { environmentId } = session
  const { environment, spokenName, iconLookup } = rowEnvironmentOf(
    environmentId,
    rowEnvironments,
    environmentLabel,
  )
  const settleHere = !rowEnvironments || environment?.canSettle ? onSettleSession : undefined
  const cookHere = !rowEnvironments || environment?.canCook ? onCookSession : undefined
  const bringBack =
    depth > 0
      ? undefined
      : shelf === 'settled'
        ? settleHere && (() => settleHere(workspace.path, session.externalId, false, environmentId))
        : cookHere && (() => cookHere(workspace.path, session.externalId, false, environmentId))
  const tone = environment?.offline ? null : sessionBusyTone(session.status, session)
  const isActive = session.externalId === selected
  // A put-away session can still hold a reply the user started: the active cards' mark.
  const unsent = Boolean(session.hasUnsentDraft) && !isActive
  const putAwayAt = shelf === 'settled' ? session.settledAt : null
  return (
    <MotionMenuItem className="overflow-hidden" {...rowMotion}>
      <SidebarMenuButton
        icon={
          depth > 0
            ? session.subagent
              ? SubagentSessionIcon
              : ChildSessionIcon
            : projectIcon(workspace.path, iconLookup)
        }
        isActive={isActive}
        className="text-muted-foreground"
        style={depth > 0 ? { paddingLeft: 8 + Math.min(depth, 4) * 12 } : undefined}
        onClick={() =>
          onSelectSession(workspace.path, session.externalId, providerId, environmentId)
        }
      >
        <span className="truncate">{session.title || 'New session'}</span>
        {unsent ? <UnsentMark /> : null}
        <span className="sr-only">
          {' '}
          in {workspace.name}
          {spokenName ? ` on ${spokenName}` : ''}
        </span>
      </SidebarMenuButton>
      <SidebarMenuBadge>
        {tone ? (
          <SessionBusyLoader tone={tone} />
        ) : (
          formatRelativeTime(putAwayAt ?? session.updatedAt, now)
        )}
      </SidebarMenuBadge>
      {bringBack ? (
        <SidebarMenuActions showOnHover>
          <SidebarMenuAction
            aria-label={shelf === 'settled' ? 'Move back to active' : 'Bring back'}
            onClick={bringBack}
          >
            <ArrowUUpLeftIcon />
          </SidebarMenuAction>
        </SidebarMenuActions>
      ) : null}
    </MotionMenuItem>
  )
}

const MemoShelfRow = memo(
  ShelfRow,
  (a, b) => a.shelf === b.shelf && sameHandlers(a, b) && sameRow(a.row, b.row),
)
