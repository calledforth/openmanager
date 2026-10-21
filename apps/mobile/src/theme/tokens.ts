/**
 * The phone's theme, derived from web's generated token map. Nothing here is
 * a hand-copied colour: every value comes from `THEME_TOKENS` (built from
 * globals.css and fluid.css), so a family paints the same on both clients.
 *
 * `PhoneTheme` names the handful of roles the screens use, after the mockups
 * in docs/ui-prototypes/mobile. `themeVars` turns one into NativeWind
 * variables for class names; `legacyBasis` keeps the first build's token
 * shape alive for screens that have not been rebuilt yet.
 */
import { vars } from 'nativewind'
import {
  schemeOfTheme,
  type ColorScheme,
  type ThemeMode as SchemeId,
} from '@openmanager/app-core/lib/theme-families'
import {
  colorChannels,
  themeShadows,
  themeTokens,
  withAlpha,
  type ShadowLayer,
  type ThemeTokens,
} from '@openmanager/app-core/lib/theme-tokens'

export interface StatusColors {
  working: string
  background: string
  needs: string
  question: string
  done: string
  error: string
}

export interface PhoneTheme {
  scheme: SchemeId
  colorScheme: ColorScheme
  /** The canvas. */
  bg: string
  /** Ink. */
  fg: string
  muted: string
  faint: string
  /** The one hairline a list may need. */
  rule: string
  border: string
  /** Fills, not borders: a pressed row and a selected one. */
  hover: string
  active: string
  selected: string
  /** One step above the canvas (fluid's `--surface-2`). */
  surface2: string
  /** A sent message. */
  bubble: string
  actionBg: string
  actionFg: string
  actionHover: string
  destructive: string
  destructiveFg: string
  /** Floating surfaces: opaque, and the three glass strengths over content. */
  floatBg: string
  scrim: string
  glass: string
  glassStrong: string
  glassSheet: string
  /** The family's accent, and its soft wash. */
  tint: string
  tintSoft: string
  status: StatusColors
  /** The ink a glyph on each status fill takes: `bg` or `fg`, by contrast. */
  statusInk: StatusColors
  statusWash: { done: string; error: string }
  /** CSS box-shadow text React Native's `boxShadow` style takes as-is. */
  shadow: { float: string; rest: string }
  shadowLayers: { float: ShadowLayer[]; rest: ShadowLayer[] }
  /** Every token of the scheme, for anything the roles above do not name. */
  tokens: ThemeTokens
  /**
   * The ink for something drawn on `fill` (a badge count, a status glyph):
   * the scheme's canvas or its ink, whichever contrasts more with the fill.
   */
  inkOn: (fill: string) => string
  /** The squares a project shows until its declared icon reaches the phone. */
  projectMarks: readonly string[]
}

/** WCAG relative luminance of a generated colour; its alpha is ignored. */
export function relativeLuminance(color: string): number {
  const channels = colorChannels(color)
  if (!channels) return 0
  const linear = (value: number) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(channels.r) + 0.7152 * linear(channels.g) + 0.0722 * linear(channels.b)
}

/** WCAG contrast ratio between two generated colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ]
  return (hi + 0.05) / (lo + 0.05)
}

/** Of the two inks, the one that reads better on `fill`. */
function pickInk(fill: string, bg: string, fg: string): string {
  return contrastRatio(fill, bg) >= contrastRatio(fill, fg) ? bg : fg
}

/**
 * A project's square, until declared project icons reach the phone: eight
 * hues a project's name picks from, so it keeps its colour across screens,
 * schemes and devices. Web has no counterpart (it shows a folder), so these
 * are the phone's own, the same on every scheme: a colour that changed with
 * the theme would stop identifying the project. Mid-tone hues, so a square
 * stands at 2:1 or better on every canvas; it always sits beside the
 * project's name, which carries the meaning.
 */
export const PROJECT_MARKS: readonly string[] = [
  '#4f8ff7',
  '#e0a04f',
  '#9b6bd6',
  '#4a9d7a',
  '#c0565a',
  '#3fa7b8',
  '#b58a3c',
  '#7a7fd1',
]

const GLASS_ALPHA: Record<ColorScheme, { glass: number; strong: number; sheet: number }> = {
  dark: { glass: 0.58, strong: 0.72, sheet: 0.82 },
  light: { glass: 0.6, strong: 0.74, sheet: 0.86 },
}

const cache = new Map<SchemeId, PhoneTheme>()

