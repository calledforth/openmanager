import { useState, type ComponentType } from 'react'
import {
  ArrowClockwiseIcon,
  ArrowsInLineVerticalIcon,
  ArrowsLeftRightIcon,
  GaugeIcon,
  InfoIcon,
  ProhibitIcon,
  WarningCircleIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import type { DurableTurnNotice, TransientTurnNotice } from '@openmanager/protocol'
import { typographyBodySm } from '../../lib/typography'
import { cn } from '../../lib/utils'
import { describeFailure, describeNotice, type FailurePart } from '../../lib/turn-notice-parts'
import { useTurnRecovery } from '../../providers/turn-recovery'
import { activityDetailsSummary, activityRow, shimmerTextClass, shimmerTextStyle } from './ToolLine'

type Notice = DurableTurnNotice | TransientTurnNotice
type IconComponent = ComponentType<{ size?: number; className?: string; weight?: 'regular' }>

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

/**
 * Something the provider said about the turn, on one quiet line the way a
 * thought or a tool call reads: a retry in progress, a compaction, a model
 * switch, a limit getting close. A notice with more to say (a refusal's
 * explanation) opens to show it. A live one shimmers until the turn moves on.
 */
export function TurnNoticePart({ notice, live = false }: { notice: Notice; live?: boolean }) {
  const copy = describeNotice(notice)
  const Icon = NOTICE_ICONS[notice.kind]
  const summary = (
    <>
      <Icon
        size={13}
        className={cn(
          'mt-[3px] shrink-0',
          copy.tone === 'warning' ? 'text-amber-500/80' : 'text-[var(--basis-text-faint)]',
        )}
      />
      <span className="min-w-0">
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
    </>
  )

  if (!copy.body) {
    return (
      <div
        className={cn(activityRow, 'flex items-start gap-1.5')}
        {...(live ? { role: 'status' } : {})}
        data-notice-kind={notice.kind}
      >
        {summary}
      </div>
    )
  }
  return (
    <details className={`group ${activityRow}`} data-notice-kind={notice.kind}>
      <summary className={activityDetailsSummary}>{summary}</summary>
      <div
        className={`mt-1 pl-[19px] whitespace-pre-wrap text-[var(--basis-text-muted)] ${typographyBodySm}`}
      >
        {copy.body}
      </div>
    </details>
  )
}

/**
 * A failed turn: what happened, what to do about it, and the button that does
 * it when the app can. A faint red fill sets it apart from the quiet rows
 * around it without boxing it in. Only the newest turn's failure offers its
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
      className="my-1 flex w-full items-start gap-2 rounded-md bg-red-500/[0.07] px-2.5 py-1.5 text-ui-base leading-snug"
      data-failure-reason={part.failure.reason}
    >
      <WarningCircleIcon size={14} className="mt-[3px] shrink-0 text-red-400" />
      <div className="min-w-0 flex-1">
        <div className="text-[var(--basis-text)]">{copy.title}</div>
        {copy.guidance ? (
          <div className="text-[var(--basis-text-muted)]">{copy.guidance}</div>
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
