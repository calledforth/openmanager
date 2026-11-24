import { useEffect, useId, useState, type CSSProperties } from 'react'
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
  subagentDetail,
  subagentName,
  subagentStatusLabel,
  subagentTone,
  subagentToolCount,
  type SubagentPart,
  type SubagentTone,
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

/** Stop, at the card's corner while it is hovered or focused, so it takes no room the rest of the time. */
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
          'relative z-10 flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-ui-xs leading-none',
          'bg-[var(--basis-canvas-bg)] text-[var(--basis-text-muted)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--basis-text)_10%,transparent)]',
          'transition-[opacity,color,background-color] duration-150 hover:bg-[color-mix(in_srgb,var(--basis-status-error)_12%,var(--basis-canvas-bg))] hover:text-[var(--basis-status-error)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
          'w-0 overflow-hidden px-0 opacity-0 group-hover/subagent:w-auto group-hover/subagent:px-2.5 group-hover/subagent:opacity-100 focus-visible:w-auto focus-visible:px-2.5 focus-visible:opacity-100 disabled:cursor-default',
          (stopping || failure) && 'w-auto px-2.5 opacity-100',
          failure && 'text-[var(--basis-status-error)]',
        )}
      >
        {stopping ? (
          <CircleNotchIcon className="size-2.5 animate-spin" aria-hidden />
        ) : (
          <StopIcon className="size-2.5" weight="fill" aria-hidden />
        )}
        {stopping ? 'Stopping' : 'Stop'}
      </button>
    </Tooltip>
  )
}

/** The colour a tone is drawn in where every tone needs one (pills, the group's bar). */
export function subagentToneColor(subagent: Pick<Subagent, 'status' | 'waitingOn'>): string {
  return subagentTone(subagent.status) === 'running'
    ? 'var(--basis-status-working)'
    : (subagentStatusColor(subagent) ?? 'var(--basis-text-faint)')
}

/**
 * The status in a pill: a dot and a word, tinted by how it stands. A failed
 * or stopped one carries why on hover.
 */
export function SubagentStatusPill({
  subagent,
  className,
}: {
  subagent: Pick<Subagent, 'status' | 'waitingOn' | 'statusReason'>
  className?: string
}) {
  const tone = subagentTone(subagent.status)
  const color = subagentToneColor(subagent)
  const reason = subagent.statusReason?.trim()
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full pl-1.5 pr-2 text-ui-xs font-medium leading-none',
        className,
      )}
      style={{
        color: tone === 'stopped' ? 'var(--basis-text-muted)' : color,
        background: `color-mix(in srgb, ${color} ${tone === 'stopped' ? 10 : 14}%, transparent)`,
      }}
      title={reason || undefined}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          (tone === 'running' || tone === 'waiting') && 'subagent-pulse',
        )}
        style={{ background: color }}
      />
      {subagentStatusLabel(subagent)}
    </span>
  )
}

/**
 * The provider's mark on a tile, with how the subagent stands badged at its
 * corner: a spinner while it works, a mark once it settles.
 */
export function SubagentAvatar({
  subagent,
  size = 'md',
}: {
  subagent: Pick<Subagent, 'status' | 'waitingOn' | 'providerId'>
  size?: 'sm' | 'md'
}) {
  const tone = subagentTone(subagent.status)
  const live = tone === 'running' || tone === 'waiting'
  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-[9px] bg-[color-mix(in_srgb,var(--basis-text)_7%,var(--basis-surface))] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--basis-text)_6%,transparent)]',
        size === 'md' ? 'size-8' : 'size-6 rounded-[7px]',
        live && 'subagent-avatar-live',
      )}
      style={
        live ? ({ '--subagent-tone': subagentToneColor(subagent) } as CSSProperties) : undefined
      }
    >
      <ProviderIcon
        providerId={subagent.providerId as ProviderId}
        className={size === 'md' ? 'size-4' : 'size-3'}
      />
      <span
        className={cn(
          'absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-[var(--basis-canvas-bg)]',
          size === 'md' ? 'size-[15px]' : 'size-[13px]',
        )}
      >
        <SubagentStatusGlyph subagent={subagent} className="size-3" />
      </span>
    </span>
  )
}

const SURFACE =
  'rounded-xl bg-[var(--basis-surface)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--basis-text)_6%,transparent)]'

