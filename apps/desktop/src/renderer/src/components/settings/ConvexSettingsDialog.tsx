import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, Hexagon, LoaderCircle, Server, X } from 'lucide-react'
import type { RuntimeConfig } from '../../../../shared/runtime-config'
import { cn } from '../../lib/utils'
import { typographyBodySm, typographyCaption, typographyLabel } from '../../lib/typography'

type RequestState = 'idle' | 'testing' | 'success' | 'saving' | 'error'

function sourceLabel(config: RuntimeConfig | null): string {
  if (config?.convexSource === 'settings') return 'Local setting'
  if (config?.convexSource === 'environment') return 'Development default'
  return 'Not configured'
}

export function ConvexSettingsDialog({
  open,
  required = false,
  onOpenChange,
}: {
  open: boolean
  required?: boolean
  onOpenChange: (open: boolean) => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [config, setConfig] = useState<RuntimeConfig | null>(null)
  const [url, setUrl] = useState('')
  const [requestState, setRequestState] = useState<RequestState>('idle')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setRequestState('idle')
    setMessage('')
    window.electronAPI
      .getRuntimeConfig()
      .then((runtimeConfig) => {
        if (cancelled) return
        setConfig(runtimeConfig)
        setUrl(runtimeConfig.convexUrl)
        requestAnimationFrame(() => inputRef.current?.focus())
      })
      .catch(() => {
        if (cancelled) return
        setConfig({ convexUrl: '', convexSource: 'unset', environmentUrlAvailable: false })
        setRequestState('error')
        setMessage('OpenManager could not read local settings.')
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !required && requestState !== 'saving') {
        onOpenChange(false)
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onOpenChange, open, requestState, required])

  if (!open) return null

  const busy = requestState === 'testing' || requestState === 'saving'
  const hasUrl = url.trim().length > 0

  const testConnection = async () => {
    if (!hasUrl || busy) return
    setRequestState('testing')
    setMessage('Testing the deployment and OpenManager schema…')
    try {
      const result = await window.electronAPI.testConvexUrl(url)
      if (result.ok) {
        if (result.normalizedUrl) setUrl(result.normalizedUrl)
        setRequestState('success')
        setMessage('Connected. The OpenManager Convex schema is available.')
        return
      }
      setRequestState('error')
      setMessage(result.error ?? 'The deployment could not be reached.')
    } catch {
      setRequestState('error')
      setMessage('OpenManager could not run the connection test.')
    }
  }

  const saveAndRestart = async () => {
    if (!hasUrl || busy) return
    setRequestState('saving')
    setMessage('Verifying and saving the deployment…')
    try {
      const result = await window.electronAPI.setConvexUrlAndRestart(url)
      if (result.ok) {
        setRequestState('success')
        setMessage('Saved. OpenManager is restarting…')
        return
      }
      setRequestState('error')
      setMessage(result.error ?? 'The deployment could not be saved.')
    } catch {
      setRequestState('error')
      setMessage('OpenManager could not save the local setting.')
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/55 p-6 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !required && !busy) onOpenChange(false)
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="convex-settings-title"
        aria-describedby="convex-settings-description"
        className="w-full max-w-[560px] overflow-hidden rounded-[10px] border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)] shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
      >
        <div className="relative border-b border-[var(--basis-border-muted)] px-6 pb-5 pt-6">
          <div className="absolute right-6 top-6 flex items-center gap-2">
            <span
              className={cn(
                typographyCaption,
                'rounded-full border border-[var(--basis-border)] bg-[var(--basis-canvas-bg)] px-2 py-0.5 text-[var(--basis-text-faint)]',
              )}
            >
              {sourceLabel(config)}
            </span>
            {!required && (
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={busy}
                aria-label="Close Convex settings"
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)] disabled:opacity-40"
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            )}
          </div>

          <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-400">
            <Hexagon className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </div>
          <div
            className={cn(typographyCaption, 'mb-1 uppercase tracking-[0.14em] text-emerald-400')}
          >
            Runtime / Convex
          </div>
          <h2 id="convex-settings-title" className="text-16-medium text-[var(--basis-text-strong)]">
            {required ? 'Connect your deployment' : 'Convex deployment'}
          </h2>
          <p
            id="convex-settings-description"
            className={cn(typographyBodySm, 'mt-1.5 max-w-[440px] text-[var(--basis-text-muted)]')}
          >
            OpenManager uses this deployment for workspaces, session state, permissions, and remote
            control.
          </p>
        </div>

        <div className="space-y-5 px-6 py-5">
          <div>
            <label
              htmlFor="convex-deployment-url"
              className={cn(typographyLabel, 'mb-2 block text-[var(--basis-text)]')}
            >
              Deployment URL
            </label>
            <div className="flex items-center rounded-lg border border-[var(--basis-border)] bg-[var(--basis-canvas-bg)] px-3 focus-within:border-emerald-400/60 focus-within:ring-1 focus-within:ring-emerald-400/15">
              <Server
                className="mr-2.5 h-3.5 w-3.5 shrink-0 text-[var(--basis-text-faint)]"
                strokeWidth={1.75}
              />
              <input
                ref={inputRef}
                id="convex-deployment-url"
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value)
                  setRequestState('idle')
                  setMessage('')
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void testConnection()
                }}
                placeholder="https://your-deployment.convex.cloud"
                className="h-10 min-w-0 flex-1 bg-transparent font-mono text-[12px] text-[var(--basis-text)] outline-none placeholder:text-[var(--basis-text-faint)]"
              />
            </div>
            <p className={cn(typographyCaption, 'mt-2 text-[var(--basis-text-faint)]')}>
              Use the deployment URL from Convex Dashboard → Settings → URL &amp; Deploy Key.
            </p>
          </div>

          <div
            className={cn(
              'flex min-h-10 items-start gap-2.5 rounded-lg border px-3 py-2.5',
              requestState === 'error'
                ? 'border-red-400/25 bg-red-400/[0.05] text-red-300'
                : requestState === 'success'
                  ? 'border-emerald-400/25 bg-emerald-400/[0.05] text-emerald-300'
                  : 'border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] text-[var(--basis-text-muted)]',
            )}
            aria-live="polite"
          >
            {requestState === 'testing' || requestState === 'saving' ? (
              <LoaderCircle
                className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin"
                strokeWidth={1.75}
              />
            ) : requestState === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            ) : requestState === 'error' ? (
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            ) : (
              <Server className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            )}
            <span className={typographyCaption}>
              {message ||
                'The URL is stored on this device. Never enter a deploy key or admin token.'}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] px-6 py-4">
          <span className={cn(typographyCaption, 'text-[var(--basis-text-faint)]')}>
            Restart required to switch clients cleanly
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void testConnection()}
              disabled={!hasUrl || busy}
              className={cn(
                typographyLabel,
                'rounded-lg border border-[var(--basis-border)] px-3 py-2 text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)] disabled:cursor-not-allowed disabled:opacity-40',
              )}
            >
              Test connection
            </button>
            <button
              type="button"
              onClick={() => void saveAndRestart()}
              disabled={!hasUrl || busy}
              className={cn(
                typographyLabel,
                'rounded-lg bg-[var(--basis-action-bg)] px-3.5 py-2 text-[var(--basis-action-fg)] transition-default hover:bg-[var(--basis-action-hover)] disabled:cursor-not-allowed disabled:opacity-40',
              )}
            >
              {requestState === 'saving' ? 'Verifying…' : 'Save & restart'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function ConvexConfigurationRequired() {
  return (
    <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-[var(--basis-canvas-bg)]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />
      <div className="absolute left-8 top-7 flex items-center gap-2 text-[var(--basis-text-faint)]">
        <Hexagon className="h-4 w-4" strokeWidth={1.75} />
        <span className={cn(typographyCaption, 'uppercase tracking-[0.14em]')}>OpenManager</span>
      </div>
      <ConvexSettingsDialog open required onOpenChange={() => undefined} />
    </div>
  )
}
