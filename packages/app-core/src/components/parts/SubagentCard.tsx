import { useEffect, useId, useState } from 'react'
import { CaretRightIcon, CheckIcon, StopIcon, XIcon } from '@phosphor-icons/react'
import type { ProviderId } from '@agentpack/contract'
import type { Subagent } from '@openmanager/protocol'
import { cn } from '../../lib/utils'
import { useEnvironmentClientOptional } from '../../providers/environment-client'
import { useViewActions } from '../../providers/view-actions'
import { ProviderIcon } from '../providers/ProviderIcon'
import { SessionBusyLoader } from '../sidebar/SessionBusyLoader'
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

/** The colour a tone is drawn in where every tone needs one (the rail's dots). */
export function subagentToneColor(subagent: Pick<Subagent, 'status' | 'waitingOn'>): string {
  return subagentTone(subagent.status) === 'running'
    ? 'var(--basis-status-working)'
    : (subagentStatusColor(subagent) ?? 'var(--basis-text-faint)')
}

/**
 * A status said in words, in its colour pulled toward the text colour so
 * small type keeps its contrast on either theme.
 */
export function subagentStatusTextColor(subagent: Pick<Subagent, 'status' | 'waitingOn'>): string {
  return `color-mix(in srgb, ${subagentToneColor(subagent)} 72%, var(--basis-text))`
}

/**
 * Stop, as a word. It sits over the clock and shows while the row is
 * hovered or the button focused, so it takes no room the rest of the time.
 */
export function SubagentStopText({
  onStop,
  name,
  className,
}: {
  onStop: () => Promise<void>
  name: string
  className?: string
}) {
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState(false)
  // A global `button { font: inherit }` outranks size utilities on a
  // button, so the size is set on its wrapper and inherited.
  return (
    <span className={cn('relative z-10 text-ui-xs leading-none', className)}>
      <button
        type="button"
        aria-label={`Stop ${name}`}
        title={failed ? 'Couldn’t stop it. Try again.' : undefined}
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
          'cursor-pointer text-[var(--basis-text-muted)] transition-colors duration-100 hover:text-[var(--basis-status-error)] focus-visible:underline focus-visible:outline-none disabled:cursor-default',
          failed && 'text-[var(--basis-status-error)]',
        )}
      >
        {stopping ? 'Stopping' : failed ? 'Retry' : 'Stop'}
      </button>
    </span>
  )
}

/** A clock with Stop laid over it, shown on hover. */
function ClockAndStop({
  elapsed,
  stop,
  name,
}: {
  elapsed: number | undefined
  stop: (() => Promise<void>) | undefined
  name: string
}) {
  const reveal = 'opacity-0 group-hover/subagent:opacity-100 focus-visible:opacity-100'
  const hide = 'group-hover/subagent:opacity-0'
  return (
    <span className="relative flex min-w-[3.5ch] shrink-0 items-center justify-end">
      {elapsed !== undefined ? (
        <span
          className={cn(
            'text-ui-xs tabular-nums text-[var(--basis-text-muted)] transition-opacity duration-100',
            stop && hide,
          )}
        >
          {formatElapsed(elapsed)}
        </span>
      ) : null}
      {stop ? (
        <SubagentStopText onStop={stop} name={name} className={cn('absolute right-0', reveal)} />
      ) : null}
    </span>
  )
}

const SURFACE =
  'rounded-[10px] bg-[var(--basis-surface)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--basis-text)_5%,transparent)]'

/** Agent types too generic to be worth a word. */
const PLAIN_TYPES = new Set(['general-purpose', 'general', 'default'])

/**
 * One subagent the agent started, in place of the tool call that started
 * it: a row like a tool row. Its status is the glyph at its head, said in a
 * word only when it needs someone or failed. While it works (or waits, or
 * after it failed) a second line says what it is doing, waits on, or why it
 * failed; a finished one stays one line. The whole row opens its child
 * session; a live one shows Stop over its clock on hover.
 */
