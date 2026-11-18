import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import {
  CaretRightIcon,
  CheckIcon,
  CircleNotchIcon,
  StopIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { Subagent } from '@openmanager/protocol'
import { cn } from '../../lib/utils'
import { useEnvironmentClientOptional } from '../../providers/environment-client'
import { useViewActions } from '../../providers/view-actions'
import { Markdown } from '../markdown/Markdown'
import { ProviderIcon } from '../providers/ProviderIcon'
import type { ProviderIconId } from '../providers/providerIconId'
import { SessionBusyLoader } from '../sidebar/SessionBusyLoader'
import { Tooltip } from '../ui/Tooltip'
import { shimmerTextClass, shimmerTextStyle } from './ToolLine'
import {
  formatElapsed,
  providerName,
  resultPreview,
  subagentElapsedMs,
  subagentGroupSummary,
  subagentModelLabel,
  subagentName,
  subagentStatsLine,
  subagentStatusLabel,
  subagentTone,
  type SubagentPart,
} from './subagent-card'

/** The current time, ticking each second while `active`: a running card's clock. */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const WAITING_COLOR: Record<string, string> = {
  question: 'var(--basis-status-question)',
  permission: 'var(--basis-status-needs)',
  plan: 'var(--basis-status-needs)',
}

const waitingColor = (subagent: Subagent) =>
  WAITING_COLOR[subagent.waitingOn ?? 'permission'] ?? 'var(--basis-status-needs)'

/** The glyph at the head of a card: the sidebar's dots while live, a mark once settled. */
export function SubagentStatusGlyph({
  subagent,
  className,
}: {
  subagent: Pick<Subagent, 'status' | 'waitingOn'>
  className?: string
}) {
  const tone = subagentTone(subagent.status)
  const label = subagentStatusLabel(subagent)
  const box = cn('flex size-3.5 shrink-0 items-center justify-center', className)
  if (tone === 'running') {
    return (
      <span className={box} title={label}>
        <SessionBusyLoader tone="working" />
      </span>
    )
  }
  if (tone === 'waiting') {
    return (
      <span className={box} title={label}>
        <SessionBusyLoader tone={subagent.waitingOn === 'question' ? 'question' : 'needs'} />
      </span>
    )
  }
  const Mark = tone === 'done' ? CheckIcon : tone === 'failed' ? XIcon : StopIcon
  return (
    <span className={box} role="img" aria-label={label} title={label}>
      <Mark
        size={tone === 'stopped' ? 9 : 11}
        weight={tone === 'stopped' ? 'fill' : 'bold'}
        style={{
          color:
            tone === 'done'
              ? 'var(--basis-status-done)'
              : tone === 'failed'
                ? 'var(--basis-status-error)'
                : 'var(--basis-text-faint)',
        }}
      />
    </span>
  )
}

function Chip({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span
      className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-[var(--basis-surface-hover)] px-1.5 text-[11px] leading-none text-[var(--basis-text-muted)]"
      style={style}
    >
      {children}
    </span>
  )
}

const BACKGROUND_CHIP: CSSProperties = {
  color: 'var(--basis-status-background)',
  background: 'color-mix(in srgb, var(--basis-status-background) 13%, transparent)',
}

/** Where the card goes and how it stops, as the host offers them. */
function useSubagentActions(subagent: Subagent) {
  const { openChildSession } = useViewActions()
  const client = useEnvironmentClientOptional()
  const childId = subagent.childSessionId
  const open =
    childId && openChildSession
      ? () => void openChildSession(childId, subagent.parentSessionId).catch(() => undefined)
      : undefined
  const live = subagentTone(subagent.status) === 'running' || subagent.status === 'waiting'
  const stop =
    live && subagent.stoppable && client?.supports('stopSubagent')
      ? () =>
          client.commands.stopSubagent({
            sessionId: subagent.parentSessionId,
            subagentId: subagent.subagentId,
          })
      : undefined
  return { open, stop }
}

function StopButton({ onStop, name }: { onStop: () => Promise<void>; name: string }) {
  const [stopping, setStopping] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  return (
    <Tooltip content={failure ?? 'Stop this subagent'}>
      <button
        type="button"
        aria-label={`Stop ${name}`}
        disabled={stopping}
        onClick={(event) => {
          event.stopPropagation()
          setFailure(null)
          setStopping(true)
          onStop().catch((error: unknown) => {
            setFailure(
              error instanceof Error && error.message ? error.message : 'Couldn’t stop it.',
            )
            setStopping(false)
          })
        }}
        className={cn(
          'relative z-10 flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 text-[11px] leading-none',
          'bg-[var(--basis-canvas-bg)] text-[var(--basis-text-muted)] transition-[opacity,background-color,color] duration-100',
          'hover:text-[var(--basis-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
          'opacity-0 group-hover/subagent:opacity-100 focus-visible:opacity-100 disabled:cursor-default',
          (stopping || failure) && 'opacity-100',
          failure && 'text-[var(--basis-status-error)]',
        )}
      >
        {stopping ? (
          <CircleNotchIcon className="size-2.5 animate-spin" aria-hidden />
        ) : (
          <StopIcon className="size-2.5" weight="fill" aria-hidden />
        )}
        Stop
      </button>
    </Tooltip>
  )
}

/** The flag a waiting subagent raises: what it waits on, and where to answer. */
function WaitingFlag({ subagent, canOpen }: { subagent: Subagent; canOpen: boolean }) {
  const color = waitingColor(subagent)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span
        className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1.5 text-[11px] font-medium leading-none"
        style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
      >
        {subagentStatusLabel(subagent)}
      </span>
      {canOpen ? (
        <span className="truncate text-[var(--basis-text-faint)]">Open it to respond</span>
      ) : null}
    </span>
  )
}

