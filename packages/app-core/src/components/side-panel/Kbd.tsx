import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * One key cap, Fluid Functionalism's way: a filled chip with a 5px radius in
 * the sans font, muted. `inverted` is for tooltips and other dark-on-light
 * surfaces.
 */
export function Kbd({
  children,
  inverted = false,
  className,
}: {
  children: ReactNode
  inverted?: boolean
  className?: string
}) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[5px] px-1',
        'font-sans text-[10.5px] leading-none font-medium tabular-nums',
        inverted
          ? 'bg-background/15 text-background/85'
          : 'bg-hover text-[var(--basis-text-muted)]',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