export function SubagentCard({
  part,
  className,
  bare = false,
}: {
  part: SubagentPart
  className?: string
  /** Inside a group's surface: no surface of its own. */
  bare?: boolean
}) {
  const subagent = part.subagent
  const tone = subagentTone(subagent.status)
  const live = tone === 'running' || tone === 'waiting'
  const now = useTick(live)
  const { open, stop } = useSubagentActions(subagent)
  const name = subagentName(subagent)
  const elapsed = subagentElapsedMs(subagent, now)
  const model = subagentModelLabel(subagent.modelId) ?? providerName(subagent.providerId)
  const tools = subagentToolCount(subagent.stats)
  const detail = tone === 'done' || tone === 'stopped' ? undefined : subagentDetail(subagent)
  const kind =
    subagent.agentType && subagent.agentType !== name && !PLAIN_TYPES.has(subagent.agentType)
      ? subagent.agentType
      : undefined
  const flagged = tone === 'waiting' || tone === 'failed'
  const titleClass = cn(
    'min-w-0 truncate text-left text-ui-md leading-5',
    tone === 'stopped' ? 'text-[var(--basis-text-muted)]' : 'text-[var(--basis-text)]',
  )
  const meta = (
    <span className="flex min-w-0 shrink items-center gap-1.5 text-ui-xs leading-none text-[var(--basis-text-muted)] @max-[30rem]/card:hidden">
      <ProviderIcon
        providerId={subagent.providerId as ProviderId}
        className="size-3 shrink-0 opacity-80"
      />
      <span className="max-w-[12rem] truncate">{model}</span>
      {tools ? (
        <>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">{tools}</span>
        </>
      ) : null}
    </span>
  )

  return (
    <div
      data-subagent={subagent.subagentId}
      data-subagent-status={subagent.status}
      className={cn(
        'group/subagent @container/card relative flex min-w-0 flex-col justify-center px-2.5 transition-colors duration-100',
        detail ? 'gap-0.5 py-[7px]' : 'h-8',
        !bare && SURFACE,
        open &&
          'hover:bg-[var(--basis-surface-hover)] has-[[data-open]:focus-visible]:bg-[var(--basis-surface-hover)]',
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2 text-ui-md">
        <SubagentStatusGlyph subagent={subagent} className="size-4" />
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
        {kind ? (
          <span className="shrink-0 text-ui-sm text-[var(--basis-text-faint)]">{kind}</span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-3 pl-3">
          {flagged ? (
            <span
              className="shrink-0 text-ui-xs font-medium leading-none"
              style={{ color: subagentStatusTextColor(subagent) }}
              title={subagent.statusReason?.trim() || undefined}
            >
              {subagentStatusLabel(subagent)}
            </span>
          ) : null}
          {detail ? null : meta}
          <ClockAndStop elapsed={elapsed} stop={stop} name={name} />
        </span>
      </span>
      {detail ? (
        <span className="flex min-w-0 items-center gap-3 pl-6">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-ui-sm leading-4',
              tone === 'failed'
                ? 'text-[color-mix(in_srgb,var(--basis-status-error)_42%,var(--basis-text-muted))]'
                : 'text-[var(--basis-text-muted)]',
            )}
            title={detail}
          >
            {detail}
          </span>
          {meta}
        </span>
      ) : null}
    </div>
  )
}

/** The providers a group runs on, each once, as small marks. */
function ProviderMarks({ subagents }: { subagents: readonly Subagent[] }) {
  const seen = [...new Set(subagents.map((subagent) => subagent.providerId))]
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-[var(--basis-text-muted)]"
      title={seen.map(providerName).join(', ')}
    >
      {seen.map((providerId) => (
        <ProviderIcon
          key={providerId}
          providerId={providerId as ProviderId}
          className="size-3 opacity-80"
        />
      ))}
    </span>
  )
}

/** A group's head glyph: the loader while any works or waits, else how they ended. */
function GroupGlyph({ subagents }: { subagents: readonly Subagent[] }) {
  const waiting = subagents.find((subagent) => subagent.status === 'waiting')
  const running = subagents.find((subagent) => subagentTone(subagent.status) === 'running')
  const failed = subagents.find((subagent) => subagent.status === 'failed')
  const lead =
    waiting ?? running ?? failed ?? subagents.find((s) => s.status === 'completed') ?? subagents[0]
  return lead ? <SubagentStatusGlyph subagent={lead} className="size-4" /> : null
}

/**
 * Subagents the agent started back to back, as one surface. Folded, its
 * header says how many and how they stand, once, with the providers they run
 * on. Opened, a row each under it, inside the same surface.
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
  return (
    <div
      role="group"
      aria-label={summary.title}
      data-subagent-group={open ? 'open' : 'folded'}
      className={cn('my-1.5 flex flex-col overflow-hidden', SURFACE)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className="group/header flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 text-left outline-none transition-colors duration-100 hover:bg-[var(--basis-surface-hover)] focus-visible:bg-[var(--basis-surface-hover)]"
      >
        <GroupGlyph subagents={subagents} />
        <span className="shrink-0 text-ui-md leading-5 text-[var(--basis-text)]">
          {summary.title}
        </span>
        <span aria-hidden className="text-ui-sm text-[var(--basis-text-faint)]">
          ·
        </span>
        <span className="min-w-0 truncate text-ui-sm text-[var(--basis-text-muted)]">
          {summary.detail}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-3 pl-3">
          <ProviderMarks subagents={subagents} />
          <CaretRightIcon
            size={11}
            aria-hidden
            className={cn(
              'shrink-0 text-[var(--basis-text-faint)] transition-transform duration-150 group-hover/header:text-[var(--basis-text-muted)]',
              open && 'rotate-90',
            )}
          />
        </span>
      </button>
      {open ? (
        <div
          id={listId}
          className="flex flex-col divide-y divide-[color-mix(in_srgb,var(--basis-text)_6%,transparent)] border-t border-[color-mix(in_srgb,var(--basis-text)_6%,transparent)]"
        >
          {parts.map((part) => (
            <SubagentCard key={part.id} part={part} bare className="rounded-none" />
          ))}
        </div>
      ) : null}
    </div>
  )
}
