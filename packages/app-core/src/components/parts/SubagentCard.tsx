import { useEffect, useId, useState } from 'react'
import { CaretRightIcon, CheckIcon, CircleNotchIcon, StopIcon, XIcon } from '@phosphor-icons/react'
import type { ProviderId } from '@agentpack/contract'
import type { Subagent } from '@openmanager/protocol'
import { cn } from '../../lib/utils'
import { useEnvironmentClientOptional } from '../../providers/environment-client'
import { useViewActions } from '../../providers/view-actions'
import { ProviderIcon } from '../providers/ProviderIcon'
import { SessionBusyLoader } from '../sidebar/SessionBusyLoader'
import { Tooltip } from '../ui/Tooltip'
import {
  formatElapsed,
  providerName,
  subagentElapsedMs,
  subagentGroupSummary,
  subagentModelLabel,
  subagentName,
  subagentStatusLabel,
  subagentTone,
  subagentToolCount,
  type SubagentPart,
} from './subagent-card'

/** The current time, ticking each second while `active`: a running card's clock. */
export function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** The colour a status is said in, where it is said at all. */
export function subagentStatusColor(
  subagent: Pick<Subagent, 'status' | 'waitingOn'>,
): string | undefined {
  switch (subagentTone(subagent.status)) {
    case 'waiting':
      return subagent.waitingOn === 'question'
        ? 'var(--basis-status-question)'
        : 'var(--basis-status-needs)'
    case 'failed':
      return 'var(--basis-status-error)'
    case 'done':
      return 'var(--basis-status-done)'
    default:
      return undefined
  }
}

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
        style={{ color: subagentStatusColor(subagent) ?? 'var(--basis-text-faint)' }}
      />
    </span>
  )
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

/**
 * Stop, over the end of the row while it is hovered or focused, so it takes
 * no room the rest of the time.
 */
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
          'absolute inset-y-0 right-1.5 z-10 my-auto flex h-5 cursor-pointer items-center gap-1 rounded-full px-2 text-ui-xs leading-none',
          'bg-[var(--basis-canvas-bg)] text-[var(--basis-text-muted)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--basis-text)_8%,transparent)]',
          'transition-[opacity,color] duration-100 hover:text-[var(--basis-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
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

/**
 * A status worth flagging in the row: a subagent waiting on someone, one
 * that failed or was stopped. Running and done say it with the glyph alone.
 */
function StatusFlag({ subagent }: { subagent: Subagent }) {
  const tone = subagentTone(subagent.status)
  if (tone === 'running' || tone === 'done') return null
  const label = subagentStatusLabel(subagent)
  const reason = subagent.statusReason?.trim()
  if (tone === 'stopped') {
    return (
      <span className="shrink-0 text-[var(--basis-text-faint)]" title={reason || undefined}>
        {label}
      </span>
    )
  }
  const color = subagentStatusColor(subagent)!
  return (
    <span
      className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1.5 text-ui-xs font-medium leading-none"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
      title={reason || undefined}
    >
      {label}
    </span>
  )
}

const SURFACE =
  'rounded-[10px] bg-[var(--basis-surface)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--basis-text)_4%,transparent)]'

/**
 * One subagent the agent started, in place of the tool call that started it:
 * one row saying who it is, what it runs on and how it stands. The whole row
 * opens its child session, where its work and answer are; a live one offers
 * Stop on hover.
 */
export function SubagentCard({ part, className }: { part: SubagentPart; className?: string }) {
  const subagent = part.subagent
  const tone = subagentTone(subagent.status)
  const live = tone === 'running' || tone === 'waiting'
  const now = useTick(live)
  const { open, stop } = useSubagentActions(subagent)
  const name = subagentName(subagent)
  const elapsed = subagentElapsedMs(subagent, now)
  const model = subagentModelLabel(subagent.modelId) ?? providerName(subagent.providerId)
  const tools = subagentToolCount(subagent.stats)
  const titleClass = cn(
    'min-w-0 truncate text-left text-ui-md leading-5',
    tone === 'stopped' ? 'text-[var(--basis-text-muted)]' : 'text-[var(--basis-text)]',
  )

  return (
    <div
      data-subagent={subagent.subagentId}
      data-subagent-status={subagent.status}
      className={cn(
        'group/subagent relative flex h-8 min-w-0 items-center gap-2 pl-2.5 pr-3 transition-colors duration-100',
        SURFACE,
        open &&
          'hover:bg-[var(--basis-surface-hover)] has-[[data-open]:focus-visible]:bg-[var(--basis-surface-hover)]',
        className,
      )}
    >
      <SubagentStatusGlyph subagent={subagent} />
      <span className="flex min-w-0 items-baseline gap-2">
        {open ? (
          <button
            type="button"
            data-open
            onClick={open}
            className={cn(
              titleClass,
              'cursor-pointer outline-none after:absolute after:inset-0 after:rounded-[10px] after:content-[""]',
            )}
            title={`Open ${name}`}
          >
            {name}
          </button>
        ) : (
          <span className={titleClass} title={name}>
            {name}
          </span>
        )}
        {subagent.agentType && subagent.agentType !== name ? (
          <span className="shrink-0 text-ui-sm text-[var(--basis-text-faint)]">
            {subagent.agentType}
          </span>
        ) : null}
      </span>
      <span className="relative ml-auto flex shrink-0 items-center gap-2 pl-2 text-ui-sm leading-none tabular-nums text-[var(--basis-text-faint)]">
        <StatusFlag subagent={subagent} />
        <span className="flex max-w-[11rem] min-w-0 items-center gap-1.5 max-sm:hidden">
          <ProviderIcon
            providerId={subagent.providerId as ProviderId}
            className="size-3 shrink-0 opacity-90"
          />
          <span className="truncate">{model}</span>
        </span>
        {tools ? <span className="max-sm:hidden">{tools}</span> : null}
        {elapsed !== undefined ? (
          <span className="min-w-[2ch] text-right">{formatElapsed(elapsed)}</span>
        ) : null}
      </span>
      {stop ? <StopButton onStop={stop} name={name} /> : null}
    </div>
  )
}

