import type { ProviderId } from '@agentpack/contract'
import { useTheme } from '../../providers/theme-provider'
import { cn } from '../../lib/utils'

/** SVGL brand marks — https://svgl.app (OpenCode, Cursor). */
function OpenCodeIcon({ dark, className }: { dark: boolean; className?: string }) {
  // Crop to the mark — full 512 viewBox left too much padding at small sizes.
  if (dark) {
    return (
      <svg
        viewBox="128 96 256 320"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-hidden
      >
        <path d="M320 224V352H192V224H320Z" fill="#5A5858" />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
          fill="white"
        />
      </svg>
    )
  }
  return (
    <svg
      viewBox="128 96 256 320"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path d="M320 224V352H192V224H320Z" fill="#E6E5E6" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
        fill="#17181C"
      />
    </svg>
  )
}

function CursorIcon({ dark, className }: { dark: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 466.73 532.09" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <path
        fill={dark ? '#edecec' : '#26251e'}
        d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"
      />
    </svg>
  )
}

export function ProviderIcon({
  providerId,
  className,
}: {
  providerId: ProviderId
  className?: string
}) {
  const { theme } = useTheme()
  const dark = theme === 'dark'
  const sizeClass = cn('h-4 w-4 shrink-0', className)

  switch (providerId) {
    case 'opencode':
      return <OpenCodeIcon dark={dark} className={sizeClass} />
    case 'cursor':
      return <CursorIcon dark={dark} className={sizeClass} />
    default: {
      const label = String(providerId).slice(0, 1)
      return (
        <span
          className={cn(
            'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] bg-[var(--basis-surface-hover)] text-[9px] font-medium uppercase text-[var(--basis-text-muted)]',
            className,
          )}
          aria-hidden
        >
          {label}
        </span>
      )
    }
  }
}
