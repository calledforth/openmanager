import { useMemo, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CaretUpIcon, CircleNotchIcon, StopIcon, TreeStructureIcon } from '@phosphor-icons/react'
import type { ProviderId } from '@agentpack/contract'
import type { Subagent } from '@openmanager/protocol'
import type { EnvironmentState } from '@openmanager/environment-client'
import { cn } from '../../lib/utils'
import {
  useEnvironmentClientOptional,
  useEnvironmentState,
} from '../../providers/environment-client'
import { useViewActions } from '../../providers/view-actions'
import { ProviderIcon } from '../providers/ProviderIcon'
import { Tooltip } from '../ui/Tooltip'
import {
  SubagentAvatar,
  SubagentStatusPill,
  subagentToneColor,
  useTick,
} from '../parts/SubagentCard'
import {
  formatElapsed,
  providerName,
  subagentDetail,
  subagentElapsedMs,
} from '../parts/subagent-card'
import {
  buildLineage,
  lineageRows,
  lineageSummary,
  type Lineage,
  type LineageNode,
} from './subagent-lineage'

/**
 * The open session's subagents while any of them works: a pill just above
 * the composer, so a subagent started turns ago (whose card has long since
 * scrolled away) still shows it is running. Opened, it is the family tree:
 * the chat at the top, the subagents it started under it, and theirs under
 * them, each one click from its page and, while it runs, from Stop.
 */
export function SessionSubagentDock() {
  const client = useEnvironmentClientOptional()
  return client ? <EnvironmentSubagentDock /> : null
}

const selectSessions = (state: EnvironmentState) => state.sessions
const selectThreads = (state: EnvironmentState) => state.threads
const selectActive = (state: EnvironmentState) => state.activeSessionId

function EnvironmentSubagentDock() {
  const sessionId = useEnvironmentState(selectActive)
  const sessions = useEnvironmentState(selectSessions)
  const threads = useEnvironmentState(selectThreads)
  const lineage = useMemo(
    () => buildLineage(sessionId, sessions, (threadId) => threads[threadId]?.subagents),
    [sessionId, sessions, threads],
  )
  if (!sessionId || lineage.live.length === 0) return null
  const root = sessions[sessionId]!
  return (
    <SubagentDock
      // Per session: one chat's open tree must not open the next one's.
      key={sessionId}
      lineage={lineage}
      rootTitle={root.title?.trim() || 'This chat'}
      rootProviderId={root.providerId}
    />
  )
}

