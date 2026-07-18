import { useEffect, useState } from 'react'
import { ArrowClockwiseIcon, DownloadSimpleIcon, XIcon } from '@phosphor-icons/react'
import type { AppUpdateEvent } from '../../../../shared/app-update'
import { cn } from '../../lib/utils'
import { typographyBodySm, typographyCaption, typographyLabel } from '../../lib/typography'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

export function UpdateNotification() {
  const [event, setEvent] = useState<AppUpdateEvent | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    return window.electronAPI.onAppUpdate((next) => {
      setDismissed(false)
      setEvent(next)
    })
  }, [])

  if (!event || dismissed || event.status === 'error') return null

  const percent =
    event.status === 'downloading' ? Math.max(0, Math.min(100, Math.round(event.percent))) : 100
  const isReady = event.status === 'ready'
  const version = event.version

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[300] w-[min(20.5rem,calc(100vw-2rem))]">
      <div
        className={cn(
          'pointer-events-auto overflow-hidden rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)] shadow-[0_16px_48px_rgba(0,0,0,0.35)]',
        )}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-start gap-2.5 px-3 pt-3 pb-2">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--basis-border-muted)] bg-[var(--basis-surface)] text-[var(--basis-text-muted)]">
            {isReady ? (
              <ArrowClockwiseIcon className="h-3.5 w-3.5" weight="regular" />
            ) : (
              <DownloadSimpleIcon className="h-3.5 w-3.5" weight="regular" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className={cn(typographyLabel, 'text-[var(--basis-text)]')}>
              {isReady ? 'Update ready' : 'Downloading update'}
            </div>
            <p className={cn(typographyCaption, 'mt-0.5 text-[var(--basis-text-muted)]')}>
              {isReady
                ? `OpenManager ${version} is ready to install.`
                : `OpenManager ${version}${
                    event.status === 'downloading' && event.total > 0
                      ? ` · ${formatBytes(event.transferred)} / ${formatBytes(event.total)}`
                      : ''
                  }`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 rounded-md p-1 text-[var(--basis-text-faint)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]"
            aria-label="Dismiss update notification"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="px-3 pb-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--basis-surface-hover)]">
            <div
              className={cn(
                'h-full rounded-full bg-[var(--basis-action-bg)] transition-[width] duration-200 ease-out',
                isReady && 'bg-emerald-500',
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
          <div
            className={cn(
              typographyCaption,
              'mt-1.5 flex items-center justify-between text-[var(--basis-text-faint)]',
            )}
          >
            <span>{isReady ? 'Download complete' : `${percent}%`}</span>
            {event.status === 'downloading' && event.bytesPerSecond > 0 && (
              <span>{formatBytes(event.bytesPerSecond)}/s</span>
            )}
          </div>
        </div>

        {isReady && (
          <div className="flex items-center gap-2 border-t border-[var(--basis-border-muted)] px-3 py-2.5">
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className={cn(
                typographyBodySm,
                'rounded-md px-2.5 py-1.5 text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
              )}
            >
              Later
            </button>
            <button
              type="button"
              disabled={restarting}
              onClick={() => {
                setRestarting(true)
                void window.electronAPI.quitAndInstallUpdate().catch(() => {
                  setRestarting(false)
                })
              }}
              className={cn(
                typographyBodySm,
                'ml-auto rounded-md bg-[var(--basis-action-bg)] px-2.5 py-1.5 text-[var(--basis-action-fg)] transition-default hover:bg-[var(--basis-action-hover)] disabled:opacity-50',
              )}
            >
              {restarting ? 'Restarting…' : 'Restart to install'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
