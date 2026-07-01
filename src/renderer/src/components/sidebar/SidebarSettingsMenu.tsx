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
  Check,
  ChevronRight,
  Circle,
  Moon,
  Palette,
  Plug,
  Settings,
  Sun,
  Type,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { UI_FONTS, type UiFontId } from '../../lib/fonts'
import { typographyBodySm, typographyCaption } from '../../lib/typography'
import { useTheme } from '../../providers/theme-provider'
import { useAppUi } from '../../providers/app-ui-provider'

interface ProviderRow {
  id: string
  label: string
  connected: boolean
  detail?: string
}

type MenuCoords = { left: number; bottom: number; width: number }

function formatProviderLabel(id: string): string {
  return id
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function extractModelProviders(
  models: Array<{ modelId: string }> | undefined,
): ProviderRow[] {
  if (!models?.length) return []
  const seen = new Set<string>()
  const rows: ProviderRow[] = []
  for (const model of models) {
    const providerId = model.modelId.split('/')[0]
    if (!providerId || seen.has(providerId)) continue
    seen.add(providerId)
    rows.push({
      id: providerId,
      label: formatProviderLabel(providerId),
      connected: true,
    })
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label))
}

function MenuFlyout({
  label,
  icon: Icon,
  children,
}: {
  label: string
  icon: typeof Palette
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
        <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--basis-text-muted)]" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 text-left">{label}</span>
        <ChevronRight className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]" strokeWidth={1.75} />
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
  const [menuCoords, setMenuCoords] = useState<MenuCoords | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { theme, toggleTheme, font, setFont } = useTheme()
  const {
    openCodeUiStatus,
    openCodeStatus,
    acpSessionState,
    draftSessionState,
    acpAgentInfo,
    retryOpenCode,
  } = useAppUi()

  const close = useCallback(() => setOpen(false), [])

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

  const modelProviders = useMemo(() => {
    const models =
      acpSessionState?.models?.availableModels ??
      draftSessionState?.models?.availableModels ??
      []
    return extractModelProviders(models)
  }, [acpSessionState, draftSessionState])

  const providers = useMemo<ProviderRow[]>(() => {
    const runtimeLabel = acpAgentInfo?.name
      ? `${acpAgentInfo.name}${acpAgentInfo.version ? ` ${acpAgentInfo.version}` : ''}`
      : 'OpenCode ACP'

    const runtime: ProviderRow = {
      id: 'opencode-acp',
      label: runtimeLabel,
      connected: openCodeUiStatus === 'connected',
      detail:
        openCodeUiStatus === 'connecting'
          ? 'Connecting…'
          : openCodeUiStatus === 'connected'
            ? openCodeStatus === 'healthy'
              ? 'Healthy'
              : openCodeStatus
            : 'Unavailable',
    }

    return [runtime, ...modelProviders]
  }, [acpAgentInfo, modelProviders, openCodeStatus, openCodeUiStatus])

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
        <MenuFlyout label="Appearance" icon={Palette}>
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
                  <Type className="h-3 w-3 shrink-0 opacity-60" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {selected && (
                    <Check className="h-3 w-3 shrink-0 text-[var(--basis-text)]" strokeWidth={2} />
                  )}
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
                <Sun className="h-3 w-3 shrink-0" strokeWidth={1.75} />
              ) : (
                <Moon className="h-3 w-3 shrink-0" strokeWidth={1.75} />
              )}
              <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
          </div>
        </MenuFlyout>

        <MenuFlyout label="Provider" icon={Plug}>
          <div className="px-1">
            {providers.map((provider) => (
              <div
                key={provider.id}
                className={cn(
                  typographyBodySm,
                  'flex items-center gap-2 rounded-[var(--basis-chat-shell-radius)] px-2 py-1.5 text-[var(--basis-text)]',
                )}
              >
                <Circle
                  className={cn(
                    'h-2 w-2 shrink-0 fill-current',
                    provider.connected ? 'text-emerald-400' : 'text-[var(--basis-text-faint)]',
                  )}
                  strokeWidth={0}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{provider.label}</div>
                  {provider.detail && (
                    <div className={cn(typographyCaption, 'truncate text-[var(--basis-text-faint)]')}>
                      {provider.detail}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {openCodeUiStatus !== 'connected' && (
              <button
                type="button"
                onClick={() => void retryOpenCode()}
                className={cn(
                  typographyCaption,
                  'mx-1 mb-0.5 mt-0.5 w-[calc(100%-0.5rem)] rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border-muted)] px-2 py-1 text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
                )}
              >
                Retry connection
              </button>
            )}
          </div>
        </MenuFlyout>
      </div>,
      document.body,
    )

  return (
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
        <Settings className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      {menu}
    </div>
  )
}
