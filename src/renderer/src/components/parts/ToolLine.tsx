import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

export const activityRowBare = 'w-full max-w-none py-px text-ui-base leading-snug'
export const activityRow = `${activityRowBare} px-2`
export const activityDetailsSummary =
  'flex cursor-pointer list-none items-start gap-1.5 text-ui-base leading-snug [&::-webkit-details-marker]:hidden'

export function ToolLine({
  verb,
  detail,
  isRunning,
  detailSlot,
  className,
}: {
  verb: string
  detail?: string
  isRunning?: boolean
  detailSlot?: ReactNode
  className?: string
}) {
  return (
    <span className={cn('min-w-0', className)}>
      {isRunning ? (
        <span
          className="inline basis-tool-shimmer"
          style={{
            background:
              'linear-gradient(90deg, color-mix(in srgb, var(--basis-text-faint) 65%, transparent) 25%, color-mix(in srgb, var(--basis-text-muted) 92%, transparent) 50%, color-mix(in srgb, var(--basis-text-faint) 65%, transparent) 75%)',
            backgroundSize: '200% 100%',
            backgroundClip: 'text',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            animation: 'shimmer 1.6s infinite linear',
          }}
        >
          {verb}
          {detail ? ` ${detail}` : ''}
        </span>
      ) : (
        <>
          <span className="text-[var(--basis-text-muted)]">{verb}</span>
          {detail || detailSlot ? (
            <>
              {' '}
              {detailSlot ?? (
                <span className="text-[var(--basis-text-faint)]">{detail}</span>
              )}
            </>
          ) : null}
        </>
      )}
    </span>
  )
}

export function ToolExpandedBody({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1 max-h-[300px] overflow-y-auto pl-2 custom-scrollbar">
      {children}
    </div>
  )
}
