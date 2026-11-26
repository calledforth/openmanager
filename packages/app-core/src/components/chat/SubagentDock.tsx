import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CaretDownIcon, CheckIcon, MinusIcon, XIcon } from '@phosphor-icons/react'
import type { ProviderId } from '@agentpack/contract'
import type { PullRequestSummary, Subagent } from '@openmanager/protocol'
import type { EnvironmentState } from '@openmanager/environment-client'
import { cn } from '../../lib/utils'
import {
  useEnvironmentClientOptional,
  useEnvironmentState,
} from '../../providers/environment-client'
import { useViewActions } from '../../providers/view-actions'
import { SessionBusyLoader } from '../sidebar/SessionBusyLoader'
import { ProviderIcon } from '../providers/ProviderIcon'
import { pullRequestKey, stateMeta } from '../pull-requests/pull-request-status'
import {
  requestOpenPullRequest,
  selectRootSessionId,
  useSessionPullRequests,
} from '../../lib/pull-requests/use-pull-requests'
import {
  SubagentStatusGlyph,
  SubagentStopText,
  subagentStatusTextColor,
  useTick,
} from '../parts/SubagentCard'
import { formatElapsed, subagentElapsedMs, type SubagentTone } from '../parts/subagent-card'
import {
  buildLineage,
  lineageCounts,
  lineageHeadline,
  lineageNodeDetail,
  lineagePhaseRows,
  lineageRows,
  useLineagePhase,
  type Lineage,
  type LineageNode,
} from './subagent-lineage'

// The phase and headline live with the lineage, shared with the phone.
export {
  ALL_DONE_LINGER_MS,
  lineageHeadline,
  useLineagePhase,
  type LineagePhase,
} from './subagent-lineage'

/**
 * The open chat's subagents, wherever the chat pane has room for them: on a
 * wide pane (64rem and up) a column at its right that also lists the chat's
 * pull requests and keeps every subagent once it has started, the
 * conversation moving left once to make room for it; on a narrower one a
 * strip above the composer, beside the background-tasks strip and built like
 * it, shown while any works. Both draw the same rows: a subagent per row,
 * nested ones indented under the one that started them.
 *
 * A subagent started turns ago, whose card has scrolled away, is the reason
 * this exists: without it nothing on screen said it still ran.
 */

const selectSessions = (state: EnvironmentState) => state.sessions
const selectThreads = (state: EnvironmentState) => state.threads
const selectActive = (state: EnvironmentState) => state.activeSessionId

/** The open session's subagent tree. */
function useSessionLineage() {
  const sessionId = useEnvironmentState(selectActive)
  const sessions = useEnvironmentState(selectSessions)
  const threads = useEnvironmentState(selectThreads)
  const lineage = useMemo(
    () => buildLineage(sessionId, sessions, (threadId) => threads[threadId]?.subagents),
    [sessionId, sessions, threads],
  )
  return { sessionId, lineage }
}

// ─── The list both surfaces draw ────────────────────────────────────────────

/**
 * Subagents as rows: a status dot, the title, a clock (Stop over it on
 * hover), and under a live one what it is doing or waits on. Nested ones
 * are indented under the one that started them, hung off a hairline.
 */
export function SubagentList({
  rows,
  now,
  compact = false,
}: {
  rows: ReturnType<typeof lineageRows>
  now: number
  /** The strip's size: 11px titles, as its siblings above the composer. */
  compact?: boolean
}) {
  return (
    <div role="tree" aria-label="Subagents of this chat" className="flex flex-col">
      {rows.map(({ node }) => (
        <SubagentListRow key={node.key} node={node} now={now} compact={compact} />
      ))}
    </div>
  )
}

const INDENT = 12

/**
 * A subagent's state as the sidebar draws a session's: the same loader while
 * it works (iris) or waits on you (amber), a tick once done, a cross if it
 * failed, a dash if it was stopped.
 */