/** The dock itself, given its tree: for hosts and stories that build one. */
export function SubagentDock({
  lineage,
  rootTitle,
  rootProviderId,
  defaultOpen = false,
}: {
  lineage: Lineage
  rootTitle: string
  rootProviderId: string
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [showSettled, setShowSettled] = useState(false)
  const reduceMotion = useReducedMotion()
  const now = useTick(lineage.live.length > 0)
  const summary = lineageSummary(lineage)
  const rows = lineageRows(lineage, showSettled)
  const waiting = lineage.live.some((node) => node.tone === 'waiting')
  const tone = waiting ? 'var(--basis-status-needs)' : 'var(--basis-status-working)'

  return (
    <motion.div
      role="region"
      aria-label="Subagents"
      data-subagent-dock={open ? 'open' : 'folded'}
      initial={reduceMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
      className="mb-1.5 flex"
    >
      <motion.div
        layout={!reduceMotion}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          'relative flex max-w-full flex-col overflow-hidden rounded-[16px] bg-float shadow-float-rest',
          open ? 'w-[34rem]' : 'w-auto',
        )}
      >
        <AnimatePresence initial={false}>
          {open ? (
            <motion.div
              key="tree"
              id="subagent-dock-tree"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="custom-scrollbar max-h-[min(50vh,22rem)] overflow-y-auto px-1.5 pt-1.5">
                <div className="flex h-8 items-center gap-2 px-2 text-ui-xs font-medium tracking-wide text-[var(--basis-text-faint)] uppercase">
                  <TreeStructureIcon size={12} weight="bold" aria-hidden />
                  Lineage
                </div>
                <RootRow title={rootTitle} providerId={rootProviderId} />
                <div role="tree" aria-label="Subagents of this chat" className="flex flex-col">
                  {rows.map(({ node, last, rails }) => (
                    <LineageRow key={node.key} node={node} last={last} rails={rails} now={now} />
                  ))}
                </div>
                {lineage.settled > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowSettled((value) => !value)}
                    className="mt-0.5 mb-1 ml-2 flex h-7 cursor-pointer items-center rounded-md px-1.5 text-ui-xs text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {showSettled ? 'Hide finished' : `Show ${lineage.settled} finished`}
                  </button>
                ) : null}
              </div>
              <div className="mx-3 h-px bg-[color-mix(in_srgb,var(--basis-text)_8%,transparent)]" />
            </motion.div>
          ) : null}
        </AnimatePresence>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="subagent-dock-tree"
          onClick={() => setOpen((value) => !value)}
          className="flex h-9 min-w-0 cursor-pointer items-center gap-2 pl-2 pr-3 text-left outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <LiveStack nodes={lineage.live} />
          <span className="shrink-0 text-ui-sm font-medium leading-none text-[var(--basis-text)]">
            {summary.title}
          </span>
          {summary.detail ? (
            <span className="min-w-0 truncate text-ui-sm leading-none text-[var(--basis-text-muted)]">
              {summary.detail}
            </span>
          ) : null}
          <CaretUpIcon
            size={11}
            weight="bold"
            aria-hidden
            className={cn(
              'ml-auto shrink-0 text-[var(--basis-text-faint)] transition-transform duration-200',
              open && 'rotate-180',
            )}
          />
        </button>
        <span
          aria-hidden
          className="subagent-rail pointer-events-none absolute inset-x-0 bottom-0 h-[2px]"
          style={{ '--subagent-tone': tone } as CSSProperties}
        />
      </motion.div>
    </motion.div>
  )
}

/** Up to three live subagents' tiles, overlapped; a count past that. */
function LiveStack({ nodes }: { nodes: readonly LineageNode[] }) {
  const shown = nodes.slice(0, 3)
  const rest = nodes.length - shown.length
  return (
    <span aria-hidden className="flex shrink-0 items-center -space-x-1.5">
      {shown.map((node) => (
        <span
          key={node.key}
          className="relative flex size-6 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--basis-text)_9%,var(--basis-surface))] ring-2 ring-[var(--float-bg)]"
          title={node.title}
        >
          <ProviderIcon providerId={node.providerId as ProviderId} className="size-3" />
          <span
            className="subagent-pulse absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-[var(--float-bg)]"
            style={{ background: subagentToneColor(node) }}
          />
        </span>
      ))}
      {rest > 0 ? (
        <span className="relative flex size-6 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--basis-text)_9%,var(--basis-surface))] text-[10px] font-medium tabular-nums text-[var(--basis-text-muted)] ring-2 ring-[var(--float-bg)]">
          +{rest}
        </span>
      ) : null}
    </span>
  )
}

/** The chat the tree grows from. */
function RootRow({ title, providerId }: { title: string; providerId: string }) {
  return (
    <div className="relative flex h-9 min-w-0 items-center gap-2.5 px-2">
      <span aria-hidden className={cn('absolute bottom-0 left-[20px] h-[6px] w-px', LINE)} />
      <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-[color-mix(in_srgb,var(--basis-text)_12%,var(--basis-surface))]">
        <ProviderIcon providerId={providerId as ProviderId} className="size-3" />
      </span>
      <span className="min-w-0 truncate text-ui-sm font-medium text-[var(--basis-text)]">
        {title}
      </span>
      <span className="shrink-0 text-ui-xs text-[var(--basis-text-faint)]">
        {providerName(providerId)} · this chat
      </span>
    </div>
  )
}

const LINE = 'bg-[color-mix(in_srgb,var(--basis-text)_16%,transparent)]'

/**
 * The connectors in front of a row: a rail for each ancestor that has more
 * siblings below, then this row's own elbow. Each column is as wide as a
 * tile, so a rail runs straight down from the centre of its parent's tile.
 */
