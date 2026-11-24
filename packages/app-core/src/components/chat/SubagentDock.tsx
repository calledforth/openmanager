import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CaretDownIcon } from '@phosphor-icons/react'
import type { Subagent } from '@openmanager/protocol'
import type { EnvironmentState } from '@openmanager/environment-client'
import { cn } from '../../lib/utils'
import {
  useEnvironmentClientOptional,
  useEnvironmentState,
} from '../../providers/environment-client'
import { useViewActions } from '../../providers/view-actions'
import { SessionBusyLoader } from '../sidebar/SessionBusyLoader'
import {
  SubagentStatusGlyph,
  SubagentStopText,
  subagentStatusTextColor,
  subagentToneColor,
  useTick,
} from '../parts/SubagentCard'
import {
  formatElapsed,
  subagentDetail,
  subagentElapsedMs,
  subagentWaitReason,
} from '../parts/subagent-card'
import { buildLineage, lineageRows, type Lineage, type LineageNode } from './subagent-lineage'

/**
 * The open chat's subagents while any of them works, wherever the chat pane
 * has room for them: on a wide pane (80rem and up) a frameless list in the
 * gutter at its right; on a narrower one a strip above the composer, beside
 * the background-tasks strip and built like it. Both draw the same list: a
 * subagent per row, nested ones indented under the one that started them.
 *
 * A subagent started turns ago, whose card has scrolled away, is the reason
 * this exists: without it nothing on screen said it still ran.
 *
 * When the last one finishes the list says "All N done" for a few seconds
 * and then fades, rather than vanishing under the reader; it never closes
 * while it is open or under the pointer.
 */

const selectSessions = (state: EnvironmentState) => state.sessions
const selectThreads = (state: EnvironmentState) => state.threads
const selectActive = (state: EnvironmentState) => state.activeSessionId

/** How long "All N done" stays before the list fades. */
export const ALL_DONE_LINGER_MS = 6_000

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

export type LineagePhase =
  { kind: 'idle' } | { kind: 'live' } | { kind: 'done'; keys: ReadonlySet<string> }

/**
 * Whether the list shows, and for which subagents: while any is live, and
 * for `ALL_DONE_LINGER_MS` after the last of a burst settles (longer while
 * `held`). The burst is every subagent seen live since the list last hid.
 */
export function useLineagePhase(lineage: Lineage, held: boolean): LineagePhase {
  const burst = useRef(new Set<string>())
  const [phase, setPhase] = useState<LineagePhase>({ kind: 'idle' })
  const live = lineage.live.length > 0
  useEffect(() => {
    if (live) {
      for (const node of lineage.live) burst.current.add(node.key)
      setPhase((current) => (current.kind === 'live' ? current : { kind: 'live' }))
      return
    }
    setPhase((current) =>
      current.kind === 'live' && burst.current.size > 0
        ? { kind: 'done', keys: new Set(burst.current) }
        : current,
    )
  }, [live, lineage])
  useEffect(() => {
    if (phase.kind !== 'done' || held) return
    const timer = setTimeout(() => {
      burst.current.clear()
      setPhase({ kind: 'idle' })
    }, ALL_DONE_LINGER_MS)
    return () => clearTimeout(timer)
  }, [phase, held])
  return phase
}

/** The rows a phase shows: live ones and their way up, or the burst that just ended. */
function rowsFor(lineage: Lineage, phase: LineagePhase, showSettled: boolean) {
  if (phase.kind === 'done') {
    return lineageRows(lineage, true).filter(({ node }) => phase.keys.has(node.key))
  }
  return lineageRows(lineage, showSettled)
}

