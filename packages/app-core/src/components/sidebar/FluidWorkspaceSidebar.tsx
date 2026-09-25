import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion, type MotionProps } from 'framer-motion'
import {
  Check,
  ChevronDown,
  FolderGit2,
  FolderPlus,
  GitBranch,
  SquarePen,
  Undo2,
} from 'lucide-react'
import type { ProviderId } from '@agentpack/contract'
import { describeUnavailableWorkspace } from '../../lib/workspace-availability'
import { formatRelativeTime, useNow } from '../../lib/relative-time'
import { cn } from '../../lib/utils'
import type { IconComponent, IconComponentProps } from '../fluid/lib/icon-context'
import { spring } from '../fluid/lib/springs'
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
  flattenSidebarSessions,
  type SidebarSession,
  type SidebarWorkspace,
} from './WorkspaceSidebarView'

const SETTLED_PREVIEW_LIMIT = 10
const SETTLED_PAGE_SIZE = 25
const SETTLED_OPEN_KEY = 'openmanager.sidebar.settled-open'
/** The share of the sidebar's scroll area kept below the active list for an
 *  open Settled while the cards fit above it: its default spot. */
const SETTLED_SHARE = 0.3
const DEFAULT_PROVIDER_ID: ProviderId = 'opencode'
const cardBodyClass = 'flex w-full min-w-0 flex-col gap-1 rounded-[10px] px-3 py-2.5 text-left'

// Fluid rows take an icon component; provider marks need their id bound in.
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

/**
 * How a row joins and leaves a list: it grows from nothing and fades in, or
 * folds away, on the moderate spring the rest of the sidebar moves on, and
 * the rows around it close the gap as it goes. Rows present when the list
 * first fills in appear as they are, so opening the app animates nothing.
 */
function useRowMotion(armed: boolean): MotionProps {
  const reduceMotion = useReducedMotion() ?? false
  const still = { duration: 0 }
  return {
    layout: 'position',
    initial: armed ? { height: 0, opacity: 0 } : false,
    animate: { height: 'auto', opacity: 1, transition: reduceMotion ? still : spring.moderate },
    exit: { height: 0, opacity: 0, transition: reduceMotion ? still : spring.moderate.exit },
    transition: reduceMotion ? still : spring.moderate,
  }
}

function writeSettledOpen(open: boolean) {
  try {
    globalThis.localStorage?.setItem(SETTLED_OPEN_KEY, String(open))
  } catch {
    /* best effort */
  }
}

const STATUS_COPY: Record<Exclude<SessionBusyTone, 'ready'>, string> = {
  working: 'Working',
  needs: 'Needs input',
  error: 'Failed',
}

/** Live work says what it is doing; anything at rest says how long ago. */
function StatusOrAge({ status, iso, now }: { status: string; iso?: string; now: number }) {
  const tone = sessionBusyTone(status)
  if (tone && tone !== 'ready') {
    return (
      <span
        className={cn(
          'flex items-center gap-1.5',
          tone === 'needs' && 'text-[color:var(--basis-warning,#d4a24c)]',
          tone === 'error' && 'text-destructive',
        )}
      >
        <SessionBusyLoader tone={tone} />
        {STATUS_COPY[tone]}
      </span>
    )
  }
  const age = formatRelativeTime(iso, now)
  return age ? <span className="tabular-nums">{age}</span> : null
}

function CardAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
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

export interface FluidWorkspaceSidebarViewProps {
  environmentLabel?: string
  workspaces: SidebarWorkspace[]
  activeWorkspacePath: string | null
  activeSessionId: string | null
  onCreateSession: (workspacePath: string) => void
  onSelectSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  /** Rename and delete stay on the contract, but the rows do not offer them
   *  for now: settling is the one thing a row does besides opening. */
  onRenameSession?: (workspacePath: string, externalId: string, title: string | null) => void
  /** Absent when the host cannot keep a settled session; the action is hidden. */
  onSettleSession?: (workspacePath: string, externalId: string, settled: boolean) => void
  onDeleteSession?: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  onAddWorkspace: () => void
  /** The name a provider goes by; the raw id when the host has no catalog. */
  providerLabel?: (providerId: ProviderId) => string
  /** Rows under the session list, anchored to the sidebar's outer edge. */
  footer?: ReactNode
}

/**
 * The session sidebar on Fluid Functionalism's sidebar. Projects are not
 * groups here: every session is either active (a card with its project,
 * branch, provider and age) or settled, put away in a folded list below
 * until it is needed again. Must render inside a Fluid `SidebarProvider`.
 */
