import { useEffect, useState } from 'react'
import { ArrowDownIcon } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'

/**
 * Showing waits this long so the button does not flash while a session opens
 * and settles at the bottom. Hiding is immediate.
 */
const SHOW_DELAY_MS = 150

export function ScrollToEndButton({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!visible) {
      setShown(false)
      return
    }
    const timer = window.setTimeout(() => setShown(true), SHOW_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [visible])

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-36 z-30 flex justify-center">
      <button
        type="button"
        aria-label="Scroll to latest message"
        title="Scroll to latest message"
        tabIndex={shown ? 0 : -1}
        aria-hidden={!shown}
        onClick={onClick}
        className={cn(
          'flex size-8 items-center justify-center rounded-full bg-float text-muted-foreground shadow-float',
          'transition-[opacity,transform,color] duration-150 ease-out hover:text-foreground',
          'focus-visible:outline-2 focus-visible:outline-ring',
          shown ? 'pointer-events-auto opacity-100' : 'translate-y-1 opacity-0',
        )}
      >
        <ArrowDownIcon size={16} weight="bold" />
      </button>
    </div>
  )
}
