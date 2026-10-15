import {
  THEME_FAMILIES,
  familyVariant,
  type ColorScheme,
  type ThemeFamilyId,
  type ThemePicks,
  type ThemeSwatch,
} from '@openmanager/app-core/providers/theme-provider'
import { cn } from '../lib/utils'

/**
 * A miniature of the app in one scheme: the rail, a sent message, a reply and
 * the composer with its send button. Painted from the variant's swatch, since
 * a preview can't take on a `:root` scheme of its own. A faint hairline keeps
 * a light preview's edge on a light page.
 */
export function ThemePreview({ swatch, className }: { swatch: ThemeSwatch; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'flex aspect-[16/10] overflow-hidden rounded-md shadow-[inset_0_0_0_1px_rgb(var(--overlay)/0.06)] transition-colors duration-200',
        className,
      )}
      style={{ backgroundColor: swatch.canvas }}
    >
      <div
        className="flex w-[28%] flex-col gap-[5px] px-[7%] pt-[9%]"
        style={{ backgroundColor: swatch.rail }}
      >
        <span className="h-[3px] w-full rounded-full" style={{ backgroundColor: swatch.muted }} />
        <span className="h-[3px] w-3/4 rounded-full" style={{ backgroundColor: swatch.muted }} />
        <span className="h-[3px] w-5/6 rounded-full" style={{ backgroundColor: swatch.muted }} />
      </div>
      <div className="flex flex-1 flex-col px-[7%] pb-[7%] pt-[9%]">
        <span
          className="ml-auto h-[11px] w-[46%] rounded-[4px]"
          style={{ backgroundColor: swatch.bubble }}
        />
        <span
          className="mt-[9%] h-[3px] w-[88%] rounded-full opacity-80"
          style={{ backgroundColor: swatch.ink }}
        />
        <span
          className="mt-[5px] h-[3px] w-[64%] rounded-full opacity-80"
          style={{ backgroundColor: swatch.ink }}
        />
        <span
          className="mt-auto flex h-[15px] items-center justify-end rounded-[5px] px-[3px]"
          style={{ backgroundColor: swatch.bubble }}
        >
          <span className="size-[9px] rounded-full" style={{ backgroundColor: swatch.accent }} />
        </span>
      </div>
    </div>
  )
}

/**
 * The theme families as cards. Each card previews its family in the scheme on
 * screen, as the family would show (with its picked variant), so switching the
 * mode flips every card with the app. Selection is a fill, never an outline.
 */
export function ThemeFamilyPicker({
  value,
  scheme,
  picks,
  onChange,
}: {
  value: ThemeFamilyId
  scheme: ColorScheme
  /** The variant last picked in each family. */
  picks: ThemePicks
  onChange: (family: ThemeFamilyId) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3"
    >
      {THEME_FAMILIES.map((family) => {
        const selected = family.id === value
        const variant = familyVariant(family, scheme, picks[family.id]?.[scheme])
        const hintId = `theme-family-${family.id}-hint`
        return (
          <label
            key={family.id}
            className={cn(
              'cursor-pointer rounded-lg p-1.5 transition-colors duration-100',
              'has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-focus-ring',
              selected ? 'bg-active' : 'hover:bg-hover',
            )}
          >
            <input
              type="radio"
              className="sr-only"
              name="theme-family"
              value={family.id}
              checked={selected}
              aria-label={family.label}
              aria-describedby={hintId}
              onChange={() => onChange(family.id)}
            />
            <ThemePreview swatch={variant.swatch} />
            <span className="block px-1 pb-0.5 pt-2">
              <span
                className={cn(
                  'block truncate text-[13px]',
                  selected ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {family.label}
              </span>
              <span id={hintId} className="block truncate text-[12px] text-faint">
                {family.hint}
              </span>
            </span>
          </label>
        )
      })}
    </div>
  )
}
