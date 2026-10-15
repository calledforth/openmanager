/**
 * Themes come in families. A family is one look (Lovable, Claude, Carbon…)
 * carried in both a light and a dark variant; the appearance mode (light,
 * dark or system) picks which half shows. A family can offer more than one
 * variant for a mode (Lovable Light and its Inverse; Dark and true Black), and
 * the first listed is the one a family opens on.
 *
 * Each variant is one `data-theme` scheme in styles/globals.css and
 * styles/fluid.css; the swatch is the handful of its colours the theme picker
 * paints its preview with, since a preview can't scope a `:root` scheme.
 */

/** A `data-theme` scheme. `dark` is the bare root (no attribute). */
export type ThemeMode =
  | 'dark'
  | 'light'
  | 'black'
  | 'neutral'
  | 'paper'
  | 'lovable'
  | 'claudeish'
  | 'carbon'
  | 'neutral-light'
  | 'neutral-light-soft'
  | 'paper-light'
  | 'lovable-light'
  | 'lovable-light-inverse'
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

export interface ThemeVariant {
  id: ThemeMode
  /** The scheme's own name, used where it stands alone (command palette, desktop menu). */
  name: string
  /** Its name within the family, used by the variant picker. */
  label: string
  hint: string
  swatch: ThemeSwatch
}

export interface ThemeFamily {
  id: ThemeFamilyId
  label: string
  hint: string
  light: readonly [ThemeVariant, ...ThemeVariant[]]
  dark: readonly [ThemeVariant, ...ThemeVariant[]]
}

