import { NO_PROJECT_ICON_DASHES, NO_PROJECT_ICON_PATH } from '../../lib/no-project'
import { cn } from '../../lib/utils'

/**
 * A chat bubble drawn in dashes: "No project". Phosphor has no dashed chat,
 * so it is drawn here (`NO_PROJECT_ICON_PATH`, shared with the phone), and
 * takes the same `className` sizing and `currentColor` as the icons beside it.
 */
export function NoProjectIcon({ className }: { className?: string; weight?: string }) {
  return (
    <svg
      viewBox="0 0 256 256"
      fill="none"
      stroke="currentColor"
      strokeWidth={18}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={NO_PROJECT_ICON_DASHES}
      aria-hidden="true"
      className={cn('h-3.5 w-3.5 shrink-0', className)}
    >
      <path d={NO_PROJECT_ICON_PATH} />
    </svg>
  )
}
