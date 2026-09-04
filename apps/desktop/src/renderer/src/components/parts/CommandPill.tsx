import { TerminalIcon } from '@phosphor-icons/react'
import { parseCommandPill } from '@openmanager/shared/lib/command-pill'
import { typographyMonoCaption, typographyMonoCaptionTiny } from '../../lib/typography'
import { shimmerTextClass, shimmerTextStyle } from './ToolLine'
import { cn } from '../../lib/utils'

const badgeClass = cn(
  typographyMonoCaptionTiny,
  'rounded-[3px] bg-[var(--basis-surface-hover)] px-1 py-px text-[var(--basis-text-muted)]',
)

export function CommandPill({
  command,
  isRunning,
  isError,
  isInteractive,
}: {
  command: string
  isRunning?: boolean
  isError?: boolean
  isInteractive?: boolean
}) {
  const { label, flags, hiddenFlagCount, extraSegmentCount } = parseCommandPill(command)
  const overflowCount = hiddenFlagCount + extraSegmentCount

  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border px-1.5 py-0.5 align-middle',
        'border-[var(--basis-border-muted)] bg-[var(--basis-surface-elevated)]',
        isError && 'border-rose-500/40',
        isInteractive && 'transition-colors group-hover:border-[var(--basis-border)]',
      )}
    >
      <TerminalIcon
        size={11}
        weight="bold"
        className={cn('shrink-0', isError ? 'text-rose-500/80' : 'text-[var(--basis-text-faint)]')}
      />
      {isRunning ? (
        <span
          className={cn('truncate', typographyMonoCaption, shimmerTextClass)}
          style={shimmerTextStyle}
        >
          {label}
        </span>
      ) : (
        <span className={cn('truncate', typographyMonoCaption, 'text-[var(--basis-text)]')}>
          {label}
        </span>
      )}
      {flags.map((flag) => (
        <span key={flag} className={cn(badgeClass, 'shrink-0')}>
          {flag}
        </span>
      ))}
      {overflowCount > 0 && (
        <span className={cn(badgeClass, 'shrink-0 tabular-nums')}>+{overflowCount}</span>
      )}
    </span>
  )
}