function SubagentStateMark({
  tone,
  waitingOn,
}: {
  tone: SubagentTone
  waitingOn?: Subagent['waitingOn']
}) {
  switch (tone) {
    case 'running':
      return <SessionBusyLoader tone="working" label="Subagent working" />
    case 'waiting':
      // As the sidebar draws a session: a question bobs (pink), a permission
      // or a plan knocks (amber).
      return waitingOn === 'question' ? (
        <SessionBusyLoader tone="question" label="Subagent has a question for you" />
      ) : (
        <SessionBusyLoader tone="needs" label="Subagent needs your attention" />
      )
    case 'done':
      return (
        <span role="img" aria-label="Done" className="flex">
          <CheckIcon
            weight="bold"
            aria-hidden
            className="size-[11px]"
            style={{ color: 'var(--basis-status-done)' }}
          />
        </span>
      )
    case 'failed':
      return (
        <span role="img" aria-label="Failed" className="flex">
          <XIcon
            weight="bold"
            aria-hidden
            className="size-[10px]"
            style={{ color: 'var(--basis-status-error)' }}
          />
        </span>
      )
    case 'stopped':
      return (
        <span role="img" aria-label="Stopped" className="flex">
          <MinusIcon
            weight="bold"
            aria-hidden
            className="size-[10px] text-[var(--basis-text-faint)]"
          />
        </span>
      )
  }
}

function SubagentListRow({
  node,
  now,
  compact,
}: {
  node: LineageNode
  now: number
  compact: boolean
}) {
  const { openChildSession } = useViewActions()
  const client = useEnvironmentClientOptional()
  const record = node.subagent
  const self = node.tone === 'running' || node.tone === 'waiting'
  const open =
    node.sessionId && openChildSession
      ? () => void openChildSession(node.sessionId!, node.parentSessionId).catch(() => undefined)
      : undefined
  const stop =
    self && record?.stoppable && client?.supports('stopSubagent')
      ? () =>
          client.commands.stopSubagent({
            sessionId: record.parentSessionId,
            subagentId: record.subagentId,
          })
      : undefined
  const elapsed = record ? subagentElapsedMs(record, now) : undefined
  const status: Pick<Subagent, 'status' | 'waitingOn'> = {
    status: node.status,
    ...(node.waitingOn ? { waitingOn: node.waitingOn } : {}),
  }
  // Only a live one says more than its name: what it is doing or waits on.
  // A failed one's reason is on hover, so the finished keep to one line.
  const detail = lineageNodeDetail(node)
  const line = self ? detail : undefined
  const pad = 6 + (node.depth - 1) * INDENT
  const titleClass = cn(
    'min-w-0 flex-1 truncate text-left',
    compact ? 'text-11-regular leading-4' : 'text-ui-sm leading-[18px]',
    self ? 'text-[var(--basis-text)]' : 'text-[var(--basis-text-muted)]',
  )
  const hover = node.tone === 'failed' && detail ? `${node.title}: ${detail}` : node.title
  return (
    <div
      role="treeitem"
      aria-selected={false}
      aria-level={node.depth}
      data-lineage-node={node.key}
      data-lineage-status={node.status}
      className={cn(
        'group/row relative flex min-w-0 items-start rounded-md py-[3px] pr-2 transition-colors duration-100',
        open && 'hover:bg-[var(--basis-surface-hover)]',
      )}
      style={{ paddingLeft: `${pad}px` }}
    >
      {node.depth > 1 ? (
        <span
          aria-hidden
          className="absolute inset-y-0 w-px bg-[color-mix(in_srgb,var(--basis-text)_12%,transparent)]"
          style={{ left: `${pad - INDENT + 5}px` }}
        />
      ) : null}
      <span
        className={cn(
          'flex w-3 shrink-0 items-center justify-center',
          compact ? 'h-4' : 'h-[18px]',
        )}
      >
        <SubagentStateMark tone={node.tone} waitingOn={node.waitingOn} />
      </span>
      <span
        className={cn('ml-1.5 flex shrink-0 items-center', compact ? 'h-4' : 'h-[18px]')}
        title={node.providerId === 'agent' ? undefined : node.providerId}
      >
        <ProviderIcon
          providerId={node.providerId as ProviderId}
          className={cn('size-3', self ? 'opacity-90' : 'opacity-60')}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col pl-1.5">
        <span
          className={cn(
            'flex min-w-0 items-baseline gap-2',
            compact ? 'text-11-regular' : 'text-ui-sm',
          )}
        >
          {open ? (
            <button
              type="button"
              onClick={open}
              title={hover}
              className={cn(
                titleClass,
                'cursor-pointer outline-none after:absolute after:inset-0 after:rounded-md after:content-[""] focus-visible:underline',
              )}
            >
              {node.title}
            </button>
          ) : (
            <span className={titleClass} title={hover}>
              {node.title}
            </span>
          )}
          <span className="relative flex min-w-[3.5ch] shrink-0 items-center justify-end">
            {elapsed !== undefined ? (
              <span
                className={cn(
                  'text-ui-xs tabular-nums text-[var(--basis-text-faint)] transition-opacity duration-100',
                  stop && 'group-focus-within/row:opacity-0 group-hover/row:opacity-0',
                )}
              >
                {formatElapsed(elapsed)}
              </span>
            ) : null}
            {stop ? (
              <SubagentStopText
                onStop={stop}
                name={node.title}
                className="absolute right-0 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100"
              />
            ) : null}
          </span>
        </span>
        {line ? (
          <span
            className="min-w-0 truncate text-ui-xs leading-[15px]"
            style={{
              color:
                node.tone === 'waiting'
                  ? subagentStatusTextColor(status)
                  : 'var(--basis-text-muted)',
            }}
            title={line}
          >
            {line}
          </span>
        ) : null}
      </span>
    </div>
  )
}

