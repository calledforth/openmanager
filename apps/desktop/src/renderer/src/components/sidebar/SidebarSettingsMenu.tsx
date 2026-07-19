import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowClockwiseIcon,
  CheckIcon,
  CheckCircleIcon,
  CaretRightIcon,
  CircleIcon,
  CircleNotchIcon,
  DownloadSimpleIcon,
  HexagonIcon,
  MoonIcon,
  PaletteIcon,
  PlugIcon,
  GearIcon,
  SunIcon,
  TextTIcon,
  WarningCircleIcon,
  type Icon,
} from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { UI_FONTS, type UiFontId } from '../../lib/fonts'
import { typographyBodySm, typographyCaption } from '../../lib/typography'
import { useTheme } from '../../providers/theme-provider'
import { useAppUi } from '../../providers/app-ui-provider'
import { ConvexSettingsDialog } from '../settings/ConvexSettingsDialog'

interface ProviderRow {
  id: string
  label: string
  connected: boolean
  detail?: string
}

type MenuCoords = { left: number; bottom: number; width: number }

type UpdateCheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current'; version: string }
  | { status: 'available'; version: string }
  | { status: 'unsupported'; message: string }
  | { status: 'error'; message: string }

function MenuFlyout({
  label,
  icon: Icon,
  children,
}: {
  label: string
  icon: Icon
  children: ReactNode
}) {
  return (
    <div className="group/flyout relative">
      <div
        className={cn(
          typographyBodySm,
          'flex w-full cursor-default items-center gap-2 rounded-[var(--basis-chat-shell-radius)] px-2.5 py-1.5 text-[var(--basis-text)] transition-default group-hover/flyout:bg-[var(--basis-surface-hover)]',
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--basis-text-muted)]" />
        <span className="min-w-0 flex-1 text-left">{label}</span>
        <CaretRightIcon className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]" />
      </div>
      <div
        className={cn(
          'pointer-events-none absolute bottom-0 left-full z-[210] ml-1 min-w-[11rem] rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)] py-1 opacity-0 shadow-lg transition-opacity duration-100 group-hover/flyout:pointer-events-auto group-hover/flyout:opacity-100',
        )}
      >
        {children}
      </div>
    </div>
  )
}

