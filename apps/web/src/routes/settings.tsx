import { useContext, useMemo, type ReactNode } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
import {
  TabsSubtle,
  TabsSubtleItem,
  TabsSubtlePanel,
} from '@openmanager/app-core/components/fluid/ui/tabs-subtle'
import { ProviderIcon } from '@openmanager/app-core/components/providers/ProviderIcon'
import {
  describeProviderHealth,
  type ProviderHealthTone,
} from '@openmanager/app-core/lib/provider-health-view'
import { PlatformCapabilitiesContext } from '@openmanager/app-core/providers/platform-provider'
import { SessionStateContext } from '@openmanager/app-core/providers/session-provider'
import { EnvironmentConnectForm, EnvironmentList } from '../components/connection-surfaces'
import { UI_FONTS } from '../lib/fonts'
import { useConnection } from '../providers/connection-provider'
import { THEME_OPTIONS } from '@openmanager/app-core/providers/theme-provider'
import { useTheme } from '../providers/theme-provider'
import { cn } from '../lib/utils'

const SETTINGS_TABS = [
  { id: 'environments', label: 'Environments' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'providers', label: 'Providers' },
] as const

type SettingsTab = (typeof SETTINGS_TABS)[number]['id']

function isSettingsTab(value: unknown): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.id === value)
}

export const Route = createFileRoute('/settings')({
  // The tab lives in the URL, so a section can be linked to and survives a reload.
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTab } =>
    isSettingsTab(search.tab) ? { tab: search.tab } : {},
  component: SettingsPage,
})

/** One titled block of a settings tab. */
function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mt-8 first:mt-0">
      <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
      {description ? <p className="mt-1 text-[13px] text-muted-foreground">{description}</p> : null}
      {children}
    </section>
  )
}

function ChoiceGroup<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string
  label: string
  value: T
  options: ReadonlyArray<{ id: T; label: string }>
  onChange: (id: T) => void
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const selected = value === option.id
        return (
          <label
            key={option.id}
            className={cn(
              // Selection is a fill, never an outline.
              'cursor-pointer rounded-md px-3 py-1.5 text-[13px] transition-colors duration-100',
              'has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-focus-ring',
              selected
                ? 'bg-active text-foreground'
                : 'text-muted-foreground hover:bg-hover hover:text-foreground',
            )}
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={option.id}
              checked={selected}
              onChange={() => onChange(option.id)}
            />
            {option.label}
          </label>
        )
      })}
    </div>
  )
}

const PROVIDER_TONE_CLASS: Record<ProviderHealthTone, string> = {
  ready: 'bg-emerald-400',
  warning: 'bg-amber-400',
  error: 'bg-red-400',
  muted: 'bg-[var(--basis-text-faint)]',
}

/**
 * Provider health as the environment reports it, with the same wording as the
 * desktop settings menu. Settings also renders with no environment connected,
 * where there are no providers to describe and the section stays out.
 */
