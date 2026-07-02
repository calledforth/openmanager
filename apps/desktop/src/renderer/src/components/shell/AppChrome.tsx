import { useEffect, useState } from 'react'
import { Hexagon, Minus, Square, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { typographyCaption } from '../../lib/typography'

const isMac = window.electronAPI.platform === 'darwin'
const showWindowControls = !isMac

export function AppChrome({
  convexOpen,
  onToggleConvex,
}: {
  convexOpen: boolean
  onToggleConvex: () => void
}) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    window.electronAPI
      .isWindowMaximized()
      .then(setMaximized)
      .catch(() => undefined)
    return window.electronAPI.onWindowMaximizedChanged(setMaximized)
  }, [])

  return (
    <header
      className="flex h-[var(--basis-titlebar-height)] shrink-0 items-stretch bg-[var(--basis-canvas-bg)]"
      data-app-titlebar
    >
      <div
        className={cn(
          'titlebar-drag min-w-0 flex-1',
          isMac && 'pl-[72px]',
        )}
      />

      <div className="titlebar-no-drag flex shrink-0 items-stretch">
        <button
          type="button"
          onClick={onToggleConvex}
          aria-pressed={convexOpen}
          title="Convex trace panel"
          className={cn(
            typographyCaption,
            'flex items-center gap-1.5 border-l border-[var(--basis-border-muted)] px-3 uppercase tracking-[0.12em] transition-default',
            convexOpen
              ? 'bg-[var(--basis-surface)] text-[var(--basis-text-strong)]'
              : 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
          )}
        >
          <Hexagon className="h-3 w-3" strokeWidth={2} />
          Convex
        </button>

        {showWindowControls && (
          <>
            <button
              type="button"
              onClick={() => window.electronAPI.minimizeWindow()}
              aria-label="Minimize"
              className="flex w-11 items-center justify-center text-[var(--basis-text)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text-strong)]"
            >
              <Minus className="h-4 w-4" strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => window.electronAPI.maximizeWindow()}
              aria-label={maximized ? 'Restore' : 'Maximize'}
              className="flex w-11 items-center justify-center text-[var(--basis-text)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text-strong)]"
            >
              <Square className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => window.electronAPI.closeWindow()}
              aria-label="Close"
              className="flex w-11 items-center justify-center text-[var(--basis-text)] transition-default hover:bg-destructive hover:text-destructive-foreground"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </>
        )}
      </div>
    </header>
  )
}