/**
 * One subagent the agent started, in place of the tool call that started it.
 * Two lines: who it is and what it runs on, then what it is doing now (or
 * how it ended), with its status and clock at the side. The whole card opens
 * its child session, where its work and answer are; a live one offers Stop
 * on hover and draws a moving rail along its foot.
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
  const detail = subagentDetail(subagent)
  const titleClass = cn(
    'min-w-0 truncate text-left text-ui-md font-medium leading-5',
    tone === 'stopped' ? 'text-[var(--basis-text-muted)]' : 'text-[var(--basis-text)]',
  )

  return (
    <div
      data-subagent={subagent.subagentId}
      data-subagent-status={subagent.status}
      className={cn(
        'group/subagent relative flex min-h-[58px] min-w-0 items-center gap-3 overflow-hidden py-2.5 pl-3 pr-3 transition-[background-color,box-shadow] duration-150',
        SURFACE,
        open &&
          'hover:bg-[var(--basis-surface-hover)] hover:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--basis-text)_10%,transparent),0_4px_14px_-8px_rgb(0_0_0/0.45)] has-[[data-open]:focus-visible]:bg-[var(--basis-surface-hover)]',
        className,
      )}
    >
      <SubagentAvatar subagent={subagent} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          {open ? (
            <button
              type="button"
              data-open
              onClick={open}
              className={cn(
                titleClass,
                'cursor-pointer outline-none after:absolute after:inset-0 after:rounded-xl after:content-[""]',
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
            <span className="inline-flex h-[18px] shrink-0 items-center rounded-md bg-[color-mix(in_srgb,var(--basis-text)_6%,transparent)] px-1.5 text-ui-xs leading-none text-[var(--basis-text-muted)]">
              {subagent.agentType}
            </span>
          ) : null}
        </span>
        {detail ? (
          <span
            className={cn(
              'min-w-0 truncate text-ui-sm leading-4',
              tone === 'running'
                ? 'text-[var(--basis-text-muted)]'
                : tone === 'failed'
                  ? 'text-[color-mix(in_srgb,var(--basis-status-error)_55%,var(--basis-text-muted))]'
                  : 'text-[var(--basis-text-faint)]',
            )}
            title={detail}
          >
            {detail}
          </span>
        ) : null}
      </span>
      <span className="relative flex shrink-0 flex-col items-end gap-1 pl-2">
        <span className="flex items-center gap-1.5">
          {stop ? <StopButton onStop={stop} name={name} /> : null}
          <SubagentStatusPill subagent={subagent} />
        </span>
        <span className="flex max-w-[16rem] min-w-0 items-center gap-1.5 text-ui-xs leading-4 tabular-nums text-[var(--basis-text-faint)]">
          <span className="truncate max-sm:hidden">{model}</span>
          {tools ? (
            <>
              <span aria-hidden className="max-sm:hidden">
                ·
              </span>
              <span className="shrink-0 max-sm:hidden">{tools}</span>
            </>
          ) : null}
          {elapsed !== undefined ? (
            <>
              <span aria-hidden className="max-sm:hidden">
                ·
              </span>
              <span className="min-w-[2ch] shrink-0 text-right">{formatElapsed(elapsed)}</span>
            </>
          ) : null}
        </span>
      </span>
      {live ? (
        <span
          aria-hidden
          className="subagent-rail pointer-events-none absolute inset-x-0 bottom-0 h-[2px]"
          style={{ '--subagent-tone': subagentToneColor(subagent) } as CSSProperties}
        />
      ) : null}
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
    'relative flex size-6 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--basis-text)_9%,var(--basis-surface))] ring-2 ring-[var(--basis-surface)] transition-[box-shadow] duration-100 group-hover/header:ring-[var(--basis-surface-hover)]'
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
 * How a group stands, as one thin bar: a segment per tone, as wide as how
 * many stand in it. The running segment shimmers while any works.
 */
function GroupBar({ subagents }: { subagents: readonly Subagent[] }) {
  const { segments } = subagentGroupSummary(subagents)
  const color = (tone: SubagentTone) =>
    tone === 'running'
      ? 'var(--basis-status-working)'
      : tone === 'waiting'
        ? 'var(--basis-status-needs)'
        : tone === 'done'
          ? 'var(--basis-status-done)'
          : tone === 'failed'
            ? 'var(--basis-status-error)'
            : 'color-mix(in srgb, var(--basis-text) 22%, transparent)'
  return (
    <span
      aria-hidden
      className="flex h-1 w-16 shrink-0 gap-px overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--basis-text)_8%,transparent)] max-sm:hidden"
    >
      {segments.map(({ tone, count }) => (
        <span
          key={tone}
          className={cn('h-full', tone === 'running' && 'subagent-bar-live')}
          style={{ flexGrow: count, background: color(tone) }}
        />
      ))}
    </span>
  )
}

/**
 * Subagents the agent started back to back. Folded, one card: what they run
 * on as a stack of provider chips, how many, a bar of how they stand, and
 * the words for it. Unfolded, a card each, hung off a rail under the header
 * so they read as one family.
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
      className="my-2 flex flex-col"
    >
      <div
        className={cn(
          'group/header relative flex transition-[background-color,box-shadow] duration-150 hover:bg-[var(--basis-surface-hover)] has-[button:focus-visible]:bg-[var(--basis-surface-hover)]',
          SURFACE,
          summary.running && 'overflow-hidden',
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={toggle}
          className="flex min-h-[46px] w-full min-w-0 cursor-pointer items-center gap-2.5 pl-2.5 pr-3 text-left outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']"
        >
          <ProviderStack subagents={subagents} />
          <span className="shrink-0 text-ui-md font-medium leading-5 text-[var(--basis-text)]">
            {summary.title}
          </span>
          <GroupBar subagents={subagents} />
          <GroupActivity subagents={subagents} />
          <span className="min-w-0 truncate text-ui-sm text-[var(--basis-text-muted)]">
            {summary.detail}
          </span>
          <CaretRightIcon
            size={12}
            aria-hidden
            className={cn(
              'ml-auto shrink-0 text-[var(--basis-text-faint)] transition-transform duration-200 group-hover/header:text-[var(--basis-text-muted)]',
              open && 'rotate-90',
            )}
          />
        </button>
        {summary.running ? (
          <span
            aria-hidden
            className="subagent-rail pointer-events-none absolute inset-x-0 bottom-0 h-[2px]"
            style={{ '--subagent-tone': 'var(--basis-status-working)' } as CSSProperties}
          />
        ) : null}
      </div>
      {open ? (
        <div
          id={listId}
          className="relative mt-1.5 ml-[22px] flex flex-col gap-1.5 border-l border-[color-mix(in_srgb,var(--basis-text)_10%,transparent)] pl-3"
        >
          {parts.map((part) => (
            <SubagentCard key={part.id} part={part} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