function ProvidersPanel() {
  const platform = useContext(PlatformCapabilitiesContext)
  const activeWorkspacePath = useContext(SessionStateContext)?.activeWorkspacePath ?? null
  const rows = useMemo(() => {
    const now = Date.now()
    return (platform?.providers ?? []).map((provider) => {
      const health = describeProviderHealth(platform?.providerHealthByProvider[provider.id], now)
      // A probe this client just asked for reads as checking straight away.
      const checking = platform?.agentUiStatusByProvider[provider.id] === 'probing'
      const agentInfo = platform?.acpAgentInfoByProvider[provider.id]
      return {
        id: provider.id,
        displayName: provider.displayName,
        name: agentInfo?.name
          ? `${agentInfo.name}${agentInfo.version ? ` ${agentInfo.version}` : ''}`
          : provider.displayName,
        health: checking
          ? { ...health, label: 'Checking…', tone: 'muted' as const, canRetry: false }
          : health,
      }
    })
  }, [platform])
  if (!platform) {
    return (
      <SettingsSection title="Providers">
        <p className="mt-2 text-[13px] text-muted-foreground">
          Connect to an environment to see its providers.
        </p>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection
      title="Providers"
      description="The coding agents this environment can run, and whether each is ready."
    >
      {rows.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          This environment has not reported any providers.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-3 rounded-lg bg-hover/70 px-3 py-2.5">
              <ProviderIcon providerId={row.id} className="h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-foreground">{row.name}</div>
                <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <span
                    aria-hidden
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      PROVIDER_TONE_CLASS[row.health.tone],
                    )}
                  />
                  <span className="truncate">
                    {row.health.label}
                    {row.health.detail ? ` · ${row.health.detail}` : ''}
                  </span>
                </div>
              </div>
              {row.health.canRetry ? (
                <Button
                  type="button"
                  variant="tertiary"
                  aria-label={`Retry ${row.displayName}`}
                  onClick={() => void platform.retryProvider(row.id, activeWorkspacePath ?? '')}
                >
                  Retry
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {platform.error ? (
        <p role="alert" className="mt-2 text-[12px] text-destructive">
          {platform.error}
        </p>
      ) : null}
    </SettingsSection>
  )
}

function EnvironmentsPanel() {
  const {
    ui,
    environments,
    selectedId,
    connect,
    selectEnvironment,
    removeEnvironment,
    changeEnvironment,
  } = useConnection()
  const status = `${ui.title}${ui.environmentLabel ? ` · ${ui.environmentLabel}` : ''}`

  return (
    <>
      <SettingsSection
        title="Saved environments"
        description={
          <>
            {status}. Environments are keyed by their bootstrap ID; each keeps its endpoints and an
            optional client token.
          </>
        }
      >
        {environments.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted-foreground">No environments yet.</p>
        ) : (
          <>
            <EnvironmentList
              environments={environments}
              selectedId={selectedId}
              onSelect={selectEnvironment}
              onRemove={removeEnvironment}
            />
            {selectedId ? (
              <Button type="button" variant="tertiary" className="mt-3" onClick={changeEnvironment}>
                Deselect environment
              </Button>
            ) : null}
          </>
        )}
      </SettingsSection>
      <SettingsSection
        title="Add environment"
        description="A second URL for the same environment ID updates the existing record."
      >
        <EnvironmentConnectForm
          className="mt-3"
          onConnect={connect}
          submitLabel="Add environment"
        />
      </SettingsSection>
    </>
  )
}

function AppearancePanel() {
  const { theme, setTheme, font, setFont } = useTheme()
  return (
    <>
      <SettingsSection title="Theme">
        <ChoiceGroup
          name="theme"
          label="Theme"
          value={theme}
          options={THEME_OPTIONS}
          onChange={setTheme}
        />
      </SettingsSection>
      <SettingsSection title="Font">
        <ChoiceGroup name="font" label="Font" value={font} options={UI_FONTS} onChange={setFont} />
      </SettingsSection>
    </>
  )
}

const PANELS: Record<SettingsTab, () => ReactNode> = {
  environments: EnvironmentsPanel,
  appearance: AppearancePanel,
  providers: ProvidersPanel,
}

function SettingsPage() {
  const navigate = useNavigate()
  const tab = Route.useSearch().tab ?? 'environments'
  const selectedIndex = SETTINGS_TABS.findIndex((item) => item.id === tab)
  const Panel = PANELS[tab]

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-8 pb-10 pt-4">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-[18px] font-medium text-foreground">Settings</h1>
        <TabsSubtle
          aria-label="Settings sections"
          idPrefix="settings"
          size="compact"
          className="mt-4"
          selectedIndex={selectedIndex}
          onSelect={(index) =>
            void navigate({
              to: '/settings',
              search: { tab: SETTINGS_TABS[index]!.id },
              replace: true,
            })
          }
        >
          {SETTINGS_TABS.map((item, index) => (
            <TabsSubtleItem key={item.id} index={index} label={item.label} />
          ))}
        </TabsSubtle>
        {SETTINGS_TABS.map((item, index) => (
          <TabsSubtlePanel
            key={item.id}
            index={index}
            selectedIndex={selectedIndex}
            idPrefix="settings"
            className="mt-8"
          >
            <Panel />
          </TabsSubtlePanel>
        ))}
      </div>
    </div>
  )
}
