import { useEffect, useState } from 'react'
import { Hexagon, Minus, Square, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { typographyCaption } from '../../lib/typography'

const isMac =
  typeof window !== 'undefined' && window.electronAPI?.platform
    ? window.electronAPI.platform === 'darwin'
    : false
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
    if (!window.electronAPI?.isWindowMaximized) return
    window.electronAPI
      .isWindowMaximized()
      .then(setMaximized)
      .catch(() => undefined)
    return window.electronAPI.onWindowMaximizedChanged?.(setMaximized)
  }, [])

  return (
    <header
      className="flex h-[var(--basis-titlebar-height)] shrink-0 items-stretch border-b border-[var(--basis-border-muted)] bg-[var(--basis-titlebar-bg)]"
      data-app-titlebar
    >
      <div
        className={cn(
          'titlebar-drag flex min-w-0 flex-1 items-center gap-2 px-3',
          isMac && 'pl-[72px]',
        )}
      >
        <Hexagon
          className="h-3.5 w-3.5 shrink-0 text-[var(--basis-text-faint)]"
          strokeWidth={1.75}
          aria-hidden
        />
        <span
          className={cn(
            typographyCaption,
            'truncate tracking-[0.04em] text-[var(--basis-text-muted)]',
          )}
        >
          OpenManager
        </span>
      </div>

      <div className="titlebar-no-drag flex shrink-0 items-stretch">
        <button
          type="button"
          onClick={onToggleConvex}
          aria-pressed={convexOpen}
          title="Convex trace panel"
          className={cn(
            typographyCaption,
            'flex items-center gap-1.5 border-l border-[var(--basis-border-muted)] px-3 tracking-[0.08em] text-[var(--basis-text-faint)] uppercase transition-default',
            convexOpen
              ? 'bg-[var(--basis-surface)] text-[var(--basis-text-strong)]'
              : 'hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
          )}
        >
          <Hexagon className="h-3 w-3" strokeWidth={1.75} />
          Convex
        </button>

        {showWindowControls && (
          <>
            <button
              type="button"
              onClick={() => window.electronAPI?.minimizeWindow?.()}
              aria-label="Minimize"
              className="flex w-11 items-center justify-center border-l border-[var(--basis-border-muted)] text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text-strong)]"
            >
              <Minus className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={() => window.electronAPI?.maximizeWindow?.()}
              aria-label={maximized ? 'Restore' : 'Maximize'}
              className="flex w-11 items-center justify-center border-l border-[var(--basis-border-muted)] text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text-strong)]"
            >
              <Square className="h-3 w-3" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={() => window.electronAPI?.closeWindow?.()}
              aria-label="Close"
              className="flex w-11 items-center justify-center border-l border-[var(--basis-border-muted)] text-[var(--basis-text-muted)] transition-default hover:bg-destructive hover:text-destructive-foreground"
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </>
        )}
      </div>
    </header>
  )
}
