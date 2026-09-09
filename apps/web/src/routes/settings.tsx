import { createFileRoute } from '@tanstack/react-router'
import { EnvironmentConnectForm, EnvironmentList } from '../components/connection-surfaces'
import { UI_FONTS } from '../lib/fonts'
import { useConnection } from '../providers/connection-provider'
import { useTheme, type ThemeMode } from '../providers/theme-provider'
import { cn } from '../lib/utils'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

const THEME_OPTIONS: Array<{ id: ThemeMode; label: string }> = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'black', label: 'Black' },
]

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
  options: Array<{ id: T; label: string }>
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
              <button
                type="button"
                className="mt-3 rounded-md border border-[var(--basis-border)] bg-[var(--basis-surface)] px-3 py-1.5 text-ui-sm text-[var(--basis-text)] hover:bg-[var(--basis-surface-hover)]"
                onClick={changeEnvironment}
              >
                Deselect environment
              </button>
            ) : null}
          </>
        )}
        <h3 className="mt-6 text-ui-sm font-medium text-[var(--basis-text)]">Add environment</h3>
        <p className="mt-1 text-ui-xs text-[var(--basis-text-muted)]">
          A second URL for the same environment ID updates the existing record.
        </p>
        <EnvironmentConnectForm onConnect={connect} submitLabel="Add environment" />
      </section>

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
