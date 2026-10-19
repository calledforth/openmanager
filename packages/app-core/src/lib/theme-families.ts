/**
 * Themes come in families. A family is one look (Lovable, Claude, Carbon…)
 * carried as exactly one light scheme and one dark scheme; the appearance mode
 * (light, dark or system) picks which of the two shows.
 *
 * Each scheme is one `data-theme` in styles/globals.css and styles/fluid.css;
 * the swatch is the handful of its colours the theme picker paints its preview
 * with, since a preview can't scope a `:root` scheme.
 */

/** A `data-theme` scheme. `dark` is the bare root (no attribute). */
export type ThemeMode =
  | 'dark'
  | 'light'
  | 'neutral'
  | 'paper'
  | 'lovable'
  | 'claudeish'
  | 'carbon'
  | 'neutral-light'
  | 'paper-light'
  | 'lovable-light'
  | 'claude-light'
  | 'carbon-light'

/** Which canvas a scheme paints on. */
export type ColorScheme = 'light' | 'dark'

/** What the user picks: a fixed scheme, or the operating system's. */
export type AppearanceMode = ColorScheme | 'system'

export type ThemeFamilyId = 'default' | 'neutral' | 'paper' | 'lovable' | 'claude' | 'carbon'

export interface ThemeSwatch {
  canvas: string
  rail: string
  bubble: string
  ink: string
  muted: string
  accent: string
}

/** One side of a family: the scheme it paints and the colours its preview shows. */
export interface ThemeScheme {
  id: ThemeMode
  swatch: ThemeSwatch
}

export interface ThemeFamily {
  id: ThemeFamilyId
  label: string
  hint: string
  light: ThemeScheme
  dark: ThemeScheme
}

export const THEME_FAMILIES: readonly ThemeFamily[] = [
  {
    id: 'default',
    label: 'Default',
    hint: 'the original greys',
    light: {
      id: 'light',
      swatch: {
        canvas: '#f8f8f8',
        rail: '#f1f1f1',
        bubble: '#eaeaea',
        ink: '#2d2d2d',
        muted: '#c4c4c4',
        accent: '#1f6feb',
      },
    },
    dark: {
      id: 'dark',
      swatch: {
        canvas: '#141414',
        rail: '#191919',
        bubble: '#1c1c1c',
        ink: '#d0d0d0',
        muted: '#4d4d4d',
        accent: '#4f8ff7',
      },
    },
  },
  {
    id: 'neutral',
    label: 'Neutral',
    hint: 'plain greys',
    light: {
      id: 'neutral-light',
      swatch: {
        canvas: '#fcfcfc',
        rail: '#f5f5f5',
        bubble: '#eeeeee',
        ink: '#1a1a1a',
        muted: '#d4d4d4',
        accent: '#3f6ad8',
      },
    },
    dark: {
      id: 'neutral',
      swatch: {
        canvas: '#171717',
        rail: '#1e1e1e',
        bubble: '#363636',
        ink: '#ededed',
        muted: '#5c5c5c',
        accent: '#7ea2f5',
      },
    },
  },
  {
    id: 'paper',
    label: 'Paper',
    hint: 'warm greys',
    light: {
      id: 'paper-light',
      swatch: {
        canvas: '#f6f4ef',
        rail: '#efece6',
        bubble: '#e9e6df',
        ink: '#24221e',
        muted: '#c7c2b8',
        accent: '#3f6ad8',
      },
    },
    dark: {
      id: 'paper',
      swatch: {
        canvas: '#1a1917',
        rail: '#201f1c',
        bubble: '#2a2926',
        ink: '#ebe8e2',
        muted: '#5f5b54',
        accent: '#7ea2f5',
      },
    },
  },
  {
    id: 'lovable',
    label: 'Lovable',
    hint: 'white chat, or true black',
    light: {
      id: 'lovable-light',
      swatch: {
        canvas: '#ffffff',
        rail: '#f5f5f5',
        bubble: '#eeeeee',
        ink: '#1c1c1c',
        muted: '#d6d6d6',
        accent: '#1e52f1',
      },
    },
    dark: {
      id: 'lovable',
      swatch: {
        canvas: '#090909',
        rail: '#0e0e0e',
        bubble: '#161616',
        ink: '#e0e0e0',
        muted: '#3a3a3a',
        accent: '#3d73d4',
      },
    },
  },
  {
    id: 'claude',
    label: 'Claude',
    hint: 'ivory or charcoal, with clay',
    light: {
      id: 'claude-light',
      swatch: {
        canvas: '#faf9f5',
        rail: '#f3f1ea',
        bubble: '#ebe8de',
        ink: '#141413',
        muted: '#c9c6bb',
        accent: '#c96442',
      },
    },
    dark: {
      id: 'claudeish',
      swatch: {
        canvas: '#1f1e1d',
        rail: '#1f1e1d',
        bubble: '#2d2c2a',
        ink: '#f0eee6',
        muted: '#6b6963',
        accent: '#d97757',
      },
    },
  },
  {
    id: 'carbon',
    label: 'Carbon',
    hint: 'flat neutrals with lime',
    light: {
      id: 'carbon-light',
      swatch: {
        canvas: '#fafafa',
        rail: '#fafafa',
        bubble: '#ebebeb',
        ink: '#141414',
        muted: '#cfcfcf',
        accent: '#c5f23a',
      },
    },
    dark: {
      id: 'carbon',
      swatch: {
        canvas: '#141414',
        rail: '#141414',
        bubble: '#222222',
        ink: '#fdfdfd',
        muted: '#4a4a4a',
        accent: '#c5f23a',
      },
    },
  },
]