export function FluidWorkspaceSidebarView({
  environmentLabel,
  workspaces,
  activeWorkspacePath,
  activeSessionId,
  onCreateSession,
  onSelectSession,
  onSettleSession,
  onAddWorkspace,
  providerLabel,
  footer,
}: FluidWorkspaceSidebarViewProps) {
  const present = (path: string | null) =>
    path !== null && workspaces.some((workspace) => workspace.path === path && !workspace.missing)
  const newThreadTarget = present(activeWorkspacePath)
    ? activeWorkspacePath
    : (workspaces.find((workspace) => !workspace.missing)?.path ?? null)

  const { active, settled } = useMemo(() => partitionSidebarSessions(workspaces), [workspaces])
  const now = useNow()
  const [settledOpen, setSettledOpen] = useState(readSettledOpen)
  const [settledVisible, setSettledVisible] = useState(SETTLED_PREVIEW_LIMIT)
  const [activeGroup, setActiveGroup] = useState<HTMLDivElement | null>(null)
  const [settledGroup, setSettledGroup] = useState<HTMLDivElement | null>(null)
  const activeFloor = useActiveFloor(activeGroup, settledGroup, settledOpen)
  // Armed once the first sessions have rendered, so the initial load lands
  // still and only later settles, unsettles and new threads move.
  const [armed, setArmed] = useState(false)
  const hasSessions = active.length + settled.length > 0
  useEffect(() => {
    if (hasSessions) setArmed(true)
  }, [hasSessions])
  const rowMotion = useRowMotion(armed)
  const shared = {
    activeSessionId,
    environmentLabel,
    now,
    onSelectSession,
    onSettleSession,
    providerLabel,
    rowMotion,
  }

  // Rows at Tend's 15px body size.
  return (
    <Sidebar className="text-[15px]">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              icon={SquarePen}
              disabled={!newThreadTarget}
              onClick={() => {
                if (newThreadTarget) onCreateSession(newThreadTarget)
              }}
            >
              New agent
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton icon={FolderPlus} onClick={onAddWorkspace}>
              Add project
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {workspaces.length === 0 ? (
          <p className="px-4 py-5 text-[13px] text-muted-foreground">No projects yet</p>
        ) : (
          <SidebarGroup ref={setActiveGroup} style={{ minHeight: activeFloor }}>
            <SidebarGroupLabel>Active</SidebarGroupLabel>
            {active.length === 0 ? (
              <p className="px-2 pb-2 pt-1 text-[13px] leading-5 text-faint">
                {settled.length > 0 ? 'All caught up.' : 'No sessions yet.'}
              </p>
            ) : (
              // Divs, not ul/li: the app's unlayered list rules outrank utilities.
              // Cards space themselves (padding, not gap) so a leaving card
              // folds its spacing away with it.
              <div role="list" className="flex flex-col">
                <AnimatePresence initial={false}>
                  {active.map((entry) => (
                    <SessionCard key={entry.root.session.externalId} entry={entry} {...shared} />
                  ))}
                </AnimatePresence>
              </div>
            )}
          </SidebarGroup>
        )}

        {/* Settled follows the active list in the same scroll. It rests at its
            default spot (the active list's floor), on the bottom edge when
            folded, and moves only when the cards outgrow that, riding down as
            they grow in. */}
        {workspaces.length > 0 || settled.length > 0 ? (
          <SidebarGroup
            ref={setSettledGroup}
            collapsible
            className="pb-1"
            open={settledOpen}
            onOpenChange={(open) => {
              setSettledOpen(open)
              writeSettledOpen(open)
              if (!open) setSettledVisible(SETTLED_PREVIEW_LIMIT)
            }}
          >
            {/* The toggle is a button, which inherits the row size; the spans
                carry the label size themselves. */}
            <SidebarGroupLabel>
              <span className="text-[12px]">Settled</span>
              <span className="text-[12px] tabular-nums text-faint">{settled.length}</span>
            </SidebarGroupLabel>
            {settled.length === 0 ? (
              <p className="px-2 pb-2 pt-1 text-[13px] leading-5 text-faint">
                Settle a finished thread and it waits here.
              </p>
            ) : (
              <SidebarMenu>
                <AnimatePresence initial={false}>
                  {settled
                    .slice(0, settledVisible)
                    .flatMap((entry) => [entry.root, ...entry.children])
                    .map((row) => (
                      <SettledRow key={row.session.externalId} row={row} {...shared} />
                    ))}
                </AnimatePresence>
                {settled.length > settledVisible ? (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      icon={ChevronDown}
                      className="text-muted-foreground"
                      onClick={() => setSettledVisible((count) => count + SETTLED_PAGE_SIZE)}
                    >
                      Show more
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}
              </SidebarMenu>
            )}
          </SidebarGroup>
        ) : null}
      </SidebarContent>

      {footer ? <SidebarFooter>{footer}</SidebarFooter> : null}
    </Sidebar>
  )
}

interface RowHandlers {
  activeSessionId: string | null
  environmentLabel?: string
  now: number
  onSelectSession: FluidWorkspaceSidebarViewProps['onSelectSession']
  onSettleSession?: FluidWorkspaceSidebarViewProps['onSettleSession']
  providerLabel?: FluidWorkspaceSidebarViewProps['providerLabel']
  rowMotion: MotionProps
}

function SessionCard({
  entry,
  activeSessionId,
  environmentLabel,
  now,
  onSelectSession,
  onSettleSession,
  providerLabel,
  rowMotion,
}: RowHandlers & { entry: SidebarBoardEntry }) {
  const { session, workspace } = entry.root
  const providerId = session.providerId ?? DEFAULT_PROVIDER_ID
  const isActive = session.externalId === activeSessionId
  const unavailable = workspace.missing
    ? describeUnavailableWorkspace(workspace.availability)
    : null
  const git = workspace.git
  const select = () => onSelectSession(workspace.path, session.externalId, providerId)
  const providerName = providerLabel?.(providerId) ?? providerId

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
      {/* Gives way to the hover actions, which sit over this corner. */}
      <span className="ml-auto flex shrink-0 items-center pl-2 transition-opacity duration-80 group-focus-within/card:opacity-0 group-hover/card:opacity-0 pointer-coarse:opacity-0">
        <StatusOrAge status={session.status} iso={session.updatedAt} now={now} />
      </span>
    </span>
  )
  const metaLine = (
    <span className="flex min-w-0 items-center gap-2 text-[12px] leading-4 text-faint">
      {/* The mark alone; its name is for hover and assistive tech. */}
      <span className="flex shrink-0 items-center" title={providerName}>
        <ProviderIcon providerId={providerId} className="h-3 w-3 opacity-80" />
        <span className="sr-only">{providerName}</span>
      </span>
      {git ? (
        <span
          className="flex min-w-0 items-center gap-1"
          title={git.worktree ? 'Worktree' : undefined}
        >
          {git.worktree ? (
            <FolderGit2 className="h-3 w-3 shrink-0" aria-label="Worktree" />
          ) : (
            <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
          )}
          <span className="truncate">{git.branch ?? 'detached'}</span>
        </span>
      ) : null}
    </span>
  )

  return (
    // The clip lets the card fold to nothing on its way out; the padding
    // inside it is the space between cards, so it folds away too.
    <motion.div role="listitem" className="overflow-hidden" {...rowMotion}>
      <div className="group/card relative pb-1">
        <div
          className={cn(
            // Selection is a fill, never an outline, on every scheme.
            'rounded-[10px] transition-colors duration-100',
            isActive ? 'bg-active' : 'hover:bg-hover',
          )}
        >
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
              {session.title || 'New session'}
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
                  activeSessionId={activeSessionId}
                  now={now}
                  onSelectSession={onSelectSession}
                />
              ))}
            </div>
          ) : null}
        </div>
        {onSettleSession ? (
          <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-80 group-focus-within/card:opacity-100 group-hover/card:opacity-100 pointer-coarse:opacity-100">
            <CardAction
              label="Settle"
              onClick={() => onSettleSession(workspace.path, session.externalId, true)}
            >
              <Check />
            </CardAction>
          </div>
        ) : null}
      </div>
    </motion.div>
  )
}

