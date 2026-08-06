import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CircleIcon,
  CircleNotchIcon,
  GearIcon,
  HexagonIcon,
  MoonIcon,
  SunIcon,
  TextTIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { ProviderId } from '@agentpack/contract'
import { cn } from '../../lib/utils'
import { UI_FONTS, type UiFontId } from '../../lib/fonts'
import { describeProviderHealth, type ProviderHealthTone } from '../../lib/provider-health-view'
import { typographyBodySm, typographyCaption, typographyLabel } from '../../lib/typography'
import { useTheme, type ThemeMode } from '../../providers/theme-provider'
import { useAppUi } from '../../providers/app-ui-provider'
import { Tooltip } from '../ui/Tooltip'
import { usePortaledMenu } from '../ui/usePortaledMenu'
import { ProviderIcon } from '../providers/ProviderIcon'

const PROVIDER_TONE_CLASS: Record<ProviderHealthTone, string> = {
  ready: 'text-emerald-400',
  warning: 'text-amber-400',
  error: 'text-red-400',
  muted: 'text-[var(--basis-text-faint)]',
}

type SelectOption = {
  id: string
  label: string
  icon?: ReactNode
}

function SettingsSelect({
  id,
  value,
  options,
  onChange,
  'aria-label': ariaLabel,
}: {
  id: string
  value: string
  options: SelectOption[]
  onChange: (id: string) => void
  'aria-label'?: string
}) {
  const listId = useId()
  const { open, toggle, close, menuCoords, wrapRef, triggerRef, menuRef } = usePortaledMenu({
    placement: 'below',
    align: 'start',
    minWidth: 180,
  })
  const selected = options.find((option) => option.id === value) ?? options[0]

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        onClick={toggle}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-md border border-[var(--basis-border)]',
          'bg-[color-mix(in_srgb,var(--basis-canvas-bg)_85%,#000)] px-2.5 text-left text-11-regular leading-tight text-[var(--basis-text)]',
          'outline-none transition-colors',
          'hover:border-[var(--basis-border)] hover:bg-[var(--basis-surface)]',
          open && 'border-[var(--basis-border)] bg-[var(--basis-surface)]',
        )}
      >
        {selected?.icon && <span className="shrink-0">{selected.icon}</span>}
        <span className="min-w-0 flex-1 truncate">{selected?.label}</span>
        <CaretDownIcon
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-[var(--basis-text-faint)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open &&
        menuCoords &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className={cn(
              'fixed z-[520] overflow-hidden rounded-md border border-[var(--basis-border)]',
              'bg-[color-mix(in_srgb,var(--basis-canvas-bg)_85%,#000)] py-0.5 shadow-xl',
            )}
            style={{
              left: menuCoords.left,
              top: menuCoords.top,
              bottom: menuCoords.bottom,
              width: Math.max(menuCoords.width, 180),
            }}
          >
            {options.map((option) => {
              const isSelected = option.id === value
              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(option.id)
                    close()
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-11-regular leading-tight transition-colors',
                    isSelected
                      ? 'bg-[var(--basis-surface)] text-[var(--basis-text-strong)]'
                      : 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface)] hover:text-[var(--basis-text)]',
                  )}
                >
                  {option.icon && <span className="shrink-0">{option.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </div>
  )
}

