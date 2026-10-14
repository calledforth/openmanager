import { useEffect, useState } from 'react'
import { CheckIcon } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { Tooltip } from '../ui/Tooltip'

/** Phosphor's Copy glyph (same 256 grid and regular stroke) with rounded corners. */
function SoftCopyIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      stroke="currentColor"
      strokeWidth={16}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M168 168h24a24 24 0 0 0 24-24V64a24 24 0 0 0-24-24h-80a24 24 0 0 0-24 24v24" />
      <rect x="40" y="88" width="128" height="128" rx="24" />
    </svg>
  )
}

/** Each row names its hover group; Tailwind needs the full class written out. */
const revealOnRowHover = {
  user: 'group-hover/user:opacity-100',
  assistant: 'group-hover/assistant:opacity-100',
} as const

/** Copies a message's text; shown under the message while its row is hovered. */
export function CopyMessageButton({
  text,
  row,
}: {
  text: string
  row: keyof typeof revealOnRowHover
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(timer)
  }, [copied])
  const label = copied ? 'Copied' : 'Copy message'
  return (
    <Tooltip content={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true))
        }}
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-[color,background-color,opacity] duration-100',
          'text-[var(--basis-text-faint)] hover:bg-hover hover:text-[var(--basis-text)]',
          'opacity-0 focus-visible:opacity-100 pointer-coarse:opacity-100',
          revealOnRowHover[row],
          copied && 'opacity-100',
        )}
      >
        {copied ? <CheckIcon size={13} weight="bold" /> : <SoftCopyIcon size={13} />}
      </button>
    </Tooltip>
  )
}
