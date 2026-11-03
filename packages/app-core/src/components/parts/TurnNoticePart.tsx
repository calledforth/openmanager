import { useState, type ComponentType } from 'react'
import {
  ArrowClockwiseIcon,
  ArrowsInLineVerticalIcon,
  ArrowsLeftRightIcon,
  CaretRightIcon,
  GaugeIcon,
  InfoIcon,
  ProhibitIcon,
  WarningCircleIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import type { DurableTurnNotice, TransientTurnNotice } from '@openmanager/protocol'
import { cn } from '../../lib/utils'
import {
  describeFailure,
  describeNotice,
  type FailurePart,
  type NoticeCopy,
} from '../../lib/turn-notice-parts'
import { useTurnRecovery } from '../../providers/turn-recovery'
import { activityDetailsSummary, activityRow, shimmerTextClass, shimmerTextStyle } from './ToolLine'

type Notice = DurableTurnNotice | TransientTurnNotice
type IconComponent = ComponentType<{
  size?: number
  className?: string
  'aria-hidden'?: boolean
}>

const NOTICE_ICONS: Record<Notice['kind'], IconComponent> = {
  retrying: ArrowClockwiseIcon,
  compacting: ArrowsInLineVerticalIcon,
  compacted: ArrowsInLineVerticalIcon,
  model_fallback: ArrowsLeftRightIcon,
  refusal: ProhibitIcon,
  usage_warning: GaugeIcon,
  info: InfoIcon,
  warning: WarningIcon,
}

const providerWords =
  'custom-scrollbar max-h-[300px] overflow-y-auto text-ui-sm break-words whitespace-pre-wrap'

/** The one line a notice is, laid out as a tool row is. */
function NoticeLine({
  notice,
  copy,
  live,
  open,
}: {
  notice: Notice
  copy: NoticeCopy
  live: boolean
  open?: boolean
}) {
  const Glyph = NOTICE_ICONS[notice.kind]
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
      <Glyph
        size={13}
        aria-hidden
        className={cn(
          'relative top-[2px] shrink-0',
          copy.tone === 'warning' ? 'text-amber-500/80' : 'text-[var(--basis-text-faint)]',
        )}
      />
      <span className="min-w-0 break-words">
        {live ? (
          <span className={shimmerTextClass} style={shimmerTextStyle}>
            {copy.label}
          </span>
        ) : (
          <span className="text-[var(--basis-text-muted)]">{copy.label}</span>
        )}
        {copy.detail ? (
          <span className="text-[var(--basis-text-faint)]">
            {' · '}
            {copy.detail}
          </span>
        ) : null}
      </span>
      {open !== undefined ? (
        <CaretRightIcon
          size={10}
          aria-hidden
          className={cn(
            'relative top-px ml-auto shrink-0 text-[var(--basis-text-faint)] opacity-0 transition-[transform,opacity] duration-150 group-hover/row:opacity-100',
            open && 'rotate-90 opacity-100',
          )}
        />
      ) : null}
    </span>
  )
}

/**
 * Something the provider said about the turn, on one quiet line the way a tool
 * call reads: a retry in progress, a compaction, a model switch, a limit
 * getting close. A notice with more to say (a refusal's explanation) opens to
 * show it. A live one shimmers until the server says it is over.
 */
export function TurnNoticePart({ notice, live = false }: { notice: Notice; live?: boolean }) {
  const copy = describeNotice(notice)
  const [open, setOpen] = useState(false)

  if (!copy.body) {
    return (
      <div
        className={cn(activityRow, 'flex min-w-0')}
        {...(live ? { role: 'status' } : {})}
        data-notice-kind={notice.kind}
      >
        <NoticeLine notice={notice} copy={copy} live={live} />
      </div>
    )
  }
  return (
    <details
      className={cn('group/row', activityRow)}
      data-notice-kind={notice.kind}
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary
        className={cn(
          activityDetailsSummary,
          '-mx-1 rounded px-1 transition-colors duration-150 hover:bg-[var(--basis-surface-hover)]',
        )}
      >
        <NoticeLine notice={notice} copy={copy} live={live} open={open} />
      </summary>
      {open ? (
        <div className="pl-[19px]">
          <div
            className={cn(
              'mt-1 rounded-md bg-[var(--basis-surface)] px-2.5 py-2 text-[var(--basis-text-muted)]',
              providerWords,
            )}
          >
            {copy.body}
          </div>
        </div>
      ) : null}
    </details>
  )
}

/**
 * A failed turn: what happened, what to do about it, and the button that does
 * it when the app can. A faint rose fill sets it apart from the quiet rows
 * around it, with no outline. Only the newest turn's failure offers its
 * action; an older one keeps its guidance.
 */
export function TurnFailurePart({ part }: { part: FailurePart }) {
  const recovery = useTurnRecovery()
  const copy = describeFailure(
    part.failure,
    recovery?.providerName,
    undefined,
    part.resendable !== false,
  )
  const [pending, setPending] = useState(false)
  const perform =
    !part.actionable || !copy.action || !recovery
      ? undefined
      : copy.action.kind === 'retry'
        ? recovery.retry && (() => recovery.retry!(part.turnId))
        : recovery.compact

  return (
    <div
      className="my-1 flex w-full items-start gap-1.5 rounded-md bg-rose-500/[0.07] px-2.5 py-1.5 text-ui-base leading-snug"
      data-failure-reason={part.failure.reason}
    >
      <WarningCircleIcon size={13} aria-hidden className="mt-[3px] shrink-0 text-rose-500/80" />
      <div className="min-w-0 flex-1">
        <div className="text-[var(--basis-text)]">{copy.title}</div>
        {copy.guidance ? (
          <div className="text-[var(--basis-text-muted)]">{copy.guidance}</div>
        ) : null}
        {copy.detail ? (
          // The provider's words: quieter than ours, but whole, since they
          // often say exactly what to change.
          <div className={cn('mt-1 text-[var(--basis-text-faint)]', providerWords)}>
            {copy.detail}
          </div>
        ) : null}
      </div>
      {perform && copy.action ? (
        <button
          type="button"
          disabled={pending || recovery?.busy}
          onClick={() => {
            setPending(true)
            void perform().finally(() => setPending(false))
          }}
          className="shrink-0 rounded-md bg-hover px-2 py-0.5 text-ui-sm font-medium text-[var(--basis-text)] transition-colors hover:bg-active focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
        >
          {copy.action.label}
        </button>
      ) : null}
    </div>
  )
}