// ─── Wide panes: the rail ───────────────────────────────────────────────────

/** The rail, at the right of a wide chat pane. Hosts place it beside `ChatView`. */
export function SessionSubagentRail() {
  const client = useEnvironmentClientOptional()
  return client ? <EnvironmentSubagentRail /> : null
}

/** Open it in the side panel, or on GitHub where no panel listens. */
function openPullRequest(pr: PullRequestSummary) {
  if (requestOpenPullRequest(pullRequestKey(pr))) return
  window.open(pr.url, '_blank', 'noopener,noreferrer')
}

function EnvironmentSubagentRail() {
  const { sessionId, lineage } = useSessionLineage()
  const rootSessionId = useEnvironmentState(selectRootSessionId)
  const pullRequests = useSessionPullRequests(null, rootSessionId)
  if (!sessionId) return null
  return (
    <SubagentRail
      key={sessionId}
      lineage={lineage}
      pullRequests={pullRequests}
      onOpenPullRequest={openPullRequest}
    />
  )
}

/**
 * The chat's right column: its pull requests, then every subagent it
 * started, in the order they started, nested under whoever started them.
 * It appears the first time the chat links a pull request or starts a
 * subagent and stays from then on at one width: nothing in it goes away
 * (finished subagents keep their row, merged pull requests theirs), so the
 * conversation beside it never moves again. Shown only where the pane is
 * wide enough (a container query on the pane); below that the strip above
 * the composer says how the subagents stand.
 */