function Connectors({ rails, last }: { rails: boolean[]; last: boolean }) {
  return (
    <span aria-hidden className="flex shrink-0 self-stretch">
      {rails.map((rail, index) => (
        <span key={index} className="relative w-6">
          {rail ? <span className={cn('absolute inset-y-0 left-1/2 w-px', LINE)} /> : null}
        </span>
      ))}
      <span className="relative w-6">
        <span className={cn('absolute top-0 left-1/2 w-px', LINE, last ? 'h-1/2' : 'h-full')} />
        <span className={cn('absolute top-1/2 left-1/2 h-px w-3', LINE)} />
      </span>
    </span>
  )
}

function LineageRow({
  node,
  last,
  rails,
  now,
}: {
  node: LineageNode
  last: boolean
  rails: boolean[]
  now: number
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
  const detail = record ? subagentDetail(record) : undefined
  const elapsed = record ? subagentElapsedMs(record, now) : undefined
  const avatar: Pick<Subagent, 'status' | 'waitingOn' | 'providerId'> = {
    status: node.status,
    providerId: node.providerId,
    ...(node.waitingOn ? { waitingOn: node.waitingOn } : {}),
  }
  const flag = node.tone !== 'running' && node.tone !== 'done'
  return (
    <div
      role="treeitem"
      aria-selected={false}
      aria-level={node.depth}
      data-lineage-node={node.key}
      data-lineage-status={node.status}
      className={cn(
        'group/row relative flex h-11 min-w-0 items-stretch rounded-[10px] pl-2 pr-1.5 transition-colors duration-100',
        open && 'hover:bg-[var(--basis-surface-hover)]',
        !self && 'opacity-70 hover:opacity-100',
      )}
    >
      <Connectors rails={rails} last={last} />
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <SubagentAvatar subagent={avatar} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          {open ? (
            <button
              type="button"
              onClick={open}
              title={`Open ${node.title}`}
              className="min-w-0 cursor-pointer truncate text-left text-ui-sm leading-4 text-[var(--basis-text)] outline-none after:absolute after:inset-0 after:rounded-[10px] after:content-[''] focus-visible:underline"
            >
              {node.title}
            </button>
          ) : (
            <span className="min-w-0 truncate text-ui-sm leading-4 text-[var(--basis-text)]">
              {node.title}
            </span>
          )}
          {detail ? (
            <span className="min-w-0 truncate text-ui-xs leading-4 text-[var(--basis-text-faint)]">
              {detail}
            </span>
          ) : null}
        </span>
        <span className="relative z-10 flex shrink-0 items-center gap-2 text-ui-xs tabular-nums text-[var(--basis-text-faint)]">
          {flag ? (
            <SubagentStatusPill
              subagent={{
                ...avatar,
                ...(record?.statusReason ? { statusReason: record.statusReason } : {}),
              }}
            />
          ) : null}
          <span className="max-sm:hidden">{providerName(node.providerId)}</span>
          {elapsed !== undefined ? (
            <span className="min-w-[3ch] text-right">{formatElapsed(elapsed)}</span>
          ) : null}
          {stop ? (
            <RowStop onStop={stop} name={node.title} />
          ) : (
            <span aria-hidden className="size-6" />
          )}
        </span>
      </span>
    </div>
  )
}

function RowStop({ onStop, name }: { onStop: () => Promise<void>; name: string }) {
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <Tooltip content={failed ? 'Couldn’t stop it' : 'Stop'}>
      <button
        type="button"
        aria-label={`Stop ${name}`}
        disabled={stopping}
        onClick={(event) => {
          event.stopPropagation()
          setFailed(false)
          setStopping(true)
          onStop().catch(() => {
            setFailed(true)
            setStopping(false)
          })
        }}
        className={cn(
          'flex size-6 cursor-pointer items-center justify-center rounded-full text-[var(--basis-text-muted)] transition-[opacity,color,background-color] duration-100 hover:bg-[color-mix(in_srgb,var(--basis-status-error)_14%,transparent)] hover:text-[var(--basis-status-error)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
          'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
          (stopping || failed) && 'opacity-100',
          failed && 'text-[var(--basis-status-error)]',
        )}
      >
        {stopping ? (
          <CircleNotchIcon className="size-3 animate-spin" aria-hidden />
        ) : (
          <StopIcon className="size-2.5" weight="fill" aria-hidden />
        )}
      </button>
    </Tooltip>
  )
}
