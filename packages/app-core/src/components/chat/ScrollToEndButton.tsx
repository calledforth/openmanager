import { useEffect, useState } from 'react'
import { ArrowDownIcon } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { COMPOSER_HEIGHT_VAR } from './FloatingChatComposer'

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
    // Rides just above the composer, however tall it has grown.
    <div
      className="pointer-events-none absolute inset-x-0 z-30 flex justify-center"
      style={{ bottom: `calc(var(${COMPOSER_HEIGHT_VAR}, 84px) + 10px)` }}
    >
      <button
        type="button"
        aria-label="Scroll to latest message"
        title="Scroll to latest message"
        tabIndex={shown ? 0 : -1}
        aria-hidden={!shown}
        onClick={onClick}
        className={cn(
          'group/end flex size-7 cursor-pointer items-center justify-center rounded-full bg-float text-muted-foreground shadow-float',
          'transition-[opacity,transform,color] duration-150 ease-out hover:text-foreground active:scale-95',
          'focus-visible:outline-2 focus-visible:outline-ring',
          shown ? 'pointer-events-auto opacity-100' : 'translate-y-1.5 scale-90 opacity-0',
        )}
      >
        <ArrowDownIcon
          size={13}
          className="transition-transform duration-150 ease-out group-hover/end:translate-y-px"
        />
      </button>
    </div>
  )
}