export function SubagentRail({
  lineage,
  pullRequests = NO_PULL_REQUESTS,
  onOpenPullRequest,
}: {
  lineage: Lineage
  pullRequests?: readonly PullRequestSummary[]
  onOpenPullRequest?: (pr: PullRequestSummary) => void
}) {
  const hasContent = lineage.all.length > 0 || pullRequests.length > 0
  // Once shown, the column keeps its room even if what it listed is gone
  // for a moment (a reload, an unlinked pull request): no jump back.
  const [stuck, setStuck] = useState(hasContent)
  useEffect(() => {
    if (hasContent) setStuck(true)
  }, [hasContent])
  const shown = hasContent || stuck
  const paneRef = useRef<HTMLDivElement>(null)
  useRailRoom(paneRef, shown)
  const now = useTick(lineage.live.length > 0)
  const reduceMotion = useReducedMotion()
  const rows = lineageRows(lineage, true)
  const waiting = lineage.live.some((node) => node.tone === 'waiting')
  return (
    <div ref={paneRef} className="pointer-events-none absolute inset-0 z-10 @container/pane">
      {shown ? (
        <motion.aside
          key="rail"
          aria-label="Pull requests and subagents"
          data-subagent-rail={lineage.live.length > 0 ? 'live' : 'settled'}
          initial={reduceMotion ? false : { opacity: 0, x: 6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="custom-scrollbar pointer-events-auto absolute top-11 right-3 hidden max-h-[calc(100%-var(--chat-composer-height,8rem)-4rem)] w-64 flex-col overflow-x-hidden overflow-y-auto @min-[64rem]/pane:flex"
        >
          {pullRequests.length > 0 ? (
            <section aria-label="Pull requests" className="flex flex-col">
              <div className="px-2 pb-0.5 text-ui-xs text-[var(--basis-text-muted)]">
                Pull requests
              </div>
              {pullRequests.map((pr) => (
                <PullRequestRow key={pullRequestKey(pr)} pr={pr} onOpen={onOpenPullRequest} />
              ))}
            </section>
          ) : null}
          {rows.length > 0 ? (
            <section
              aria-label="Subagents"
              className={cn('flex flex-col', pullRequests.length > 0 && 'mt-2.5')}
            >
              <div className="flex items-baseline justify-between gap-3 px-2 pb-0.5 text-ui-xs whitespace-nowrap">
                <span className="text-[var(--basis-text-muted)]">Subagents</span>
                <span
                  className="truncate tabular-nums"
                  style={{
                    color: waiting
                      ? subagentStatusTextColor({ status: 'waiting' })
                      : 'var(--basis-text-faint)',
                  }}
                >
                  {lineageCounts(lineage)}
                </span>
              </div>
              <SubagentList rows={rows} now={now} />
            </section>
          ) : null}
        </motion.aside>
      ) : null}
    </div>
  )
}

const NO_PULL_REQUESTS: readonly PullRequestSummary[] = []

/** One linked pull request: its state's glyph, number and title; a cross if checks fail. */
function PullRequestRow({
  pr,
  onOpen,
}: {
  pr: PullRequestSummary
  onOpen?: (pr: PullRequestSummary) => void
}) {
  const meta = stateMeta(pr.state)
  const failing = pr.checks === 'failing'
  const title = pr.title?.trim() || pr.repository
  const label = `Pull request #${pr.number}, ${meta.label.toLowerCase()}${failing ? ', checks failing' : ''}: ${title}`
  const body = (
    <>
      <meta.Icon
        size={13}
        weight="bold"
        aria-hidden
        className="shrink-0"
        style={{ color: meta.color }}
      />
      <span className="shrink-0 text-ui-xs font-medium tabular-nums text-[var(--basis-text-muted)]">
        #{pr.number}
      </span>
      <span className="min-w-0 flex-1 truncate text-ui-sm leading-[18px] text-[var(--basis-text)]">
        {title}
      </span>
      {failing ? (
        <XIcon
          weight="bold"
          aria-hidden
          className="size-[10px] shrink-0"
          style={{ color: 'var(--basis-status-error)' }}
        />
      ) : null}
    </>
  )
  const className =
    'flex w-full min-w-0 items-center gap-1.5 rounded-md py-[3px] pr-2 pl-1.5 text-left'
  return onOpen ? (
    <button
      type="button"
      onClick={() => onOpen(pr)}
      aria-label={label}
      title={`${pr.repository}#${pr.number} · ${title}`}
      className={cn(
        className,
        'cursor-pointer outline-none transition-colors duration-100 hover:bg-[var(--basis-surface-hover)] focus-visible:outline-2 focus-visible:outline-ring',
      )}
    >
      {body}
    </button>
  ) : (
    <div aria-label={label} className={className}>
      {body}
    </div>
  )
}

/** The pane width the rail shows from: its `@min-[64rem]/pane` query, in rems. */
const RAIL_FROM_REM = 64
/** The room the rail takes at the pane's right: its 16rem, its inset, and a gap. */
export const RAIL_ROOM = '17rem'
/** Where the rail says how much room it takes, for the chat column (`.chat-column`). */
export const RAIL_ROOM_VAR = '--chat-rail-room'

/**
 * While the rail shows, and the pane is wide enough for it, say on the pane
 * how much room it takes, so the conversation and the composer move out of
 * its way rather than run under it.
 */
function useRailRoom(paneRef: React.RefObject<HTMLDivElement | null>, shown: boolean) {
  useLayoutEffect(() => {
    const pane = paneRef.current
    const host = pane?.parentElement
    if (!shown || !pane || !host) return
    const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const publish = () => {
      if (pane.clientWidth >= RAIL_FROM_REM * rem())
        host.style.setProperty(RAIL_ROOM_VAR, RAIL_ROOM)
      else host.style.removeProperty(RAIL_ROOM_VAR)
    }
    publish()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish)
    observer?.observe(pane)
    return () => {
      observer?.disconnect()
      host.style.removeProperty(RAIL_ROOM_VAR)
    }
  }, [paneRef, shown])
}

// ─── Narrower panes: the strip above the composer ───────────────────────────

/** The strip above the composer, for panes too narrow for the rail. */
export function SessionSubagentDock() {
  const client = useEnvironmentClientOptional()
  return client ? <EnvironmentSubagentDock /> : null
}

function EnvironmentSubagentDock() {
  const { sessionId, lineage } = useSessionLineage()
  if (!sessionId) return null
  return (
    // Where the pane is wide enough, the rail says this instead.
    <div className="@min-[64rem]/pane:hidden">
      <SubagentDock key={sessionId} lineage={lineage} />
    </div>
  )
}

/**
 * The strip: built like the background-tasks strip beside it (22rem, one
 * 28px row of 11px type, one glyph), opening upward into the list.
 */
export function SubagentDock({
  lineage,
  defaultOpen = false,
}: {
  lineage: Lineage
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [hovered, setHovered] = useState(false)
  const [showSettled, setShowSettled] = useState(false)
  const phase = useLineagePhase(lineage, open || hovered)
  const now = useTick(lineage.live.length > 0)
  const reduceMotion = useReducedMotion()
  const rows = lineagePhaseRows(lineage, phase, showSettled)
  const waiting = lineage.live.some((node) => node.tone === 'waiting')
  const settledShown = phase.kind === 'live' ? lineage.settled : 0
  const headline = lineageHeadline(lineage, phase)
  const failed = phase.kind === 'done' && headline.includes('failed')

  return (
    <AnimatePresence>
      {phase.kind === 'idle' ? null : (
        <motion.div
          key="strip"
          role="region"
          aria-label="Subagents"
          data-subagent-dock={open ? 'open' : 'folded'}
          initial={reduceMotion ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.4 } }}
          transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          className="mb-1.5 flex"
        >
          <div className="flex w-[22rem] max-w-full flex-col rounded-[14px] bg-float shadow-float-rest">
            <AnimatePresence initial={false}>
              {open ? (
                <motion.div
                  key="list"
                  id="subagent-strip-list"
                  initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
                  className="custom-scrollbar max-h-[min(40vh,15rem)] overflow-y-auto px-1 pt-1"
                >
                  <SubagentList rows={rows} now={now} compact />
                  {settledShown > 0 ? (
                    <button
                      type="button"
                      onClick={() => setShowSettled((value) => !value)}
                      className="cursor-pointer px-2 py-1 text-left text-11-regular text-[var(--basis-text-faint)] transition-colors hover:text-[var(--basis-text-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {showSettled ? 'Hide done' : `${settledShown} done`}
                    </button>
                  ) : null}
                </motion.div>
              ) : null}
            </AnimatePresence>
            <button
              type="button"
              aria-expanded={open}
              aria-controls="subagent-strip-list"
              onClick={() => setOpen((value) => !value)}
              className="flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-[14px] pl-2.5 pr-2 text-left outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="flex size-3 shrink-0 items-center justify-center">
                {phase.kind === 'done' ? (
                  <SubagentStatusGlyph
                    subagent={{ status: failed ? 'failed' : 'completed' }}
                    className="size-3"
                  />
                ) : (
                  <SessionBusyLoader tone={waiting ? 'needs' : 'working'} />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-11-regular leading-none text-[var(--basis-text)]">
                {phase.kind === 'done' ? headline : `Subagents · ${headline}`}
              </span>
              <CaretDownIcon
                aria-hidden
                className={cn(
                  'size-3 shrink-0 text-[var(--basis-text-faint)] transition-transform duration-200',
                  !open && 'rotate-180',
                )}
              />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