export const THEME_FAMILIES: readonly ThemeFamily[] = [
  {
    id: 'default',
    label: 'Default',
    hint: 'the original greys',
    light: [
      {
        id: 'light',
        name: 'Light',
        label: 'Standard',
        hint: 'the original light',
        swatch: {
          canvas: '#f8f8f8',
          rail: '#f1f1f1',
          bubble: '#eaeaea',
          ink: '#2d2d2d',
          muted: '#c4c4c4',
          accent: '#1f6feb',
        },
      },
    ],
    dark: [
      {
        id: 'dark',
        name: 'Dark',
        label: 'Standard',
        hint: 'the original dark',
        swatch: {
          canvas: '#141414',
          rail: '#191919',
          bubble: '#1c1c1c',
          ink: '#d0d0d0',
          muted: '#4d4d4d',
          accent: '#4f8ff7',
        },
      },
      {
        id: 'black',
        name: 'Black',
        label: 'Black',
        hint: 'true black',
        swatch: {
          canvas: '#090909',
          rail: '#0e0e0e',
          bubble: '#161616',
          ink: '#e0e0e0',
          muted: '#3a3a3a',
          accent: '#3d73d4',
        },
      },
    ],
  },
  {
    id: 'neutral',
    label: 'Neutral',
    hint: 'plain greys',
    light: [
      {
        id: 'neutral-light',
        name: 'Neutral Light',
        label: 'Standard',
        hint: 'plain greys, light',
        swatch: {
          canvas: '#fcfcfc',
          rail: '#f5f5f5',
          bubble: '#eeeeee',
          ink: '#1a1a1a',
          muted: '#d4d4d4',
          accent: '#3f6ad8',
        },
      },
      {
        id: 'neutral-light-soft',
        name: 'Neutral Light Soft',
        label: 'Soft',
        hint: 'lighter ink, larger chat text',
        swatch: {
          canvas: '#fcfcfc',
          rail: '#f5f5f5',
          bubble: '#eeeeee',
          ink: '#4a4a4a',
          muted: '#dddddd',
          accent: '#3f6ad8',
        },
      },
    ],
    dark: [
      {
        id: 'neutral',
        name: 'Neutral',
        label: 'Standard',
        hint: 'plain greys, dark',
        swatch: {
          canvas: '#171717',
          rail: '#1e1e1e',
          bubble: '#363636',
          ink: '#ededed',
          muted: '#5c5c5c',
          accent: '#7ea2f5',
        },
      },
    ],
  },
  {
    id: 'paper',
    label: 'Paper',
    hint: 'warm greys',
    light: [
      {
        id: 'paper-light',
        name: 'Paper Light',
        label: 'Standard',
        hint: 'warm greys, light',
        swatch: {
          canvas: '#f6f4ef',
          rail: '#efece6',
          bubble: '#e9e6df',
          ink: '#24221e',
          muted: '#c7c2b8',
          accent: '#3f6ad8',
        },
      },
    ],
    dark: [
      {
        id: 'paper',
        name: 'Paper',
        label: 'Standard',
        hint: 'warm greys, dark',
        swatch: {
          canvas: '#1a1917',
          rail: '#201f1c',
          bubble: '#2a2926',
          ink: '#ebe8e2',
          muted: '#5f5b54',
          accent: '#7ea2f5',
        },
      },
    ],
  },
  {
    id: 'lovable',
    label: 'Lovable',
    hint: 'Lovable’s editor colours',
    light: [
      {
        id: 'lovable-light',
        name: 'Lovable Light',
        label: 'Standard',
        hint: 'warm cream, light',
        swatch: {
          canvas: '#f5f5f5',
          rail: '#f5f5f5',
          bubble: '#ffffff',
          ink: '#1c1c1c',
          muted: '#cfcfcf',
          accent: '#1e52f1',
        },
      },
      {
        id: 'lovable-light-inverse',
        name: 'Lovable Light Inverse',
        label: 'Inverse',
        hint: 'white chat, grey rail',
        swatch: {
          canvas: '#ffffff',
          rail: '#f5f5f5',
          bubble: '#eeeeee',
          ink: '#1c1c1c',
          muted: '#d6d6d6',
          accent: '#1e52f1',
        },
      },
    ],
    dark: [
      {
        id: 'lovable',
        name: 'Lovable',
        label: 'Standard',
        hint: 'warm charcoal, dark',
        swatch: {
          canvas: '#1d1d1c',
          rail: '#1d1d1c',
          bubble: '#2c2c2b',
          ink: '#ededeb',
          muted: '#62625f',
          accent: '#e2b46a',
        },
      },
    ],
  },
  {
    id: 'claude',
    label: 'Claude',
    hint: 'ivory or charcoal, with clay',
    light: [
      {
        id: 'claude-light',
        name: 'Claude Light',
        label: 'Standard',
        hint: 'warm ivory with clay, light',
        swatch: {
          canvas: '#faf9f5',
          rail: '#f3f1ea',
          bubble: '#ebe8de',
          ink: '#141413',
          muted: '#c9c6bb',
          accent: '#c96442',
        },
      },
    ],
    dark: [
      {
        id: 'claudeish',
        name: 'Claude-ish',
        label: 'Standard',
        hint: 'warm charcoal with clay, dark',
        swatch: {
          canvas: '#1f1e1d',
          rail: '#1f1e1d',
          bubble: '#2d2c2a',
          ink: '#f0eee6',
          muted: '#6b6963',
          accent: '#d97757',
        },
      },
    ],
  },
  {
    id: 'carbon',
    label: 'Carbon',
    hint: 'flat neutrals with lime',
    light: [
      {
        id: 'carbon-light',
        name: 'Carbon Light',
        label: 'Standard',
        hint: 'neutral white with lime, light',
        swatch: {
          canvas: '#fafafa',
          rail: '#fafafa',
          bubble: '#ebebeb',
          ink: '#141414',
          muted: '#cfcfcf',
          accent: '#c5f23a',
        },
      },
    ],
    dark: [
      {
        id: 'carbon',
        name: 'Carbon',
        label: 'Standard',
        hint: 'neutral black with lime, dark',
        swatch: {
          canvas: '#141414',
          rail: '#141414',
          bubble: '#222222',
          ink: '#fdfdfd',
          muted: '#4a4a4a',
          accent: '#c5f23a',
        },
      },
    ],
  },
]

export const DEFAULT_THEME_FAMILY: ThemeFamilyId = 'default'

interface PlacedVariant {
  family: ThemeFamily
  scheme: ColorScheme
  variant: ThemeVariant
}

const PLACEMENT = new Map<ThemeMode, PlacedVariant>(
  THEME_FAMILIES.flatMap((family) =>
    (['light', 'dark'] as const).flatMap((scheme) =>
      family[scheme].map((variant) => [variant.id, { family, scheme, variant }] as const),
    ),
  ),
)

const FAMILIES = new Map(THEME_FAMILIES.map((family) => [family.id, family]))

/** Every scheme, in family order (each family's light variants, then its dark ones). */
export const THEME_MODES: readonly ThemeMode[] = [...PLACEMENT.keys()]

export function isThemeMode(value: string): value is ThemeMode {
  return PLACEMENT.has(value as ThemeMode)
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

export function themeVariant(mode: ThemeMode): ThemeVariant | undefined {
  return PLACEMENT.get(mode)?.variant
}

/** The variant a family shows for a scheme: the picked one when it belongs there, else its first. */
export function familyVariant(
  family: ThemeFamily,
  scheme: ColorScheme,
  picked: ThemeMode | undefined,
): ThemeVariant {
  const variants = family[scheme]
  return variants.find((variant) => variant.id === picked) ?? variants[0]
}