export function ExtraSettingsDialog({
  open,
  onOpenChange,
  convexOpen,
  onToggleConvex,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  convexOpen: boolean
  onToggleConvex: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const { theme, setTheme, font, setFont } = useTheme()
  const {
    providerHealthByProvider,
    acpAgentInfoByProvider,
    providers: registeredProviders,
    retryProvider,
  } = useAppUi()

  const providers = useMemo(() => {
    const now = Date.now()
    return registeredProviders.map((provider) => {
      const health = describeProviderHealth(providerHealthByProvider[provider.id], now)
      const agentInfo = acpAgentInfoByProvider[provider.id]
      const label = agentInfo?.name
        ? `${agentInfo.name}${agentInfo.version ? ` ${agentInfo.version}` : ''}`
        : `${provider.displayName} ACP`
      return {
        id: provider.id as ProviderId,
        displayName: provider.displayName,
        label,
        health,
      }
    })
  }, [acpAgentInfoByProvider, providerHealthByProvider, registeredProviders])

  const retryableProviders = useMemo(
    () => providers.filter((provider) => provider.health.canRetry),
    [providers],
  )

  const fontOptions = useMemo<SelectOption[]>(
    () =>
      UI_FONTS.map((option) => ({
        id: option.id,
        label: option.label,
        icon: <TextTIcon className="h-3.5 w-3.5 text-[var(--basis-text-muted)]" />,
      })),
    [],
  )

  const themeOptions = useMemo<SelectOption[]>(
    () => [
      {
        id: 'light',
        label: 'Light',
        icon: <SunIcon className="h-3.5 w-3.5 text-[var(--basis-text-muted)]" />,
      },
      {
        id: 'dark',
        label: 'Dark',
        icon: <MoonIcon className="h-3.5 w-3.5 text-[var(--basis-text-muted)]" />,
      },
    ],
    [],
  )

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false)
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
  }, [onOpenChange, open])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/60 p-6 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false)
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="extra-settings-title"
        className="w-full max-w-[520px] overflow-hidden rounded-[10px] border border-[var(--basis-border)] bg-[color-mix(in_srgb,var(--basis-canvas-bg)_88%,#000)] shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--basis-border-muted)] px-5 py-3">
          <div className="flex items-center gap-2">
            <GearIcon className="h-4 w-4 text-[var(--basis-text-muted)]" />
            <h2
              id="extra-settings-title"
              className="text-13-medium text-[var(--basis-text-strong)]"
            >
              Extra Settings
            </h2>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close extra settings"
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label
                htmlFor="extra-settings-font"
                className={cn(
                  typographyLabel,
                  'flex items-center gap-1.5 text-[var(--basis-text)]',
                )}
              >
                <TextTIcon className="h-3.5 w-3.5 text-[var(--basis-text-muted)]" />
                Font
              </label>
              <SettingsSelect
                id="extra-settings-font"
                aria-label="Font"
                value={font}
                options={fontOptions}
                onChange={(next) => setFont(next as UiFontId)}
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="extra-settings-theme"
                className={cn(
                  typographyLabel,
                  'flex items-center gap-1.5 text-[var(--basis-text)]',
                )}
              >
                {theme === 'dark' ? (
                  <MoonIcon className="h-3.5 w-3.5 text-[var(--basis-text-muted)]" />
                ) : (
                  <SunIcon className="h-3.5 w-3.5 text-[var(--basis-text-muted)]" />
                )}
                Theme
              </label>
              <SettingsSelect
                id="extra-settings-theme"
                aria-label="Theme"
                value={theme}
                options={themeOptions}
                onChange={(next) => setTheme(next as ThemeMode)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className={cn(typographyLabel, 'text-[var(--basis-text)]')}>Providers</div>
            <div className="overflow-hidden rounded-md border border-[var(--basis-border-muted)] bg-[color-mix(in_srgb,var(--basis-canvas-bg)_78%,#000)]">
              {providers.map((provider, index) => (
                <div
                  key={provider.id}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2',
                    index > 0 && 'border-t border-[var(--basis-border-muted)]',
                  )}
                >
                  <ProviderIcon providerId={provider.id} className="h-4 w-4" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-11-regular leading-tight text-[var(--basis-text)]">
                      {provider.label}
                    </div>
                    <Tooltip
                      content={provider.health.detail ?? provider.health.label}
                      side="bottom"
                      align="start"
                    >
                      <div
                        className={cn(
                          typographyCaption,
                          'truncate leading-tight text-[var(--basis-text-faint)]',
                        )}
                      >
                        {provider.health.label}
                        {provider.health.detail ? ` · ${provider.health.detail}` : ''}
                      </div>
                    </Tooltip>
                  </div>
                  {provider.health.status === 'probing' ? (
                    <CircleNotchIcon className="h-3 w-3 shrink-0 animate-spin text-[var(--basis-text-faint)]" />
                  ) : (
                    <CircleIcon
                      weight="fill"
                      className={cn('h-2 w-2 shrink-0', PROVIDER_TONE_CLASS[provider.health.tone])}
                    />
                  )}
                </div>
              ))}
              {retryableProviders.map((provider) => (
                <button
                  key={`retry:${provider.id}`}
                  type="button"
                  onClick={() => void retryProvider(provider.id)}
                  className="flex w-full items-center gap-2 border-t border-[var(--basis-border-muted)] px-3 py-1.5 text-left text-11-regular leading-tight text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface)] hover:text-[var(--basis-text)]"
                >
                  <ArrowClockwiseIcon className="h-3 w-3 shrink-0" />
                  <span>Retry {provider.displayName}</span>
                </button>
              ))}
              {providers.length === 0 && (
                <div className={cn(typographyBodySm, 'px-3 py-3 text-[var(--basis-text-faint)]')}>
                  No providers registered
                </div>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className={cn(typographyLabel, 'text-[var(--basis-text)]')}>Developer</div>
            <button
              type="button"
              onClick={onToggleConvex}
              className={cn(
                'flex w-full items-center gap-2 rounded-md border border-[var(--basis-border-muted)] bg-[color-mix(in_srgb,var(--basis-canvas-bg)_78%,#000)] px-3 py-2',
                'text-left text-11-regular leading-tight text-[var(--basis-text)] transition-colors',
                'hover:bg-[var(--basis-surface)]',
              )}
            >
              <HexagonIcon className="h-3.5 w-3.5 shrink-0 text-[var(--basis-text-muted)]" />
              <span className="min-w-0 flex-1">
                {convexOpen ? 'Hide Convex trace' : 'Show Convex trace'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
