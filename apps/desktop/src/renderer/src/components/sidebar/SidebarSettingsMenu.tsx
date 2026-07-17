import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  Circle,
  Hexagon,
  Moon,
  Plug,
  Settings,
  Sun,
  Type,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { UI_FONTS, type UiFontId } from '../../lib/fonts'
import { typographyBodySm, typographyCaption, typographyLabelSm } from '../../lib/typography'
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

function formatProviderLabel(id: string): string {
  return id
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function extractModelProviders(models: Array<{ modelId?: unknown }> | undefined): ProviderRow[] {
  if (!models?.length) return []
  const seen = new Set<string>()
  const rows: ProviderRow[] = []
  for (const model of models) {
    if (typeof model.modelId !== 'string' || !model.modelId.trim()) continue
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

function SectionLabel({ children }: { children: string }) {
  return (
    <div
      className={cn(
        typographyCaption,
        'px-2.5 pb-1 pt-2 uppercase tracking-[0.12em] text-[var(--basis-text-faint)]',
      )}
    >
      {children}
    </div>
  )
}

export function SidebarSettingsMenu() {
  const [open, setOpen] = useState(false)
  const [convexSettingsOpen, setConvexSettingsOpen] = useState(false)
  const [menuCoords, setMenuCoords] = useState<MenuCoords | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { theme, setTheme, font, setFont } = useTheme()
  const {
    agentStatusByProvider,
    agentUiStatusByProvider,
    acpSessionState,
    draftSessionState,
    acpAgentInfoByProvider,
    providers: registeredProviders,
    retryProvider,
  } = useAppUi()

  const close = useCallback(() => setOpen(false), [])

  const updateMenuCoords = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const width = 248
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const gap = 8
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
      acpSessionState?.models?.availableModels ?? draftSessionState?.models?.availableModels ?? []
    return extractModelProviders(models)
  }, [acpSessionState, draftSessionState])

  const providers = useMemo<ProviderRow[]>(() => {
    const runtimeRows = registeredProviders.map((provider) => {
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

    return [...runtimeRows, ...modelProviders]
  }, [acpAgentInfoByProvider, agentStatusByProvider, agentUiStatusByProvider, modelProviders, registeredProviders])

  const disconnectedProviders = useMemo(
    () =>
      registeredProviders.filter(
        (provider) => (agentUiStatusByProvider[provider.id] ?? 'disconnected') !== 'connected',
      ),
    [agentUiStatusByProvider, registeredProviders],
  )

  const menu =
    open &&
    menuCoords &&
    createPortal(
      <div
        ref={menuRef}
        role="menu"
        className="fixed z-[200] overflow-hidden rounded-lg border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)] shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
        style={{
          left: menuCoords.left,
          bottom: menuCoords.bottom,
          width: menuCoords.width,
        }}
      >
        <SectionLabel>Appearance</SectionLabel>
        <div className="px-2.5 pb-2">
          <div className="mb-1.5 flex items-center gap-1.5 text-[var(--basis-text-muted)]">
            {theme === 'dark' ? (
              <Moon className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            ) : (
              <Sun className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            )}
            <span className={typographyLabelSm}>Theme</span>
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-md border border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] p-0.5">
            {(['dark', 'light'] as const).map((mode) => {
              const selected = theme === mode
              return (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => setTheme(mode)}
                  className={cn(
                    typographyBodySm,
                    'rounded-[5px] px-2 py-1.5 capitalize transition-default',
                    selected
                      ? 'bg-[var(--basis-surface-hover)] text-[var(--basis-text-strong)]'
                      : 'text-[var(--basis-text-muted)] hover:text-[var(--basis-text)]',
                  )}
                >
                  {mode}
                </button>
              )
            })}
          </div>
        </div>

        <div className="px-2.5 pb-2">
          <div className="mb-1.5 flex items-center gap-1.5 text-[var(--basis-text-muted)]">
            <Type className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            <span className={typographyLabelSm}>Font</span>
          </div>
          <div className="space-y-0.5">
            {UI_FONTS.map((option) => {
              const selected = font === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => setFont(option.id as UiFontId)}
                  className={cn(
                    typographyBodySm,
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-default',
                    selected
                      ? 'bg-[var(--basis-surface-hover)] text-[var(--basis-text-strong)]'
                      : 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {selected && (
                    <Check className="h-3 w-3 shrink-0 text-[var(--basis-text)]" strokeWidth={2} />
                  )}
                </button>
              )
            })}
          </div>
        </div>

        <div className="mx-2.5 border-t border-[var(--basis-border-muted)]" />

        <SectionLabel>Providers</SectionLabel>
        <div className="px-1.5 pb-2">
          {providers.length === 0 ? (
            <div
              className={cn(
                typographyCaption,
                'px-2 py-2 text-[var(--basis-text-faint)]',
              )}
            >
              No providers connected
            </div>
          ) : (
            providers.map((provider) => (
              <div
                key={provider.id}
                className={cn(
                  typographyBodySm,
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-[var(--basis-text)]',
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
                    <div
                      className={cn(typographyCaption, 'truncate text-[var(--basis-text-faint)]')}
                    >
                      {provider.detail}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
          {disconnectedProviders.map((provider) => (
            <button
              key={`retry-${provider.id}`}
              type="button"
              onClick={() => void retryProvider(provider.id)}
              className={cn(
                typographyCaption,
                'mx-1 mb-0.5 mt-0.5 w-[calc(100%-0.5rem)] rounded-md border border-[var(--basis-border-muted)] px-2 py-1.5 text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
              )}
            >
              Retry {provider.displayName}
            </button>
          ))}
        </div>

        <div className="border-t border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] p-1.5">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close()
              setConvexSettingsOpen(true)
            }}
            className={cn(
              typographyBodySm,
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--basis-text)] transition-default hover:bg-[var(--basis-surface-hover)]',
            )}
          >
            <Hexagon className="h-3.5 w-3.5 shrink-0 text-emerald-400" strokeWidth={1.75} />
            <span className="min-w-0 flex-1">Convex deployment</span>
            <Plug className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]" strokeWidth={1.75} />
          </button>
        </div>
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
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
            open && 'bg-[var(--basis-surface-hover)] text-[var(--basis-text)]',
          )}
        >
          <Settings className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span className={cn(typographyCaption, 'pr-0.5')}>Settings</span>
        </button>
        {menu}
      </div>
      <ConvexSettingsDialog open={convexSettingsOpen} onOpenChange={setConvexSettingsOpen} />
    </>
  )
}
