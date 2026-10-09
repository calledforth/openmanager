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
  type Ref,
} from 'react'
import { AnimatePresence, motion, useReducedMotion, type MotionProps } from 'motion/react'
import {
  ArrowUUpLeftIcon,
  ArrowUpRightIcon,
  CaretDownIcon,
  CheckIcon,
  CloudSlashIcon,
  FolderDashedIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GitForkIcon,
  NotePencilIcon,
  PencilSimpleLineIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { ProviderId } from '@agentpack/contract'
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
import { Tooltip } from '../ui/Tooltip'
import { ProjectIcon } from './ProjectIcon'
import { SessionBusyLoader, sessionBusyTone, type SessionBusyTone } from './SessionBusyLoader'
import {
  DRAFT_CARD_ATTRIBUTE,
  flattenSidebarSessions,
  type DraftDiscardOptions,
  type SidebarDraft,
  type SidebarSession,
  type SidebarWorkspace,
} from './sidebar-sessions'

const SETTLED_PREVIEW_LIMIT = 10
const SETTLED_PAGE_SIZE = 25
const SETTLED_OPEN_KEY = 'openmanager.sidebar.settled-open'
/** The share of the sidebar's scroll area kept below the active list for an
 *  open Settled while the cards fit above it: its default spot. */
const SETTLED_SHARE = 0.3
const DEFAULT_PROVIDER_ID: ProviderId = 'opencode'
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
const OpenDraftIcon = phosphorIcon(ArrowUpRightIcon)
const DiscardDraftIcon = phosphorIcon(TrashIcon)

// Provider marks need their id bound in.
const providerIcons = new Map<ProviderId, IconComponent>()
function providerIcon(providerId: ProviderId): IconComponent {
  let icon = providerIcons.get(providerId)
  if (!icon) {
    const ProviderRowIcon = ({ size = 16, className }: IconComponentProps) => (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', className)}
        style={{ width: size, height: size }}
      >
        <ProviderIcon providerId={providerId} className="h-3.5 w-3.5 opacity-70" />
      </span>
    )
    icon = ProviderRowIcon
    providerIcons.set(providerId, icon)
  }
  return icon
}

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

/**
 * Every project's sessions in one list, split by whether the user settled
 * them. Active work is newest activity first; settled work is most recently
 * settled first. Child transcripts ride with their parent, so a settled
 * parent takes its subagents with it.
 */
export function partitionSidebarSessions(workspaces: SidebarWorkspace[]): {
  active: SidebarBoardEntry[]
  settled: SidebarBoardEntry[]
} {
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
  const settled: SidebarBoardEntry[] = []
  let current: SidebarBoardEntry | undefined
  for (const { session, depth } of flattenSidebarSessions(ordered)) {
    const row = { session, workspace: workspaceOf.get(session.externalId)!, depth }
    if (depth === 0 || !current) {
      current = { root: row, children: [] }
      ;(session.settledAt ? settled : active).push(current)
    } else {
      current.children.push(row)
    }
  }
  settled.sort((a, b) => timeOf(b.root.session.settledAt) - timeOf(a.root.session.settledAt))
  return { active, settled }
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

/** One card in Drafts or Active: a draft, or a session with its subagents. */
type ActiveItem = SidebarDraftRow | { kind: 'session'; entry: SidebarBoardEntry }

/** Each draft with its project, in the order given. */
export function placeSidebarDrafts(
  drafts: SidebarDraft[],
  workspaces: SidebarWorkspace[],
): SidebarDraftRow[] {
  if (drafts.length === 0) return NO_DRAFT_ROWS
  const byPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
  return drafts.map((draft) => {
    const workspace = draft.workspaceId === null ? undefined : byPath.get(draft.workspaceId)
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
  settled: HTMLElement | null,
  settledOpen: boolean,
): number | undefined {
  const [floor, setFloor] = useState<number>()
  useLayoutEffect(() => {
    const scroller =
      active?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ??
      active?.closest<HTMLElement>('[data-sidebar="content"]')
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const measure = () =>
      setFloor(
        settledOpen || !settled
          ? Math.round(scroller.clientHeight * (1 - SETTLED_SHARE))
          : Math.max(0, scroller.clientHeight - settled.offsetHeight),
      )
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    if (settled) observer.observe(settled)
    return () => observer.disconnect()
  }, [active, settled, settledOpen])
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
 * the top of Active past the drafts still waiting, and those drafts closing
 * up. Nothing else moves this way: a card only takes a layout measurement
 * when its place changes (`layoutDependency`), not on every render of the
 * list, and a session that changes places with newer activity still moves at
 * once.
 */
function useCardLayoutTransition(): MotionProps['transition'] {
  const reduceMotion = useReducedMotion() ?? false
  return useMemo(() => ({ layout: reduceMotion ? { duration: 0 } : ROOM }), [reduceMotion])
}

/**
 * The room a handed-over card closes below itself when it was the last draft:
 * the Drafts label and the gap under the drafts. Those go at once, with the
 * Active label taking the Drafts label's place, so nothing above the card
 * moves and the card holds still; the sessions below rise into the room as
 * it closes. One animation, so nothing can fall out of step with it.
 */
interface HandoffFold {
  px: number
  /** The hand-off it belongs to, so a later one replays it. */
  count: number
}

/** A sent draft whose session took its card over. */
interface Handoff {
  /** Counts hand-offs, so each one replays the Active label's fade. */
  count: number
  /** The session each handed-over card belongs to, and the draft it was. */
  from: ReadonlyMap<string, string>
  /** What each handed-over card read as a draft: its title until the session is named. */
  previews: ReadonlyMap<string, string>
  /** The last draft went with it (see `HandoffFold`). */
  fold: HandoffFold | null
}

const NO_HANDOFF: Handoff = { count: 0, from: new Map(), previews: new Map(), fold: null }

/**
 * Notices a draft's card becoming its session's: a key that was a draft in
 * the last render and is an active session now. The two lists never share a
 * key in one render, since a draft whose session is listed is left out of
 * the drafts in the same update. Read during render, so the frame that
 * moves the card already knows. `measureFold` reads the room the Drafts
 * label and its gap took, from the frame still on screen.
 */
function useHandoff(
  drafts: SidebarDraft[],
  active: SidebarBoardEntry[],
  measureFold: () => number,
): [Handoff, (count: number) => void] {
  // Keyed on the drafts as the host hands them over, which change only when a
  // card does: a session update must not set state here and render the whole
  // view a second time.
  const [seen, setSeen] = useState<{ drafts: SidebarDraft[]; handoff: Handoff }>({
    drafts,
    handoff: NO_HANDOFF,
  })
  // Once its room has closed, the fold is over and the faded Drafts label goes.
  const endFold = useCallback(
    (count: number) =>
      setSeen((current) =>
        current.handoff.fold?.count === count
          ? { ...current, handoff: { ...current.handoff, fold: null } }
          : current,
      ),
    [],
  )
  if (seen.drafts === drafts) return [seen.handoff, endFold]
  const before = new Map(seen.drafts.map((draft) => [draft.sessionId, draft]))
  const from = new Map<string, string>()
  // A sent card reads as its draft until its session is named, through any
  // later change to the drafts or another hand-off.
  const previews = new Map<string, string>()
  for (const entry of active) {
    const id = entry.root.session.externalId
    const preview = seen.handoff.previews.get(id)
    if (preview !== undefined && !entry.root.session.title) previews.set(id, preview)
  }
  if (before.size > 0) {
    for (const entry of active) {
      const id = entry.root.session.externalId
      const draft = before.get(id)
      if (draft === undefined) continue
      from.set(id, draft.draftId)
      if (draft.preview) previews.set(id, draft.preview)
    }
  }
  let handoff = seen.handoff
  if (from.size > 0) {
    const count = seen.handoff.count + 1
    handoff = {
      count,
      from,
      previews,
      fold: drafts.length === 0 ? { px: measureFold(), count } : null,
    }
  } else if (seen.handoff.from.size > 0 || seen.handoff.previews.size !== previews.size) {
    handoff = { ...NO_HANDOFF, count: seen.handoff.count, previews }
  }
  setSeen({ drafts, handoff })
  return [handoff, endFold]
}

/**
 * The fold's timing: the slow tier's length, eased out, on CSS rather than
 * Motion. It has to be in place in the very commit that hands the card over,
 * before the first frame paints, and a Motion value only lands on the frame
 * after.
 */
const FOLD_MS = 240
const FOLD_EASE = 'cubic-bezier(0.25, 1, 0.5, 1)'
/** The Active label's fade after a hand-off, begun once the Drafts label (spring.moderate.exit) is mostly gone. */
const LABEL_FADE_MS = 200
const LABEL_FADE_DELAY_MS = 90

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
): string | null {
  const id = entry.root.session.externalId
  return activeDraftId !== null && handoff.from.get(id) === activeDraftId ? id : null
}

/** The id a card shows selected: the session on screen if it is this card or one of its subagents. */
function entrySelection(entry: SidebarBoardEntry, activeSessionId: string | null): string | null {
  if (activeSessionId === null) return null
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

const STATUS_COPY: Record<SessionBusyTone, string> = {
  working: 'Working',
  needs: 'Needs input',
  done: 'Done',
  error: 'Failed',
}

const STATUS_TEXT: Record<SessionBusyTone, string> = {
  working: 'text-[color:var(--basis-status-working)]',
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
 */
function useStatusMoment(tone: SessionBusyTone | null): StatusMoment | null {
  const previous = useRef(tone)
  const [moment, setMoment] = useState<StatusMoment | null>(null)
  useEffect(() => {
    if (previous.current === tone) return
    previous.current = tone
    setMoment(tone && tone !== 'working' ? { tone, key: Date.now() } : null)
  }, [tone])
  return moment
}

/** Live work says what it is doing; anything at rest says how long ago. */
function StatusOrAge({
  tone,
  iso,
  now,
  moment,
}: {
  tone: SessionBusyTone | null
  iso?: string
  now: number
  moment?: StatusMoment | null
}) {
  if (tone) {
    return (
      <span className={cn('flex items-center gap-1.5', STATUS_TEXT[tone])}>
        <SessionBusyLoader
          tone={tone}
          className={moment?.tone === tone ? 'session-busy-ring--moment' : undefined}
          burst={moment?.tone === 'done' && tone === 'done' ? moment.key : undefined}
        />
        {STATUS_COPY[tone]}
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
  workspaces: SidebarWorkspace[]
  activeWorkspacePath: string | null
  activeSessionId: string | null
  onCreateSession: (workspacePath: string) => void
  onSelectSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  /** Rename and delete stay on the contract, but the rows do not offer them
   *  for now: settling is the one thing a row does besides opening. */
  onRenameSession?: (workspacePath: string, externalId: string, title: string | null) => void
  /** Absent when the host cannot keep a settled session; the action is hidden.
   *  The host shows the move at once (the environment client does), and a
   *  refusal moves the row back through the same data. */
  onSettleSession?: (
    workspacePath: string,
    externalId: string,
    settled: boolean,
  ) => void | Promise<unknown>
  onDeleteSession?: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  /**
   * Unsent new-session drafts, shown as cards in a Drafts section above Active, in the
   * order given (newest edit first). Hosts without draft pages leave them out.
   */
  drafts?: SidebarDraft[]
  /** The draft on screen; its card shows selected. */
  activeDraftId?: string | null
  onOpenDraft?: (draftId: string) => void
  /** Absent when drafts cannot be discarded here; the card offers no discard. */
  onDiscardDraft?: (draftId: string, options?: DraftDiscardOptions) => void
  onAddWorkspace: () => void
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
  workspaces,
  activeWorkspacePath,
  activeSessionId,
  onCreateSession,
  onSelectSession: requestSelect,
  onSettleSession: requestSettle,
  drafts = NO_DRAFTS,
  activeDraftId = null,
  onOpenDraft: requestOpenDraft,
  onDiscardDraft: requestDiscardDraft,
  onAddWorkspace,
  providerLabel,
  titlebar,
  footer,
}: WorkspaceSidebarViewProps) {
  // Rows are memoized, so they get one callback of each kind for good.
  const selectRef = useRef(requestSelect)
  const settleRef = useRef(requestSettle)
  const openDraftRef = useRef(requestOpenDraft)
  const discardDraftRef = useRef(requestDiscardDraft)
  const createSessionRef = useRef(onCreateSession)
  const addWorkspaceRef = useRef(onAddWorkspace)
  useLayoutEffect(() => {
    selectRef.current = requestSelect
    settleRef.current = requestSettle
    openDraftRef.current = requestOpenDraft
    discardDraftRef.current = requestDiscardDraft
    createSessionRef.current = onCreateSession
    addWorkspaceRef.current = onAddWorkspace
  })
  // The header's two actions, stable too, so a session update leaves it be.
  const onCreateSessionStable = useCallback(
    (workspacePath: string) => createSessionRef.current(workspacePath),
    [],
  )
  const onAddWorkspaceStable = useCallback(() => addWorkspaceRef.current(), [])
  const onSelectSession = useCallback<WorkspaceSidebarViewProps['onSelectSession']>(
    (...args) => selectRef.current(...args),
    [],
  )
  const onOpenDraft = useCallback((draftId: string) => openDraftRef.current?.(draftId), [])
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
  const present = (path: string | null) =>
    path !== null && workspaces.some((workspace) => workspace.path === path && !workspace.missing)
  const newThreadTarget = present(activeWorkspacePath)
    ? activeWorkspacePath
    : (workspaces.find((workspace) => !workspace.missing)?.path ?? null)

  const { active, settled } = useMemo(() => partitionSidebarSessions(workspaces), [workspaces])
  const draftRows = useMemo(() => placeSidebarDrafts(drafts, workspaces), [drafts, workspaces])
  const now = useNow()
  const [settledOpen, setSettledOpen] = useState(readSettledOpen)
  const [settledVisible, setSettledVisible] = useState(SETTLED_PREVIEW_LIMIT)
  const [activeGroup, setActiveGroup] = useState<HTMLDivElement | null>(null)
  const [settledGroup, setSettledGroup] = useState<HTMLDivElement | null>(null)
  const activeFloor = useActiveFloor(activeGroup, settledGroup, settledOpen)
  // Armed once the first sessions have rendered, so the initial load lands
  // still and only later settles, unsettles and new threads move.
  const [armed, setArmed] = useState(false)
  const hasSessions = active.length + settled.length + draftRows.length > 0
  useEffect(() => {
    if (hasSessions) setArmed(true)
  }, [hasSessions])
  const rowMotion = useRowMotion(armed)
  const onSettledOpenChange = useCallback((open: boolean) => {
    setSettledOpen(open)
    writeSettledOpen(open)
    if (!open) setSettledVisible(SETTLED_PREVIEW_LIMIT)
  }, [])
  const onShowMoreSettled = useCallback(
    () => setSettledVisible((count) => count + SETTLED_PAGE_SIZE),
    [],
  )
  // The shelf hears about the selection only when it is one of its rows.
  const settledSelection =
    activeSessionId !== null &&
    settled
      .slice(0, settledVisible)
      .some(
        (entry) =>
          entry.root.session.externalId === activeSessionId ||
          entry.children.some((child) => child.session.externalId === activeSessionId),
      )
      ? activeSessionId
      : null
  // Selection is handed to each row as its own (`selected`), not as the id
  // on screen: opening another session re-renders the two rows it moves
  // between, not the whole list.
  const shared = {
    environmentLabel,
    now,
    onSelectSession,
    onSettleSession,
    onOpenDraft,
    onDiscardDraft,
    providerLabel,
    rowMotion,
  }
  const cardLayout = useCardLayoutTransition()
  const draftsLabelRef = useRef<HTMLDivElement>(null)
  const activeLabelRef = useRef<HTMLDivElement>(null)
  const [handoff, endFold] = useHandoff(drafts, active, () => {
    // Read in the render that hands the card over, off the frame on screen.
    const label = draftsLabelRef.current?.offsetHeight ?? 0
    const gap = activeLabelRef.current
      ? Number.parseFloat(getComputedStyle(activeLabelRef.current).paddingTop) || 0
      : 0
    return label + gap
  })
  const fold = handoff.fold
  useEffect(() => {
    if (!fold) return
    const timer = setTimeout(() => endFold(fold.count), FOLD_MS + 60)
    return () => clearTimeout(timer)
  }, [endFold, fold])

  // Rows at Tend's 15px body size.
  return (
    <Sidebar className="text-[15px]">
      {titlebar}
      <MemoSidebarActions
        newThreadTarget={newThreadTarget}
        onCreateSession={onCreateSessionStable}
        onAddWorkspace={onAddWorkspaceStable}
      />
      <SidebarContent>
        {workspaces.length === 0 ? (
          <p className="px-4 py-5 text-[13px] text-muted-foreground">No projects yet</p>
        ) : (
          // Drafts and Active share the floor, so Settled keeps its spot
          // whether or not drafts are waiting above the active cards.
          <div ref={setActiveGroup} className="flex flex-col" style={{ minHeight: activeFloor }}>
            {/* Drafts, newest edit first, then the active sessions: one list,
                with each section's label a row in it. A draft's card is keyed
                by the session it will become, so its send hands the same row
                to the session's card, which slides down to the top of Active
                rather than folding away here and growing in there. The Drafts
                label comes and goes with the first and last draft. */}
            <SidebarGroup>
              <CardList>
                {/* Kept for the fold after the last draft is handed over: out
                    of the flow, fading where it was as Active takes its place. */}
                {draftRows.length > 0 || fold ? (
                  <SectionLabel
                    key="drafts-label"
                    rowRef={draftsLabelRef}
                    rowMotion={rowMotion}
                    popped={draftRows.length === 0}
                  >
                    Drafts
                  </SectionLabel>
                ) : null}
                {draftRows.map((row, index) => (
                  <MemoActiveCard
                    key={row.draft.sessionId}
                    item={row}
                    place={index}
                    layoutTransition={cardLayout}
                    fold={null}
                    untitled={undefined}
                    selected={row.draft.draftId === activeDraftId ? row.draft.draftId : null}
                    {...shared}
                  />
                ))}
                <MemoActiveLabel
                  key="active-label"
                  rowRef={activeLabelRef}
                  spaced={draftRows.length > 0}
                  instant={fold !== null}
                  handoff={handoff.count}
                />
                {active.map((entry) => (
                  <MemoActiveCard
                    key={entry.root.session.externalId}
                    item={{ kind: 'session', entry }}
                    place="session"
                    layoutTransition={cardLayout}
                    fold={fold && handoff.from.has(entry.root.session.externalId) ? fold : null}
                    untitled={handoff.previews.get(entry.root.session.externalId)}
                    selected={
                      entrySelection(entry, activeSessionId) ??
                      handedSelection(entry, handoff, activeDraftId)
                    }
                    {...shared}
                  />
                ))}
              </CardList>
              <EmptyNote show={active.length === 0} rowMotion={rowMotion}>
                {settled.length > 0 ? 'All caught up.' : 'No sessions yet.'}
              </EmptyNote>
            </SidebarGroup>
          </div>
        )}

        {/* Settled follows the active list in the same scroll. It rests at its
            default spot (the active list's floor), on the bottom edge when
            folded, and moves only when the cards outgrow that, riding down as
            they grow in. */}
        {workspaces.length > 0 || settled.length > 0 ? (
          <MemoSettledShelf
            groupRef={setSettledGroup}
            settled={settled}
            open={settledOpen}
            onOpenChange={onSettledOpenChange}
            visible={settledVisible}
            onShowMore={onShowMoreSettled}
            selected={settledSelection}
            {...shared}
          />
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
  groupRef,
  settled,
  open,
  onOpenChange,
  visible,
  onShowMore,
  selected,
  ...shared
}: Omit<RowHandlers, 'selected'> & {
  groupRef: Ref<HTMLDivElement>
  settled: SidebarBoardEntry[]
  open: boolean
  onOpenChange: (open: boolean) => void
  visible: number
  onShowMore: () => void
  /** The open session when it is one of the shelf's rows, else null. */
  selected: string | null
}) {
  return (
    <SidebarGroup
      ref={groupRef}
      collapsible
      className="pb-1"
      open={open}
      onOpenChange={onOpenChange}
    >
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
              <MemoSettledRow
                key={row.session.externalId}
                row={row}
                selected={row.session.externalId === selected ? selected : null}
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
    a.groupRef === b.groupRef &&
    a.open === b.open &&
    a.onOpenChange === b.onOpenChange &&
    a.visible === b.visible &&
    a.onShowMore === b.onShowMore &&
    sameHandlers({ ...a, selected: a.selected }, { ...b, selected: b.selected }) &&
    sameEntries(a.settled, b.settled),
)

/**
 * New agent and Add project. Its own memoized piece: server updates re-render
 * the session list, and these two buttons (and their tooltips) have no part
 * in that. Only where a new agent would start changes them.
 */
function SidebarActions({
  newThreadTarget,
  onCreateSession,
  onAddWorkspace,
}: {
  newThreadTarget: string | null
  onCreateSession: (workspacePath: string) => void
  onAddWorkspace: () => void
}) {
  return (
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            icon={NewAgentIcon}
            disabled={!newThreadTarget}
            onClick={() => {
              if (newThreadTarget) onCreateSession(newThreadTarget)
            }}
          >
            New agent
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton icon={AddProjectIcon} onClick={onAddWorkspace}>
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
    <div role="list" tabIndex={-1} className="relative flex flex-col outline-none">
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
function SectionLabel({
  rowMotion,
  rowRef,
  popped,
  children,
}: {
  rowMotion: MotionProps
  rowRef: Ref<HTMLDivElement>
  /** Out of the flow, fading where it is: its section was handed over (`HandoffFold`). */
  popped: boolean
  children: ReactNode
}) {
  const reduceMotion = useReducedMotion() ?? false
  return (
    <motion.div
      ref={rowRef}
      role="presentation"
      aria-hidden={popped || undefined}
      className={cn('overflow-hidden', popped && 'pointer-events-none absolute inset-x-0 top-0')}
      {...rowMotion}
      animate={
        popped
          ? { opacity: 0, transition: reduceMotion ? { duration: 0 } : spring.moderate.exit }
          : rowMotion.animate
      }
    >
      <SidebarGroupLabel role="heading" aria-level={2}>
        {children}
      </SidebarGroupLabel>
    </motion.div>
  )
}

/** The room between the last draft and the Active label. */
const SECTION_GAP = 16

/**
 * The Active label, always in the list. Drafts above it are set off by a gap
 * that opens with the first draft and closes with the last. When a sent
 * draft's card moves down past it, the label does not travel up through the
 * card: it fades in at its new place instead (`handoff` counts the hand-offs).
 *
 * The gap is plain CSS, so that a hand-off of the last draft can close it in
 * the commit itself (`instant`), the card below holding still.
 */
function ActiveLabel({
  rowRef,
  spaced,
  instant,
  handoff,
}: {
  rowRef: Ref<HTMLDivElement>
  spaced: boolean
  instant: boolean
  handoff: number
}) {
  const reduceMotion = useReducedMotion() ?? false
  const labelRef = useRef<HTMLDivElement>(null)
  // Web Animations, not Motion: inside the list's presence (initial={false})
  // a Motion child mounted later skips its `initial`, so a keyed fade never
  // plays. Opacity alone runs off the main thread, and it waits a beat, until
  // the Drafts label it replaces has mostly faded, so the two never overprint.
  useLayoutEffect(() => {
    const label = labelRef.current
    if (handoff === 0 || reduceMotion || typeof label?.animate !== 'function') return
    const fade = label.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: LABEL_FADE_MS,
      delay: LABEL_FADE_DELAY_MS,
      easing: FOLD_EASE,
      fill: 'backwards',
    })
    return () => fade.cancel()
  }, [handoff, reduceMotion])
  return (
    <div
      ref={rowRef}
      role="presentation"
      style={{
        paddingTop: spaced ? SECTION_GAP : 0,
        // Opening on the slow tier, closing with the label's fold above it.
        transition:
          instant || reduceMotion
            ? undefined
            : `padding-top ${spaced ? FOLD_MS : spring.slow.exit.duration * 1000}ms ${FOLD_EASE}`,
      }}
    >
      <div ref={labelRef}>
        <SidebarGroupLabel role="heading" aria-level={2}>
          Active
        </SidebarGroupLabel>
      </div>
    </div>
  )
}

const MemoActiveLabel = memo(ActiveLabel)

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
      a.git?.worktree === b.git?.worktree)
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
    a.now === b.now &&
    a.onSelectSession === b.onSelectSession &&
    a.onSettleSession === b.onSettleSession &&
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
  now: number
  onSelectSession: WorkspaceSidebarViewProps['onSelectSession']
  onSettleSession?: WorkspaceSidebarViewProps['onSettleSession']
  onOpenDraft?: (draftId: string) => void
  onDiscardDraft?: (draftId: string, options?: DraftDiscardOptions) => void
  providerLabel?: WorkspaceSidebarViewProps['providerLabel']
  rowMotion: MotionProps
}

interface ActiveCardProps extends RowHandlers {
  item: ActiveItem
  /**
   * Where the card is, as far as moving goes: a draft's index among the
   * drafts, or `session`. The card is measured for a move only when this
   * changes, so a draft handed to its session (or closing up after one) moves,
   * and nothing else measures.
   */
  place: number | 'session'
  /** How the card moves when its place changes (`useCardLayoutTransition`). */
  layoutTransition: MotionProps['transition']
  /**
   * The room this card closes below itself, when it took the last draft's
   * place (`HandoffFold`). Read in the render that hands the card over, which
   * re-renders it anyway, so it is left out of the card's comparison: the fold
   * being over is no reason to render the card again.
   */
  fold: HandoffFold | null
  /** What a session card reads while its session has no title yet: the draft's first line, after a hand-off. */
  untitled: string | undefined
}

/** A card in Drafts or Active: a new-session draft, or a session. */
function ActiveCard({
  item,
  place,
  layoutTransition,
  fold,
  untitled,
  ...handlers
}: ActiveCardProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion() ?? false
  // Before the first frame paints: the room starts open, so nothing below the
  // card moves in the commit, then closes.
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!fold || !row || reduceMotion) return
    row.style.transition = 'none'
    row.style.paddingBottom = `${fold.px}px`
    void row.offsetHeight
    row.style.transition = `padding-bottom ${FOLD_MS}ms ${FOLD_EASE}`
    row.style.paddingBottom = '0px'
    const timer = setTimeout(() => {
      row.style.transition = ''
      row.style.paddingBottom = ''
    }, FOLD_MS + 60)
    return () => clearTimeout(timer)
  }, [fold, reduceMotion])
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
        <SessionCardBody entry={item.entry} untitled={untitled} {...handlers} />
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

function SessionCardBody({
  entry,
  untitled,
  selected,
  environmentLabel,
  now,
  onSelectSession,
  onSettleSession,
  providerLabel,
}: RowHandlers & { entry: SidebarBoardEntry; untitled?: string }) {
  const { session, workspace } = entry.root
  const providerId = session.providerId ?? DEFAULT_PROVIDER_ID
  const isActive = session.externalId === selected
  const unavailable = workspace.missing
    ? describeUnavailableWorkspace(workspace.availability)
    : null
  const git = workspace.git
  const select = () => onSelectSession(workspace.path, session.externalId, providerId)
  const providerName = providerLabel?.(providerId) ?? providerId
  const tone = sessionBusyTone(session.status)
  const moment = useStatusMoment(tone)
  // Live work cannot be settled, so its status has nothing to make room for.
  const hasActions = Boolean(onSettleSession) && tone !== 'working' && tone !== 'needs'
  const reduceMotion = useReducedMotion() ?? false
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (moment?.tone !== 'needs' || reduceMotion) return
    const card = cardRef.current
    // Web Animations is everywhere the app runs, but not in every test DOM.
    if (typeof card?.animate === 'function') {
      card.animate(NUDGE, { duration: 500, easing: 'ease-in-out' })
    }
  }, [moment, reduceMotion])

  const projectLine = (
    <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-muted-foreground">
      <ProjectIcon workspacePath={workspace.path} className="opacity-80" />
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
        <StatusOrAge tone={tone} iso={session.updatedAt} now={now} moment={moment} />
      </span>
    </span>
  )
  // Not on the session on screen: the host leaves it out there, so the card
  // does not flicker as its composer empties and fills.
  const unsent = Boolean(session.hasUnsentDraft) && !isActive
  const metaLine = (
    <span className="flex min-w-0 items-center gap-2 text-[12px] leading-4 text-faint">
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
        {tone === 'needs' ? (
          <span aria-hidden="true" className="session-row-dither session-row-dither--needs" />
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
            {environmentLabel ? <span className="sr-only"> on {environmentLabel}</span> : null}
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
              />
            ))}
          </div>
        ) : null}
      </div>
      {/* Live work cannot be settled: the environment refuses it, since
            nothing would bring the card back once the turn finished. */}
      {onSettleSession && hasActions ? (
        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-80 group-has-[:focus-visible]/card:opacity-100 group-hover/card:opacity-100 pointer-coarse:opacity-100 [:root[data-draft-discard-guard]_&]:opacity-0">
          <CardAction
            label="Settle"
            onClick={(event) => {
              // The second half of a double click that discarded the draft
              // above: this card slid up under it. A keypress still settles.
              if (event.detail > 0 && onDiscardGuardedSpot(event)) return
              onSettleSession(workspace.path, session.externalId, true)
            }}
          >
            <CheckIcon />
          </CardAction>
        </div>
      ) : null}
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
  onOpenDraft,
  onDiscardDraft,
  providerLabel,
}: RowHandlers & { row: SidebarDraftRow }) {
  const { draft, workspace } = row
  const isActive = draft.draftId === selected
  const providerName = providerLabel?.(draft.providerId) ?? draft.providerId
  const unavailable = workspace?.missing
    ? describeUnavailableWorkspace(workspace.availability)
    : null
  const git = workspace?.git
  const preview = draft.preview || imagesLabel(draft.imageCount)
  const unsynced = draft.unsynced ? DRAFT_SYNC_EXPLANATION[draft.unsynced] : undefined
  const open = () => onOpenDraft?.(draft.draftId)
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
          <ProjectIcon workspacePath={workspace.path} className="opacity-80" />
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
      {/* The composer's "Not synced", made quiet: the mark, and its reason on hover. */}
      {unsynced ? (
        <Tooltip content={unsynced}>
          <span className="ml-auto flex shrink-0 items-center gap-1">
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
            {environmentLabel ? <span className="sr-only"> on {environmentLabel}</span> : null}
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
}: Pick<RowHandlers, 'selected' | 'now' | 'onSelectSession'> & { row: SidebarBoardRow }) {
  const { session, workspace, depth } = row
  const providerId = session.providerId ?? DEFAULT_PROVIDER_ID
  const isActive = session.externalId === selected
  const tone = sessionBusyTone(session.status)
  return (
    // Buttons inherit their font, so the size is set on the wrapper.
    <div role="listitem" className="text-[13px]">
      <button
        type="button"
        aria-current={isActive ? 'page' : undefined}
        onClick={() => onSelectSession(workspace.path, session.externalId, providerId)}
        style={depth > 1 ? { paddingLeft: 8 + Math.min(depth - 1, 3) * 12 } : undefined}
        className={cn(
          'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left outline-none transition-colors duration-80',
          'focus-visible:ring-1 focus-visible:ring-focus-ring',
          isActive
            ? 'bg-active text-foreground'
            : 'text-muted-foreground hover:bg-hover hover:text-foreground',
        )}
      >
        <GitBranchIcon className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
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

/** Settled work at a glance: what it was and when it was put away. */
function SettledRow({
  row,
  selected,
  environmentLabel,
  now,
  onSelectSession,
  onSettleSession,
  rowMotion,
}: RowHandlers & { row: SidebarBoardRow }) {
  const { session, workspace, depth } = row
  const providerId = session.providerId ?? DEFAULT_PROVIDER_ID
  const tone = sessionBusyTone(session.status)
  const isActive = session.externalId === selected
  // Settled work can still hold a reply the user started: the active cards' mark.
  const unsent = Boolean(session.hasUnsentDraft) && !isActive
  return (
    <MotionMenuItem className="overflow-hidden" {...rowMotion}>
      <SidebarMenuButton
        icon={depth > 0 ? ChildSessionIcon : providerIcon(providerId)}
        isActive={isActive}
        className="text-muted-foreground"
        style={depth > 0 ? { paddingLeft: 8 + Math.min(depth, 4) * 12 } : undefined}
        onClick={() => onSelectSession(workspace.path, session.externalId, providerId)}
      >
        <span className="truncate">{session.title || 'New session'}</span>
        {unsent ? <UnsentMark /> : null}
        <span className="sr-only">
          {' '}
          in {workspace.name}
          {environmentLabel ? ` on ${environmentLabel}` : ''}
        </span>
      </SidebarMenuButton>
      <SidebarMenuBadge>
        {tone ? (
          <SessionBusyLoader tone={tone} />
        ) : (
          formatRelativeTime(session.settledAt ?? session.updatedAt, now)
        )}
      </SidebarMenuBadge>
      {onSettleSession && depth === 0 ? (
        <SidebarMenuActions showOnHover>
          <SidebarMenuAction
            aria-label="Move back to active"
            onClick={() => onSettleSession(workspace.path, session.externalId, false)}
          >
            <ArrowUUpLeftIcon />
          </SidebarMenuAction>
        </SidebarMenuActions>
      ) : null}
    </MotionMenuItem>
  )
}

const MemoSettledRow = memo(SettledRow, (a, b) => sameHandlers(a, b) && sameRow(a.row, b.row))