/** The phone's theme for one scheme; built once per scheme. */
export function phoneTheme(scheme: SchemeId): PhoneTheme {
  const cached = cache.get(scheme)
  if (cached) return cached
  const t = themeTokens(scheme)
  const shadows = themeShadows(scheme)
  const colorScheme = schemeOfTheme(scheme)
  const alpha = GLASS_ALPHA[colorScheme]
  const floatBg = t['float-bg']
  const bg = t['basis-canvas-bg']
  const fg = t['basis-text-strong']
  const inkOn = (fill: string) => pickInk(fill, bg, fg)
  const status: StatusColors = {
    working: t['basis-status-working'],
    background: t['basis-status-background'],
    needs: t['basis-status-needs'],
    question: t['basis-status-question'],
    done: t['basis-status-done'],
    error: t['basis-status-error'],
  }
  const theme: PhoneTheme = {
    scheme,
    colorScheme,
    bg,
    fg,
    muted: t['basis-text-muted'],
    faint: t['basis-text-faint'],
    rule: t['basis-border-muted'],
    border: t['basis-border'],
    hover: t.hover,
    active: t.active,
    selected: t.selected,
    surface2: t['surface-2'],
    bubble: t['basis-chat-user-bg'],
    actionBg: t['basis-action-bg'],
    actionFg: t['basis-action-fg'],
    actionHover: t['basis-action-hover'],
    destructive: t['color-destructive'],
    destructiveFg: t['color-destructive-foreground'],
    floatBg,
    scrim: t['float-scrim'],
    glass: withAlpha(floatBg, alpha.glass),
    glassStrong: withAlpha(floatBg, alpha.strong),
    glassSheet: withAlpha(floatBg, alpha.sheet),
    tint: t.tint,
    tintSoft: t['tint-soft'],
    status,
    statusInk: {
      working: inkOn(status.working),
      background: inkOn(status.background),
      needs: inkOn(status.needs),
      question: inkOn(status.question),
      done: inkOn(status.done),
      error: inkOn(status.error),
    },
    statusWash: { done: t['basis-status-done-wash'], error: t['basis-status-error-wash'] },
    shadow: { float: t['float-shadow'], rest: t['float-shadow-rest'] },
    shadowLayers: { float: shadows['float-shadow'], rest: shadows['float-shadow-rest'] },
    tokens: t,
    inkOn,
    projectMarks: PROJECT_MARKS,
  }
  cache.set(scheme, theme)
  return theme
}

/**
 * NativeWind variables for a theme, so `bg-canvas`, `text-ink`, `bg-hover`…
 * resolve through tailwind.config.js. The first build's names are kept so
 * its screens still paint until they are rebuilt.
 */
export function themeVars(theme: PhoneTheme) {
  return vars({
    '--canvas': theme.bg,
    '--ink': theme.fg,
    '--muted': theme.muted,
    '--faint': theme.faint,
    '--rule': theme.rule,
    '--hover': theme.hover,
    '--active': theme.active,
    '--selected': theme.selected,
    '--surface-2': theme.surface2,
    '--bubble': theme.bubble,
    '--action-bg': theme.actionBg,
    '--action-fg': theme.actionFg,
    '--action-hover': theme.actionHover,
    '--float': theme.floatBg,
    '--scrim': theme.scrim,
    '--glass': theme.glass,
    '--glass-strong': theme.glassStrong,
    '--glass-sheet': theme.glassSheet,
    '--tint': theme.tint,
    '--tint-soft': theme.tintSoft,
    '--status-working': theme.status.working,
    '--status-background': theme.status.background,
    '--status-needs': theme.status.needs,
    '--status-question': theme.status.question,
    '--status-done': theme.status.done,
    '--status-error': theme.status.error,
    '--status-done-wash': theme.statusWash.done,
    '--status-error-wash': theme.statusWash.error,
    // First build's names.
    '--canvas-bg': theme.bg,
    '--surface': theme.tokens['basis-surface'],
    '--surface-elevated': theme.tokens['basis-surface-elevated'],
    '--surface-hover': theme.tokens['basis-surface-hover'],
    '--tab-active-bg': theme.tokens['basis-tab-active-bg'],
    '--border': theme.border,
    '--border-muted': theme.rule,
    '--text': theme.tokens['basis-text'],
    '--text-strong': theme.fg,
    '--text-muted': theme.muted,
    '--text-faint': theme.faint,
    '--destructive': theme.destructive,
    '--destructive-fg': theme.destructiveFg,
    '--background': theme.bg,
    '--foreground': theme.tokens['basis-text'],
    '--card': theme.tokens['basis-surface'],
    '--popover': theme.tokens['basis-surface-elevated'],
    '--primary': theme.fg,
    '--muted-foreground': theme.muted,
    '--accent': theme.tokens['basis-surface-hover'],
    '--input': theme.tokens['basis-surface'],
  })
}

/** The first build's token shape, for screens not yet rebuilt on PhoneTheme. */
export interface BasisTokens {
  canvasBg: string
  surface: string
  surfaceElevated: string
  surfaceHover: string
  tabActiveBg: string
  border: string
  borderMuted: string
  text: string
  textStrong: string
  textMuted: string
  textFaint: string
  actionBg: string
  actionFg: string
  actionHover: string
  destructive: string
  destructiveFg: string
}

export type BasisTokenName = keyof BasisTokens

export function legacyBasis(theme: PhoneTheme): BasisTokens {
  const t = theme.tokens
  return {
    canvasBg: theme.bg,
    surface: t['basis-surface'],
    surfaceElevated: t['basis-surface-elevated'],
    surfaceHover: t['basis-surface-hover'],
    tabActiveBg: t['basis-tab-active-bg'],
    border: theme.border,
    borderMuted: theme.rule,
    text: t['basis-text'],
    textStrong: theme.fg,
    textMuted: theme.muted,
    textFaint: theme.faint,
    actionBg: theme.actionBg,
    actionFg: theme.actionFg,
    actionHover: theme.actionHover,
    destructive: theme.destructive,
    destructiveFg: theme.destructiveFg,
  }
}

/** Default family, dark and light, in the first build's shape. */
export const basisDark: BasisTokens = legacyBasis(phoneTheme('dark'))
export const basisLight: BasisTokens = legacyBasis(phoneTheme('light'))
export const darkVars = themeVars(phoneTheme('dark'))
export const lightVars = themeVars(phoneTheme('light'))