/** How many chips a folded group shows before the rest become "+N". */
const STACK_MAX = 4

/**
 * What a folded group runs on: a chip per subagent, each tucked a little
 * under the next, the way avatars stack. Hovering one names it.
 */
function ProviderStack({ subagents }: { subagents: readonly Subagent[] }) {
  const shown = subagents.slice(0, STACK_MAX)
  const rest = subagents.length - shown.length
  const chip =
    'relative flex size-[22px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--basis-text)_9%,var(--basis-surface))] ring-2 ring-[var(--basis-surface)] transition-[box-shadow] duration-100 group-hover/header:ring-[var(--basis-surface-hover)]'
  return (
    <span aria-hidden className="flex shrink-0 items-center -space-x-1">
      {shown.map((subagent) => (
        <span
          key={subagent.subagentId}
          className={chip}
          title={`${subagentName(subagent)} · ${providerName(subagent.providerId)} · ${subagentStatusLabel(subagent)}`}
        >
          <ProviderIcon providerId={subagent.providerId as ProviderId} className="size-[11px]" />
        </span>
      ))}
      {rest > 0 ? (
        <span
          className={cn(
            chip,
            'text-[10px] font-medium tabular-nums text-[var(--basis-text-muted)]',
          )}
          title={subagents
            .slice(STACK_MAX)
            .map((subagent) => subagentName(subagent))
            .join(', ')}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  )
}

/** A folded group's live mark: working while any runs, the ask while any waits. */
function GroupActivity({ subagents }: { subagents: readonly Subagent[] }) {
  const waiting = subagents.find((subagent) => subagent.status === 'waiting')
  if (waiting) {
    return (
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <SessionBusyLoader tone={waiting.waitingOn === 'question' ? 'question' : 'needs'} />
      </span>
    )
  }
  if (subagents.some((subagent) => subagentTone(subagent.status) === 'running')) {
    return (
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <SessionBusyLoader tone="working" />
      </span>
    )
  }
  return null
}

/**
 * Subagents the agent started back to back. Folded, one row: what they run
 * on as a stack of provider chips, how many, and how they stand. Unfolded, a
 * card each, stacked under that header.
 */
export function SubagentGroup({
  parts,
  defaultOpen = false,
}: {
  parts: SubagentPart[]
  /** For stories and tests; the chat always starts a group folded. */
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const listId = useId()
  const subagents = parts.map((part) => part.subagent)
  const summary = subagentGroupSummary(subagents)
  const toggle = () => setOpen((value) => !value)
  return (
    <div
      role="group"
      aria-label={summary.title}
      data-subagent-group={open ? 'open' : 'folded'}
      className="my-1.5 flex flex-col gap-1"
    >
      <div
        className={cn(
          'group/header relative flex transition-colors duration-100 hover:bg-[var(--basis-surface-hover)] has-[button:focus-visible]:bg-[var(--basis-surface-hover)]',
          SURFACE,
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={toggle}
          className="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 pl-2 pr-3 text-left outline-none after:absolute after:inset-0 after:rounded-[10px] after:content-['']"
        >
          <ProviderStack subagents={subagents} />
          <span className="ml-0.5 shrink-0 text-ui-md leading-5 text-[var(--basis-text)]">
            {summary.title}
          </span>
          <span aria-hidden className="text-ui-sm text-[var(--basis-text-faint)]">
            ·
          </span>
          <GroupActivity subagents={subagents} />
          <span className="min-w-0 truncate text-ui-sm text-[var(--basis-text-muted)]">
            {summary.detail}
          </span>
          <CaretRightIcon
            size={11}
            aria-hidden
            className={cn(
              'ml-auto shrink-0 text-[var(--basis-text-faint)] transition-transform duration-150 group-hover/header:text-[var(--basis-text-muted)]',
              open && 'rotate-90',
            )}
          />
        </button>
      </div>
      {open ? (
        <div id={listId} className="flex flex-col gap-1">
          {parts.map((part) => (
            <SubagentCard key={part.id} part={part} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
