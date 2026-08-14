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
    <svg
      viewBox="0 0 466.73 532.09"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        fill={dark ? '#edecec' : '#26251e'}
        d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"
      />
    </svg>
  )
}

/** Unlike the other two marks this takes no `dark`: the burst is drawn in
 * Anthropic's terracotta, which is the brand colour on both themes and clears
 * contrast against either surface. A theme variant would be inventing one. */
function ClaudeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <path
        fill="#D97757"
        d="M4.709 15.955l4.72-2.647.079-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.583.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.003 1.81 2.507 2.33.127.578-.322.455-.34-.049-2.204-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.081-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.06-.746.231-.243 1.908-1.312-.006.006z"
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
    case 'claude':
      return <ClaudeIcon className={sizeClass} />
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