/** A subagent transcript, kept under the card of the session that started it. */
function ChildRow({
  row,
  activeSessionId,
  now,
  onSelectSession,
}: Pick<RowHandlers, 'activeSessionId' | 'now' | 'onSelectSession'> & { row: SidebarBoardRow }) {
  const { session, workspace, depth } = row
  const providerId = session.providerId ?? DEFAULT_PROVIDER_ID
  const isActive = session.externalId === activeSessionId
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
        <GitBranch className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
        <span className="truncate">{session.title || 'Subagent'}</span>
        <span className="ml-auto shrink-0 pl-2 text-[11px] text-faint">
          {tone && tone !== 'ready' ? (
            <SessionBusyLoader tone={tone} />
          ) : (
            formatRelativeTime(session.updatedAt, now)
          )}
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
  activeSessionId,
  environmentLabel,
  now,
  onSelectSession,
  onSettleSession,
  rowMotion,
}: RowHandlers & { row: SidebarBoardRow }) {
  const { session, workspace, depth } = row
  const providerId = session.providerId ?? DEFAULT_PROVIDER_ID
  const tone = sessionBusyTone(session.status)
  const live = tone !== null && tone !== 'ready'
  return (
    <MotionMenuItem className="overflow-hidden" {...rowMotion}>
      <SidebarMenuButton
        icon={depth > 0 ? GitBranch : providerIcon(providerId)}
        isActive={session.externalId === activeSessionId}
        className="text-muted-foreground"
        style={depth > 0 ? { paddingLeft: 8 + Math.min(depth, 4) * 12 } : undefined}
        onClick={() => onSelectSession(workspace.path, session.externalId, providerId)}
      >
        <span className="truncate">{session.title || 'New session'}</span>
        <span className="sr-only">
          {' '}
          in {workspace.name}
          {environmentLabel ? ` on ${environmentLabel}` : ''}
        </span>
      </SidebarMenuButton>
      <SidebarMenuBadge>
        {live ? (
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
            <Undo2 />
          </SidebarMenuAction>
        </SidebarMenuActions>
      ) : null}
    </MotionMenuItem>
  )
}
