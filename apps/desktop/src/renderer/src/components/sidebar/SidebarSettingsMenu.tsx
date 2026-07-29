import { useCallback, useMemo, useState } from 'react'
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  CircleIcon,
  CircleNotchIcon,
  DownloadSimpleIcon,
  GearIcon,
  HexagonIcon,
  MoonIcon,
  SunIcon,
  TextTIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { UI_FONTS, type UiFontId } from '../../lib/fonts'
import {
  describeProviderHealth,
  type ProviderHealthTone,
} from '../../lib/provider-health-view'
import { typographyCaption } from '../../lib/typography'
import { useTheme } from '../../providers/theme-provider'
import { useAppUi } from '../../providers/app-ui-provider'
import { ConvexSettingsDialog } from '../settings/ConvexSettingsDialog'
import { SearchableMenu, type SearchableMenuSection } from '../ui/SearchableMenu'

/** Same palette the update-check row uses, so the two footer sections read as
 * one thing. `muted` is deliberately the same faint grey as an idle provider:
 * "not checked yet" is not a warning. */
const PROVIDER_TONE_CLASS: Record<ProviderHealthTone, string> = {
  ready: 'text-emerald-400',
  warning: 'text-amber-400',
  error: 'text-red-400',
  muted: 'text-[var(--basis-text-faint)]',
}

type UpdateCheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current'; version: string }
  | { status: 'available'; version: string }
  | { status: 'unsupported'; message: string }
  | { status: 'error'; message: string }

export function SidebarSettingsMenu({
  convexOpen,
  onToggleConvex,
}: {
  convexOpen: boolean
  onToggleConvex: () => void
}) {
  const [convexSettingsOpen, setConvexSettingsOpen] = useState(false)
  const [updateCheckState, setUpdateCheckState] = useState<UpdateCheckState>({
    status: 'idle',
  })
  const { theme, toggleTheme, font, setFont } = useTheme()
  const {
    providerHealthByProvider,
    acpAgentInfoByProvider,
    providers: registeredProviders,
    retryProvider,
  } = useAppUi()

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

  const providers = useMemo(() => {
    const now = Date.now()
    return registeredProviders.map((provider) => {
      const health = describeProviderHealth(providerHealthByProvider[provider.id], now)
      const agentInfo = acpAgentInfoByProvider[provider.id]
      // The CLI's own name and version when we have heard from it, which is
      // more useful than our label for telling two installs apart.
      const label = agentInfo?.name
        ? `${agentInfo.name}${agentInfo.version ? ` ${agentInfo.version}` : ''}`
        : `${provider.displayName} ACP`
      return { id: provider.id, displayName: provider.displayName, label, health }
    })
  }, [acpAgentInfoByProvider, providerHealthByProvider, registeredProviders])

  const retryableProviders = useMemo(
    () => providers.filter((provider) => provider.health.canRetry),
    [providers],
  )

  const sections = useMemo<SearchableMenuSection[]>(
    () => [
      {
        id: 'font',
        label: 'Font',
        options: UI_FONTS.map((option) => ({
          id: option.id,
          label: option.label,
          icon: <TextTIcon className="h-3 w-3 opacity-60" />,
        })),
      },
      {
        id: 'theme',
        options: [
          {
            id: 'toggle-theme',
            label: theme === 'dark' ? 'Light mode' : 'Dark mode',
            icon:
              theme === 'dark' ? (
                <SunIcon className="h-3 w-3 text-[var(--basis-text-muted)]" />
              ) : (
                <MoonIcon className="h-3 w-3 text-[var(--basis-text-muted)]" />
              ),
          },
        ],
      },
      {
        id: 'developer',
        label: 'Developer',
        options: [
          {
            id: 'toggle-convex-trace',
            label: convexOpen ? 'Hide Convex trace' : 'Show Convex trace',
            icon: <HexagonIcon className="h-3 w-3 text-[var(--basis-text-muted)]" />,
          },
        ],
      },
    ],
    [convexOpen, theme],
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

  const footerItemClass = cn(
    'flex w-full items-center gap-2 px-2.5 py-1 text-left text-11-regular transition-colors',
    'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface)] hover:text-[var(--basis-text)]',
  )

  return (
    <>
      <SearchableMenu
        sections={sections}
        value={font}
        searchable={false}
        placement="above"
        align="end"
        minWidth={200}
        maxHeight={400}
        aria-label="Settings"
        onSelect={(optionId, sectionId) => {
          if (sectionId === 'font') {
            setFont(optionId as UiFontId)
            return false
          }
          if (optionId === 'toggle-theme') {
            toggleTheme()
            return false
          }
          if (optionId === 'toggle-convex-trace') {
            onToggleConvex()
            return false
          }
        }}
        footer={({ close }) => (
          <>
            <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--basis-text-faint)]">
              Provider
            </div>
            {providers.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center gap-2 px-2.5 py-1 text-11-regular text-[var(--basis-text)]"
              >
                {provider.health.status === 'probing' ? (
                  <CircleNotchIcon className="h-2.5 w-2.5 shrink-0 animate-spin text-[var(--basis-text-faint)]" />
                ) : (
                  <CircleIcon
                    weight="fill"
                    className={cn('h-2 w-2 shrink-0', PROVIDER_TONE_CLASS[provider.health.tone])}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate">{provider.label}</div>
                  <div
                    className={cn(typographyCaption, 'truncate text-[var(--basis-text-faint)]')}
                    title={provider.health.detail ?? provider.health.label}
                  >
                    {provider.health.label}
                    {provider.health.detail ? ` · ${provider.health.detail}` : ''}
                  </div>
                </div>
              </div>
            ))}
            {retryableProviders.map((provider) => (
              <button
                key={`retry:${provider.id}`}
                type="button"
                onClick={() => void retryProvider(provider.id)}
                className={footerItemClass}
              >
                <ArrowClockwiseIcon className="h-3 w-3 shrink-0 text-[var(--basis-text-muted)]" />
                <span>Retry {provider.displayName}</span>
              </button>
            ))}

            <div className="my-1 h-px bg-[var(--basis-border-muted)]" />

            <button
              type="button"
              disabled={updateCheckState.status === 'checking'}
              onClick={() => void checkForUpdates()}
              className={cn(footerItemClass, 'disabled:cursor-wait')}
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
                    className={cn(
                      typographyCaption,
                      'block truncate text-[var(--basis-text-faint)]',
                    )}
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
              onClick={() => {
                close()
                setConvexSettingsOpen(true)
              }}
              className={footerItemClass}
            >
              <HexagonIcon className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
              <span className="min-w-0 flex-1">Convex deployment</span>
            </button>
          </>
        )}
        trigger={({ ref, open, toggle }) => (
          <button
            ref={ref}
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-haspopup="menu"
            title="Settings"
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-[var(--basis-chat-shell-radius)] text-[var(--basis-text-muted)] transition-default',
              'hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
              open && 'bg-[var(--basis-surface-hover)] text-[var(--basis-text)]',
            )}
          >
            <GearIcon className="h-3.5 w-3.5" />
          </button>
        )}
      />
      <ConvexSettingsDialog open={convexSettingsOpen} onOpenChange={setConvexSettingsOpen} />
    </>
  )
}