export const DEFAULT_THEME_FAMILY: ThemeFamilyId = 'default'

interface PlacedScheme {
  family: ThemeFamily
  scheme: ColorScheme
}

const PLACEMENT = new Map<ThemeMode, PlacedScheme>(
  THEME_FAMILIES.flatMap((family) =>
    (['light', 'dark'] as const).map((scheme) => [family[scheme].id, { family, scheme }] as const),
  ),
)

const FAMILIES = new Map(THEME_FAMILIES.map((family) => [family.id, family]))

/**
 * Schemes that have since gone, mapped to the one that took their place, for
 * a value saved before then. Families used to offer variants: Neutral Light
 * Soft folds into Neutral Light; Lovable Light Inverse became Lovable's light
 * (the `lovable-light` id, which now paints it); Black left Default to become
 * Lovable's dark (the `lovable` id). Old `lovable-light` and `lovable` values
 * need no entry: they name Lovable's light and dark, which is where they land.
 */
const RETIRED_SCHEMES: ReadonlyMap<string, ThemeMode> = new Map([
  ['neutral-light-soft', 'neutral-light'],
  ['lovable-light-inverse', 'lovable-light'],
  ['black', 'lovable'],
])

/** Every scheme, in family order (each family's light, then its dark). */
export const THEME_MODES: readonly ThemeMode[] = [...PLACEMENT.keys()]

export function isThemeMode(value: string): value is ThemeMode {
  return PLACEMENT.has(value as ThemeMode)
}

/** A saved scheme id as a current scheme: itself, the scheme that replaced it, or nothing. */
export function themeModeFrom(value: unknown): ThemeMode | undefined {
  if (typeof value !== 'string') return undefined
  if (isThemeMode(value)) return value
  return RETIRED_SCHEMES.get(value)
}

export function isThemeFamilyId(value: unknown): value is ThemeFamilyId {
  return typeof value === 'string' && FAMILIES.has(value as ThemeFamilyId)
}

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function themeFamily(id: ThemeFamilyId): ThemeFamily {
  return FAMILIES.get(id) ?? THEME_FAMILIES[0]!
}

/** The family a scheme belongs to. */
export function familyOfTheme(mode: ThemeMode): ThemeFamily {
  return PLACEMENT.get(mode)?.family ?? THEME_FAMILIES[0]!
}

/** Whether a scheme paints on a light canvas (icons and code blocks switch on this). */
export function schemeOfTheme(mode: ThemeMode): ColorScheme {
  return PLACEMENT.get(mode)?.scheme ?? 'dark'
}
