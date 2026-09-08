import { createFileRoute } from '@tanstack/react-router'
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
  const { ui, environment, changeEnvironment } = useConnection()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-8 py-8">
      <h1 className="text-ui-base font-medium text-[var(--basis-text-strong)]">Settings</h1>
      <p className="mt-1 max-w-lg text-ui-sm text-[var(--basis-text-muted)]">
        Appearance uses the same tokens as the desktop renderer. The stored environment is keyed
        by the bootstrap environment ID once the server answers.
      </p>

      <section className="mt-8 max-w-lg">
        <h2 className="text-ui-sm font-medium text-[var(--basis-text)]">Environment</h2>
        {environment.status === 'none' ? (
          <p className="mt-2 text-ui-sm text-[var(--basis-text-muted)]">
            No environment is configured. The first-run screen asks for an endpoint.
          </p>
        ) : (
          <>
            <p className="mt-2 text-ui-sm text-[var(--basis-text-muted)]">
              {environment.label ?? 'Unnamed environment'}
              {environment.environmentId ? ` · ${environment.environmentId}` : ''}
            </p>
            <p className="mt-1 font-mono text-ui-xs text-[var(--basis-text-faint)]">
              {environment.endpoint}
            </p>
            <p className="mt-1 text-ui-xs text-[var(--basis-text-muted)]">{ui.title}</p>
            <button
              type="button"
              className="mt-3 rounded-md border border-[var(--basis-border)] bg-[var(--basis-surface)] px-3 py-1.5 text-ui-sm text-[var(--basis-text)] hover:bg-[var(--basis-surface-hover)]"
              onClick={changeEnvironment}
            >
              Change environment
            </button>
          </>
        )}
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
