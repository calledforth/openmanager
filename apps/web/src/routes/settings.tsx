import { useContext, useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
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

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

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
              'cursor-pointer rounded-md border px-3 py-1.5 text-ui-sm',
              selected
                ? 'border-[var(--basis-border-strong)] bg-[var(--basis-surface-elevated)] text-[var(--basis-text-strong)]'
                : 'border-[var(--basis-border)] text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface)]',
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
function ProvidersSection() {
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
  if (!platform) return null

  return (
    <section className="mt-8 max-w-lg">
      <h2 className="text-ui-sm font-medium text-[var(--basis-text)]">Providers</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-ui-sm text-[var(--basis-text-muted)]">
          This environment has not reported any providers.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-[var(--basis-border-muted)] rounded-md border border-[var(--basis-border)]">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-3 px-3 py-2">
              <ProviderIcon providerId={row.id} className="h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-ui-sm text-[var(--basis-text)]">{row.name}</div>
                <div className="flex items-center gap-1.5 text-ui-xs text-[var(--basis-text-muted)]">
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
        <p role="alert" className="mt-2 text-ui-xs text-red-400">
          {platform.error}
        </p>
      ) : null}
    </section>
  )
}

function SettingsPage() {
  const { theme, setTheme, font, setFont } = useTheme()
  const { ui, environments, selectedId, connect, selectEnvironment, removeEnvironment, changeEnvironment } =
    useConnection()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-8 py-8">
      <h1 className="text-ui-base font-medium text-[var(--basis-text-strong)]">Settings</h1>
      <p className="mt-1 max-w-lg text-ui-sm text-[var(--basis-text-muted)]">
        Appearance uses the same tokens as the desktop renderer. Environments are stored by
        bootstrap ID, with a list of endpoints and an optional client token.
      </p>

      <section className="mt-8 max-w-lg">
        <h2 className="text-ui-sm font-medium text-[var(--basis-text)]">Environment</h2>
        <p className="mt-1 text-ui-xs text-[var(--basis-text-muted)]">{ui.title}</p>
        {environments.length === 0 ? (
          <p className="mt-2 text-ui-sm text-[var(--basis-text-muted)]">
            No environments yet. Add an endpoint URL; the shell keys the record by the bootstrap
            environment ID.
          </p>
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
        <h3 className="mt-6 text-ui-sm font-medium text-[var(--basis-text)]">Add environment</h3>
        <p className="mt-1 text-ui-xs text-[var(--basis-text-muted)]">
          A second URL for the same environment ID updates the existing record.
        </p>
        <EnvironmentConnectForm className="mt-3" onConnect={connect} submitLabel="Add environment" />
      </section>

      <ProvidersSection />

      <section className="mt-8 max-w-lg">
        <h2 className="text-ui-sm font-medium text-[var(--basis-text)]">Theme</h2>
        <ChoiceGroup
          name="theme"
          label="Theme"
          value={theme}
          options={THEME_OPTIONS}
          onChange={setTheme}
        />
      </section>

      <section className="mt-8 max-w-lg">
        <h2 className="text-ui-sm font-medium text-[var(--basis-text)]">Font</h2>
        <ChoiceGroup name="font" label="Font" value={font} options={UI_FONTS} onChange={setFont} />
      </section>
    </div>
  )
}