/** "2 working · 1 needs you", or "All 3 done" once a burst has ended. */
export function lineageHeadline(lineage: Lineage, phase: LineagePhase): string {
  if (phase.kind === 'done') {
    const failed = lineage.all.filter(
      (node) => phase.keys.has(node.key) && node.tone === 'failed',
    ).length
    const count = phase.keys.size
    if (failed === 0) return count === 1 ? 'Subagent done' : `All ${count} done`
    return `${count - failed} done · ${failed} failed`
  }
  const waiting = lineage.live.filter((node) => node.tone === 'waiting').length
  const working = lineage.live.length - waiting
  return [
    working ? `${working} working` : '',
    waiting ? `${waiting} ${waiting === 1 ? 'needs' : 'need'} you` : '',
  ]
    .filter(Boolean)
    .join(' · ')
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

const INDENT = 14

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
  const detail =
    node.tone === 'waiting'
      ? subagentWaitReason(node.waitingOn)
      : node.tone === 'running' && record
        ? subagentDetail(record)
        : node.tone === 'failed'
          ? record?.statusReason?.trim() || 'Failed'
          : undefined
  const pad = 8 + (node.depth - 1) * INDENT
  const titleClass = cn(
    'min-w-0 flex-1 truncate text-left',
    compact ? 'text-11-regular leading-4' : 'text-ui-sm leading-[18px]',
    self ? 'text-[var(--basis-text)]' : 'text-[var(--basis-text-muted)]',
  )
  return (
    <div
      role="treeitem"
      aria-selected={false}
      aria-level={node.depth}
      data-lineage-node={node.key}
      data-lineage-status={node.status}
      className={cn(
        'group/row relative flex min-w-0 items-start rounded-md py-[5px] pr-2 transition-colors duration-100',
        open && 'hover:bg-[var(--basis-surface-hover)]',
      )}
      style={{ paddingLeft: `${pad}px` }}
    >
      {node.depth > 1 ? (
        <span
          aria-hidden
          className="absolute inset-y-0 w-px bg-[color-mix(in_srgb,var(--basis-text)_12%,transparent)]"
          style={{ left: `${pad - INDENT + 3}px` }}
        />
      ) : null}
      <span
        aria-hidden
        className={cn(
          'shrink-0 rounded-full',
          compact ? 'mt-[5px] size-1.5' : 'mt-[6px] size-[7px]',
          node.tone === 'waiting' && 'subagent-pulse',
          !self && 'opacity-55',
        )}
        style={{ background: subagentToneColor(status) }}
      />
      <span className="flex min-w-0 flex-1 flex-col pl-2">
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
              title={node.title}
              className={cn(
                titleClass,
                'cursor-pointer outline-none after:absolute after:inset-0 after:rounded-md after:content-[""] focus-visible:underline',
              )}
            >
              {node.title}
            </button>
          ) : (
            <span className={titleClass}>{node.title}</span>
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
        {detail ? (
          <span
            className="min-w-0 truncate text-ui-xs leading-4"
            style={{
              color:
                node.tone === 'waiting' || node.tone === 'failed'
                  ? subagentStatusTextColor(status)
                  : 'var(--basis-text-muted)',
            }}
            title={detail}
          >
            {detail}
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

function EnvironmentSubagentRail() {
  const { sessionId, lineage } = useSessionLineage()
  if (!sessionId) return null
  return <SubagentRail key={sessionId} lineage={lineage} />
}

/**
 * The rail: no frame, no badges, only words, dots and hairlines, in the
 * gutter the centred conversation leaves. Shown only where the pane is wide
 * enough for it (a container query on the pane); below that the strip says
 * the same above the composer.
 */
export function SubagentRail({ lineage }: { lineage: Lineage }) {
  const [hovered, setHovered] = useState(false)
  const [showSettled, setShowSettled] = useState(false)
  const phase = useLineagePhase(lineage, hovered)
  const now = useTick(lineage.live.length > 0)
  const reduceMotion = useReducedMotion()
  const rows = rowsFor(lineage, phase, showSettled)
  const settledShown = phase.kind === 'live' ? lineage.settled : 0
  const waiting = lineage.live.some((node) => node.tone === 'waiting')
  return (
    <div className="pointer-events-none absolute inset-0 z-10 @container/pane">
      <AnimatePresence>
        {phase.kind === 'idle' ? null : (
          <motion.aside
            key="rail"
            aria-label="Subagents"
            data-subagent-rail={phase.kind}
            initial={reduceMotion ? false : { opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.4 } }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            className="custom-scrollbar pointer-events-auto absolute top-11 right-3 hidden max-h-[calc(100%-var(--chat-composer-height,8rem)-4rem)] w-60 flex-col overflow-x-hidden overflow-y-auto @min-[80rem]/pane:flex"
          >
            <div className="flex items-baseline justify-between gap-3 px-2 pb-1 text-ui-xs whitespace-nowrap">
              <span className="text-[var(--basis-text-muted)]">Subagents</span>
              <span
                className="truncate tabular-nums"
                style={{
                  color: waiting
                    ? subagentStatusTextColor({ status: 'waiting' })
                    : 'var(--basis-text-faint)',
                }}
              >
                {lineageHeadline(lineage, phase)}
              </span>
            </div>
            <SubagentList rows={rows} now={now} />
            {settledShown > 0 ? (
              <span className="mt-0.5 self-start text-ui-xs">
                <button
                  type="button"
                  onClick={() => setShowSettled((value) => !value)}
                  className="cursor-pointer rounded-md px-2 py-1 text-left text-[var(--basis-text-faint)] transition-colors hover:text-[var(--basis-text-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {showSettled ? 'Hide done' : `${settledShown} done`}
                </button>
              </span>
            ) : null}
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  )
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
    <div className="@min-[80rem]/pane:hidden">
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
  const rows = rowsFor(lineage, phase, showSettled)
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