/** The line under the identity: what it is doing, waiting on, or came to. */
function Detail({
  subagent,
  compact,
  canOpen,
  expanded,
  onToggle,
}: {
  subagent: Subagent
  compact: boolean
  canOpen: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const tone = subagentTone(subagent.status)
  if (tone === 'waiting') return <WaitingFlag subagent={subagent} canOpen={canOpen} />
  if (tone === 'running') {
    const activity = subagent.activity?.trim() || (subagent.status === 'pending' ? 'Starting' : '')
    if (!activity) return null
    return (
      <span className="block min-w-0 truncate" title={activity}>
        <span className={shimmerTextClass} style={shimmerTextStyle}>
          {activity}
        </span>
      </span>
    )
  }
  const reason = subagent.statusReason?.trim()
  const result = subagent.result?.trim()
  if (tone !== 'done' && reason) {
    return (
      <span
        className="block min-w-0 truncate"
        style={{ color: tone === 'failed' ? 'var(--basis-status-error)' : undefined }}
        title={reason}
      >
        {reason}
      </span>
    )
  }
  if (!result) return null
  if (compact) {
    return (
      <span className="block min-w-0 truncate text-[var(--basis-text-muted)]" title={result}>
        {resultPreview(result)}
      </span>
    )
  }
  return (
    <span className="block min-w-0">
      {expanded ? (
        <div className="custom-scrollbar relative z-10 -mx-1 mt-0.5 max-h-[320px] cursor-auto overflow-y-auto rounded-md bg-[var(--basis-canvas-bg)] px-2.5 py-2 text-ui-md text-[var(--basis-text)] [&_.md]:text-ui-md">
          <Markdown>{result}</Markdown>
        </div>
      ) : (
        <span className="line-clamp-2 text-[var(--basis-text-muted)]">{resultPreview(result)}</span>
      )}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        className="relative z-10 mt-1 cursor-pointer rounded text-[11px] text-[var(--basis-text-faint)] transition-colors hover:text-[var(--basis-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {expanded ? 'Show less' : 'Show result'}
      </button>
    </span>
  )
}

/**
 * One subagent the agent started, in place of the tool call that started it.
 * The whole card opens its child session; the result opens in place, and a
 * running one offers Stop on hover. `compact` is its row in a group: one line
 * of detail, no result to open.
 */
export function SubagentCard({ part, compact = false }: { part: SubagentPart; compact?: boolean }) {
  const subagent = part.subagent
  const tone = subagentTone(subagent.status)
  const live = tone === 'running' || tone === 'waiting'
  const now = useTick(live)
  const [expanded, setExpanded] = useState(false)
  const { open, stop } = useSubagentActions(subagent)
  const name = subagentName(subagent)
  const elapsed = subagentElapsedMs(subagent, now)
  const model = subagentModelLabel(subagent.modelId)
  const stats = subagentStatsLine(subagent.stats)
  const hasDetail =
    tone === 'waiting' ||
    (tone === 'running'
      ? Boolean(subagent.activity?.trim()) || subagent.status === 'pending'
      : Boolean(subagent.result?.trim() || (tone !== 'done' && subagent.statusReason?.trim())))
  const detail = !hasDetail ? null : (
    <Detail
      subagent={subagent}
      compact={compact}
      canOpen={Boolean(open)}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    />
  )
  const titleClass = cn(
    'min-w-0 truncate text-left text-ui-base leading-5',
    tone === 'stopped' ? 'text-[var(--basis-text-muted)]' : 'text-[var(--basis-text)]',
  )

  return (
    <div
      data-subagent={subagent.subagentId}
      data-subagent-status={subagent.status}
      className={cn(
        'group/subagent relative flex min-w-0 flex-col gap-0.5 transition-colors duration-100',
        compact
          ? 'px-3 py-2'
          : 'my-1.5 rounded-[10px] bg-[var(--basis-surface)] px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--basis-text)_4%,transparent)]',
        open &&
          'hover:bg-[var(--basis-surface-hover)] has-[[data-open]:focus-visible]:bg-[var(--basis-surface-hover)]',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <SubagentStatusGlyph subagent={subagent} />
        {open ? (
          <button
            type="button"
            data-open
            onClick={open}
            className={cn(
              titleClass,
              'cursor-pointer outline-none after:absolute after:inset-0 after:content-[""]',
              compact ? 'after:rounded-none' : 'after:rounded-[10px]',
            )}
            title={`Open ${name}`}
          >
            {name}
          </button>
        ) : (
          <span className={titleClass}>{name}</span>
        )}
        {subagent.agentType && subagent.agentType !== name ? (
          <Chip>{subagent.agentType}</Chip>
        ) : null}
        {subagent.background ? <Chip style={BACKGROUND_CHIP}>Background</Chip> : null}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[11px] leading-none tabular-nums text-[var(--basis-text-faint)]">
          {stop ? <StopButton onStop={stop} name={name} /> : null}
          {tone === 'failed' ? (
            <span style={{ color: 'var(--basis-status-error)' }}>Failed</span>
          ) : tone === 'stopped' ? (
            <span>{subagentStatusLabel(subagent)}</span>
          ) : null}
          {compact && subagent.stats.toolCalls !== undefined ? (
            <span>
              {subagent.stats.toolCalls === 1 ? '1 tool' : `${subagent.stats.toolCalls} tools`}
            </span>
          ) : null}
          {elapsed !== undefined ? <span>{formatElapsed(elapsed)}</span> : null}
          {open ? (
            <CaretRightIcon
              size={10}
              aria-hidden
              className="-mr-0.5 text-[var(--basis-text-faint)] transition-[opacity,transform] duration-150 group-hover/subagent:translate-x-0.5 group-hover/subagent:text-[var(--basis-text-muted)]"
            />
          ) : null}
        </span>
      </div>
      {compact ? (
        // One line under the name in a group: what it runs on, then what it
        // is doing or came to.
        <div className="flex min-w-0 items-center gap-1.5 pl-[22px] text-ui-sm leading-[18px] text-[var(--basis-text-faint)]">
          <ProviderIcon
            providerId={subagent.providerId as ProviderIconId}
            className="size-3 opacity-90"
          />
          <span className="shrink-0">{model ?? providerName(subagent.providerId)}</span>
          {detail ? (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0 flex-1">{detail}</span>
            </>
          ) : stats ? (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">{stats}</span>
            </>
          ) : null}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-1 pl-[22px] text-ui-sm leading-[18px] text-[var(--basis-text-faint)]">
          <span className="flex min-w-0 items-center gap-1.5">
            <ProviderIcon
              providerId={subagent.providerId as ProviderIconId}
              className="size-3 opacity-90"
            />
            <span className="min-w-0 truncate">
              {[model ?? providerName(subagent.providerId), stats || null]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          {detail}
        </div>
      )}
    </div>
  )
}

/**
 * Subagents the agent started back to back: one surface, a line saying how
 * they stand, and a compact row each.
 */
export function SubagentGroup({ parts }: { parts: SubagentPart[] }) {
  const summary = subagentGroupSummary(parts.map((part) => part.subagent))
  const failed = parts.some((part) => part.subagent.status === 'failed')
  return (
    <div
      role="group"
      aria-label={summary.title}
      className="my-1.5 overflow-hidden rounded-[10px] bg-[var(--basis-surface)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--basis-text)_4%,transparent)]"
    >
      <div className="flex h-8 items-center gap-2 px-3 text-ui-sm">
        <span className="flex size-3.5 items-center justify-center">
          {summary.running ? (
            <SessionBusyLoader tone="working" />
          ) : failed ? (
            <WarningCircleIcon size={12} style={{ color: 'var(--basis-status-error)' }} />
          ) : (
            <CheckIcon size={11} weight="bold" style={{ color: 'var(--basis-status-done)' }} />
          )}
        </span>
        <span className="font-medium text-[var(--basis-text-muted)]">{summary.title}</span>
        <span className="truncate text-[var(--basis-text-faint)]">{summary.detail}</span>
      </div>
      <div className="flex flex-col">
        {parts.map((part) => (
          <div
            key={part.id}
            className="relative before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-[color-mix(in_srgb,var(--basis-text)_5%,transparent)]"
          >
            <SubagentCard part={part} compact />
          </div>
        ))}
      </div>
    </div>
  )
}