export function SidebarSettingsMenu() {
  const [open, setOpen] = useState(false)
  const [convexSettingsOpen, setConvexSettingsOpen] = useState(false)
  const [updateCheckState, setUpdateCheckState] = useState<UpdateCheckState>({
    status: 'idle',
  })
  const [menuCoords, setMenuCoords] = useState<MenuCoords | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { theme, toggleTheme, font, setFont } = useTheme()
  const {
    agentStatusByProvider,
    agentUiStatusByProvider,
    acpAgentInfoByProvider,
    providers: registeredProviders,
    retryProvider,
  } = useAppUi()

  const close = useCallback(() => setOpen(false), [])
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

  const updateMenuCoords = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const width = 184
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const gap = 6
    setMenuCoords({
      left,
      bottom: window.innerHeight - rect.top + gap,
      width,
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setMenuCoords(null)
      return
    }
    updateMenuCoords()
  }, [open, updateMenuCoords])

  useEffect(() => {
    if (!open) return
    const onResizeOrScroll = () => updateMenuCoords()
    window.addEventListener('resize', onResizeOrScroll)
    window.addEventListener('scroll', onResizeOrScroll, true)
    return () => {
      window.removeEventListener('resize', onResizeOrScroll)
      window.removeEventListener('scroll', onResizeOrScroll, true)
    }
  }, [open, updateMenuCoords])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      close()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, close])

  const providers = useMemo<ProviderRow[]>(() => {
    return registeredProviders.map((provider) => {
      const uiStatus = agentUiStatusByProvider[provider.id] ?? 'disconnected'
      const status = agentStatusByProvider[provider.id] ?? 'stopped'
      const agentInfo = acpAgentInfoByProvider[provider.id]
      const label = agentInfo?.name
        ? `${agentInfo.name}${agentInfo.version ? ` ${agentInfo.version}` : ''}`
        : `${provider.displayName} ACP`
      return {
        id: provider.id,
        label,
        connected: uiStatus === 'connected',
        detail:
          uiStatus === 'connecting'
            ? 'Connecting…'
            : uiStatus === 'connected'
              ? status === 'healthy'
                ? 'Healthy'
                : status
              : 'Unavailable',
      }
    })
  }, [acpAgentInfoByProvider, agentStatusByProvider, agentUiStatusByProvider, registeredProviders])

  const disconnectedProviders = useMemo(
    () =>
      registeredProviders.filter(
        (provider) => (agentUiStatusByProvider[provider.id] ?? 'disconnected') !== 'connected',
      ),
    [agentUiStatusByProvider, registeredProviders],
  )
  const updateCheckDetail =
    updateCheckState.status === 'checking'
      ? 'Contacting update server…'
      : updateCheckState.status === 'current'
        ? `Version ${updateCheckState.version} is current`
        : updateCheckState.status === 'available'
          ? `Downloading version ${updateCheckState.version}`
          : updateCheckState.status === 'unsupported' || updateCheckState.status === 'error'
            ? updateCheckState.message
            : null
  const UpdateCheckIcon =
    updateCheckState.status === 'checking'
      ? CircleNotchIcon
      : updateCheckState.status === 'current'
        ? CheckCircleIcon
        : updateCheckState.status === 'available'
          ? DownloadSimpleIcon
          : updateCheckState.status === 'unsupported' || updateCheckState.status === 'error'
            ? WarningCircleIcon
            : ArrowClockwiseIcon

  const menu =
    open &&
    menuCoords &&
    createPortal(
      <div
        ref={menuRef}
        role="menu"
        className="fixed z-[200] rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)] py-1 shadow-lg"
        style={{
          left: menuCoords.left,
          bottom: menuCoords.bottom,
          width: menuCoords.width,
        }}
      >
        <MenuFlyout label="Appearance" icon={PaletteIcon}>
          <div className="px-1">
            <div
              className={cn(
                typographyCaption,
                'px-2 py-1 uppercase tracking-[0.1em] text-[var(--basis-text-faint)]',
              )}
            >
              Font
            </div>
            {UI_FONTS.map((option) => {
              const selected = font === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFont(option.id as UiFontId)}
                  className={cn(
                    typographyBodySm,
                    'flex w-full items-center gap-2 rounded-[var(--basis-chat-shell-radius)] px-2 py-1 text-left transition-default',
                    selected
                      ? 'bg-[var(--basis-surface-hover)] text-[var(--basis-text)]'
                      : 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
                  )}
                >
                  <TextTIcon className="h-3 w-3 shrink-0 opacity-60" />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {selected && <CheckIcon className="h-3 w-3 shrink-0 text-[var(--basis-text)]" />}
                </button>
              )
            })}
            <div className="my-1 border-t border-[var(--basis-border-muted)]" />
            <button
              type="button"
              onClick={toggleTheme}
              className={cn(
                typographyBodySm,
                'flex w-full items-center gap-2 rounded-[var(--basis-chat-shell-radius)] px-2 py-1 text-left text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
              )}
            >
              {theme === 'dark' ? (
                <SunIcon className="h-3 w-3 shrink-0" />
              ) : (
                <MoonIcon className="h-3 w-3 shrink-0" />
              )}
              <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
          </div>
        </MenuFlyout>

        <MenuFlyout label="Provider" icon={PlugIcon}>
          <div className="px-1">
            {providers.map((provider) => (
              <div
                key={provider.id}
                className={cn(
                  typographyBodySm,
                  'flex items-center gap-2 rounded-[var(--basis-chat-shell-radius)] px-2 py-1.5 text-[var(--basis-text)]',
                )}
              >
                <CircleIcon
                  weight="fill"
                  className={cn(
                    'h-2 w-2 shrink-0',
                    provider.connected ? 'text-emerald-400' : 'text-[var(--basis-text-faint)]',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{provider.label}</div>
                  {provider.detail && (
                    <div
                      className={cn(typographyCaption, 'truncate text-[var(--basis-text-faint)]')}
                    >
                      {provider.detail}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {disconnectedProviders.map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => void retryProvider(provider.id)}
                className={cn(
                  typographyCaption,
                  'mx-1 mb-0.5 mt-0.5 w-[calc(100%-0.5rem)] rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border-muted)] px-2 py-1 text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
                )}
              >
                Retry {provider.displayName}
              </button>
            ))}
          </div>
        </MenuFlyout>

        <div className="my-1 border-t border-[var(--basis-border-muted)]" />
        <button
          type="button"
          role="menuitem"
          disabled={updateCheckState.status === 'checking'}
          onClick={() => void checkForUpdates()}
          className={cn(
            typographyBodySm,
            'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[var(--basis-text)] transition-default hover:bg-[var(--basis-surface-hover)] disabled:cursor-wait',
          )}
        >
          <UpdateCheckIcon
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-[var(--basis-text-muted)]',
              updateCheckState.status === 'checking' && 'animate-spin',
              updateCheckState.status === 'current' && 'text-emerald-400',
              updateCheckState.status === 'available' && 'text-[var(--basis-action-bg)]',
              updateCheckState.status === 'error' && 'text-amber-400',
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="block">Check for updates</span>
            {updateCheckDetail && (
              <span
                className={cn(typographyCaption, 'block truncate text-[var(--basis-text-faint)]')}
                title={updateCheckDetail}
                aria-live="polite"
              >
                {updateCheckDetail}
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            close()
            setConvexSettingsOpen(true)
          }}
          className={cn(
            typographyBodySm,
            'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[var(--basis-text)] transition-default hover:bg-[var(--basis-surface-hover)]',
          )}
        >
          <HexagonIcon className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
          <span className="min-w-0 flex-1">Convex deployment</span>
        </button>
      </div>,
      document.body,
    )

  return (
    <>
      <div ref={wrapRef} className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          title="Settings"
          className="flex h-7 w-7 items-center justify-center rounded-[var(--basis-chat-shell-radius)] text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]"
        >
          <GearIcon className="h-3.5 w-3.5" />
        </button>
        {menu}
      </div>
      <ConvexSettingsDialog open={convexSettingsOpen} onOpenChange={setConvexSettingsOpen} />
    </>
  )
}
