import { createFileRoute } from '@tanstack/react-router'
import { UI_FONTS, type UiFontId } from '../lib/fonts'
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

function SettingsPage() {
  const { theme, setTheme, font, setFont } = useTheme()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-8 py-8">
      <h1 className="text-ui-base font-medium text-[var(--basis-text-strong)]">Settings</h1>
      <p className="mt-1 max-w-lg text-ui-sm text-[var(--basis-text-muted)]">
        Appearance uses the same tokens as the desktop renderer. Environment endpoints will be
        configured here later, stored by environment ID rather than URL.
      </p>

      <section className="mt-8 max-w-lg">
        <h2 className="text-ui-sm font-medium text-[var(--basis-text)]">Theme</h2>
        <div className="mt-2 flex gap-2" role="radiogroup" aria-label="Theme">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={theme === option.id}
              className={cn(
                'rounded-md border px-3 py-1.5 text-ui-sm',
                theme === option.id
                  ? 'border-[var(--basis-border-strong)] bg-[var(--basis-surface-elevated)] text-[var(--basis-text-strong)]'
                  : 'border-[var(--basis-border)] text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface)]',
              )}
              onClick={() => setTheme(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-8 max-w-lg">
        <h2 className="text-ui-sm font-medium text-[var(--basis-text)]">Font</h2>
        <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Font">
          {UI_FONTS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={font === option.id}
              className={cn(
                'rounded-md border px-3 py-1.5 text-ui-sm',
                font === option.id
                  ? 'border-[var(--basis-border-strong)] bg-[var(--basis-surface-elevated)] text-[var(--basis-text-strong)]'
                  : 'border-[var(--basis-border)] text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface)]',
              )}
              onClick={() => setFont(option.id as UiFontId)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
