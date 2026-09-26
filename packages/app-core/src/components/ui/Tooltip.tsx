import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Tooltip as FluidTooltip, type TooltipSide } from '../fluid/ui/tooltip'

export type { TooltipSide }

/**
 * The one hover-tip in the app: the Fluid Functionalism tooltip behind the
 * API the call sites already use. Wraps a single element child and portals
 * the bubble next to it, so it can sit inside any flex row.
 *
 * Prefer this over the native `title` attribute everywhere: `title` has a ~1s
 * delay we can't control, ignores the theme, and never shows on keyboard focus.
 */
export function Tooltip({
  content,
  shortcut,
  side = 'top',
  disabled,
  wrapperClassName,
  children,
}: {
  /** Tip body. Falsy content renders the child untouched. */
  content?: ReactNode
  /** Optional key hint appended to the tip, e.g. `⌘K`. */
  shortcut?: string
  side?: TooltipSide
  /** Suppress the tip entirely (renders the child untouched). */
  disabled?: boolean
  /** Extra classes for the wrapper used when the child is a disabled control. */
  wrapperClassName?: string
  children: ReactElement
}) {
  if (!isValidElement(children)) return children ?? null
  if (!content || disabled) return children

  // Disabled form controls swallow pointer events, so the tip that explains
  // *why* they're disabled would never fire. Anchor on a wrapper instead.
  const childDisabled = (children.props as { disabled?: boolean }).disabled
  const trigger = childDisabled ? (
    <span className={cn('inline-flex shrink-0', wrapperClassName)}>{children}</span>
  ) : (
    children
  )

  return (
    <FluidTooltip
      // Sits above the app's own fixed layers (menus, dialogs) the way the
      // previous bubble did.
      contentClassName="z-[600]"
      side={side}
      content={
        shortcut ? (
          <>
            {content} {shortcut}
          </>
        ) : (
          content
        )
      }
    >
      {trigger}
    </FluidTooltip>
  )
}
