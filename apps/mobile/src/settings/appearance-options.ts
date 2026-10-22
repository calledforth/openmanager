import {
  THEME_FAMILIES,
  type AppearanceMode,
  type ColorScheme,
  type ThemeFamilyId,
} from '@openmanager/app-core/lib/theme-families'
import { withAlpha } from '@openmanager/app-core/lib/theme-tokens'

/**
 * Appearance on Settings, as the mockup draws it: the six families from
 * `theme-families.ts` as little canvas swatches, then the mode as one
 * segmented track. The swatch paints the side the phone would show now
 * (light or dark), from the family's own swatch colours; the choice goes
 * through the phone's theme store (`ThemeProvider`), which keeps it on this
 * device only.
 */

/** Light, Dark, System, in the mockup's order. */
export const MODE_OPTIONS: ReadonlyArray<{ mode: AppearanceMode; label: string }> = [
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'system', label: 'System' },
]

export type FamilySwatch = {
  id: ThemeFamilyId
  label: string
  /** The family's canvas on the side in use. */
  canvas: string
  /** A faint inner edge, so a canvas like the page's own still reads as a card. */
  edge: string
  selected: boolean
}

export function familySwatches(resolved: ColorScheme, selected: ThemeFamilyId): FamilySwatch[] {
  return THEME_FAMILIES.map((family) => {
    const side = family[resolved].swatch
    return {
      id: family.id,
      label: family.label,
      canvas: side.canvas,
      edge: withAlpha(side.ink, 0.12),
      selected: family.id === selected,
    }
  })
}

/** Where the segmented track's thumb sits for a mode. */
export function modeIndex(mode: AppearanceMode): number {
  return Math.max(
    0,
    MODE_OPTIONS.findIndex((option) => option.mode === mode),
  )
}
