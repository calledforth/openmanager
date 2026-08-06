import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowClockwiseIcon,
  CircleNotchIcon,
  GearIcon,
  HexagonIcon,
  MoonIcon,
  SunIcon,
} from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { typographyCaption } from '../../lib/typography'
import { useTheme } from '../../providers/theme-provider'
import { Tooltip } from '../ui/Tooltip'
import { usePortaledMenu } from '../ui/usePortaledMenu'
import { ConvexSettingsDialog } from '../settings/ConvexSettingsDialog'
import { ExtraSettingsDialog } from '../settings/ExtraSettingsDialog'
import packageJson from '../../../../../package.json'

type UpdateCheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current'; version: string }
  | { status: 'available'; version: string }
  | { status: 'unsupported'; message: string }
  | { status: 'error'; message: string }

const APP_VERSION = packageJson.version

export function SidebarSettingsMenu({
  convexOpen,
  onToggleConvex,
}: {
  convexOpen: boolean
  onToggleConvex: () => void
}) {
  const [convexSettingsOpen, setConvexSettingsOpen] = useState(false)
  const [extraSettingsOpen, setExtraSettingsOpen] = useState(false)
  const [updateCheckState, setUpdateCheckState] = useState<UpdateCheckState>({
    status: 'idle',
  })
  const { theme, setTheme } = useTheme()
  const { open, toggle, close, menuCoords, wrapRef, triggerRef, menuRef } = usePortaledMenu({
    placement: 'above',
    align: 'end',
    minWidth: 200,
  })

  const checkForUpdates = useCallback(async () => {
    if (updateCheckState.status === 'checking') return
    setUpdateCheckState({ status: 'checking' })
    try {
      const result = await window.electronAPI.checkForUpdates()
      setUpdateCheckState(result)
    } catch (error) {
      setUpdateCheckState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to check for updates.',
      })
    }
  }, [updateCheckState.status])

  const displayedVersion =
    updateCheckState.status === 'current' ? updateCheckState.version : APP_VERSION

  const updateStatusMessage =
    updateCheckState.status === 'checking'
      ? 'Checking…'
      : updateCheckState.status === 'available'
        ? `Update ${updateCheckState.version} available`
        : updateCheckState.status === 'unsupported' || updateCheckState.status === 'error'
          ? updateCheckState.message
          : null

  const menuItemClass = cn(
    'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-11-regular leading-tight transition-colors',
    'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface)] hover:text-[var(--basis-text)]',
  )

  return (
    <>
      <div ref={wrapRef} className="relative shrink-0">
        <Tooltip content="Settings" side="top">
          <button
            ref={triggerRef}
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label="Settings"
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-[var(--basis-chat-shell-radius)] text-[var(--basis-text-muted)] transition-default',
              'hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
              open && 'bg-[var(--basis-surface-hover)] text-[var(--basis-text)]',
            )}
          >
            <GearIcon className="h-4 w-4" />
          </button>
        </Tooltip>

        {open &&
          menuCoords &&
          createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label="Settings"
              className={cn(
                'fixed z-[200] overflow-hidden border border-[var(--basis-border)] bg-[var(--basis-canvas-bg)] shadow-xl',
                'rounded-[var(--basis-chat-shell-radius)]',
              )}
              style={{
                left: menuCoords.left,
                top: menuCoords.top,
                bottom: menuCoords.bottom,
                width: menuCoords.width,
              }}
            >
              <div className="p-1">
                <div className="flex items-center justify-between gap-2 px-1.5 py-1">
                  <span className="text-11-regular leading-tight text-[var(--basis-text-muted)]">
                    Theme
                  </span>
                  <div
                    className="inline-flex items-center rounded-full border border-[var(--basis-border)] bg-[color-mix(in_srgb,var(--basis-canvas-bg)_72%,#000)] p-px"
                    role="group"
                    aria-label="Theme"
                  >
                    <Tooltip content="Light theme" side="top">
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={theme === 'light'}
                        aria-label="Light theme"
                        onClick={() => setTheme('light')}
                        className={cn(
                          'flex h-5 w-5 items-center justify-center rounded-full transition-colors',
                          theme === 'light'
                            ? 'bg-[var(--basis-surface-hover)] text-[var(--basis-text-strong)]'
                            : 'text-[var(--basis-text-faint)] hover:text-[var(--basis-text)]',
                        )}
                      >
                        <SunIcon className="h-3 w-3" />
                      </button>
                    </Tooltip>
                    <Tooltip content="Dark theme" side="top">
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={theme === 'dark'}
                        aria-label="Dark theme"
                        onClick={() => setTheme('dark')}
                        className={cn(
                          'flex h-5 w-5 items-center justify-center rounded-full transition-colors',
                          theme === 'dark'
                            ? 'bg-[var(--basis-surface-hover)] text-[var(--basis-text-strong)]'
                            : 'text-[var(--basis-text-faint)] hover:text-[var(--basis-text)]',
                        )}
                      >
                        <MoonIcon className="h-3 w-3" />
                      </button>
                    </Tooltip>
                  </div>
                </div>

                <Tooltip
                  content={updateStatusMessage ?? 'Check for updates'}
                  side="right"
                  wrapperClassName="w-full"
                >
                  <button
                    type="button"
                    role="menuitem"
                    disabled={updateCheckState.status === 'checking'}
                    onClick={() => void checkForUpdates()}
                    className={cn(menuItemClass, 'disabled:cursor-wait')}
                  >
                    {updateCheckState.status === 'checking' ? (
                      <CircleNotchIcon className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--basis-text-muted)]" />
                    ) : (
                      <ArrowClockwiseIcon className="h-3.5 w-3.5 shrink-0 text-[var(--basis-text-muted)]" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">v{displayedVersion}</span>
                      {updateStatusMessage && (
                        <span
                          className={cn(
                            typographyCaption,
                            'mt-0.5 block truncate leading-tight text-[var(--basis-text-faint)]',
                            updateCheckState.status === 'available' && 'text-emerald-400',
                            updateCheckState.status === 'error' && 'text-amber-400',
                          )}
                          aria-live="polite"
                        >
                          {updateStatusMessage}
                        </span>
                      )}
                    </span>
                  </button>
                </Tooltip>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close()
                    setConvexSettingsOpen(true)
                  }}
                  className={menuItemClass}
                >
                  <HexagonIcon className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span className="min-w-0 flex-1 truncate">Convex deployment</span>
                </button>
              </div>

              <div className="mx-1 h-px bg-[var(--basis-border-muted)]" />

              <div className="p-1">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close()
                    setExtraSettingsOpen(true)
                  }}
                  className={menuItemClass}
                >
                  <GearIcon className="h-3.5 w-3.5 shrink-0 text-[var(--basis-text-muted)]" />
                  <span className="min-w-0 flex-1 truncate">Extra Settings</span>
                </button>
              </div>
            </div>,
            document.body,
          )}
      </div>

      <ExtraSettingsDialog
        open={extraSettingsOpen}
        onOpenChange={setExtraSettingsOpen}
        convexOpen={convexOpen}
        onToggleConvex={onToggleConvex}
      />
      <ConvexSettingsDialog open={convexSettingsOpen} onOpenChange={setConvexSettingsOpen} />
    </>
  )
}
