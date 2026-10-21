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
  statusWash: { done: string; error: string }
  /** CSS box-shadow text React Native's `boxShadow` style takes as-is. */
  shadow: { float: string; rest: string }
  shadowLayers: { float: ShadowLayer[]; rest: ShadowLayer[] }
  /** Every token of the scheme, for anything the roles above do not name. */
  tokens: ThemeTokens
}

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
  const theme: PhoneTheme = {
    scheme,
    colorScheme,
    bg: t['basis-canvas-bg'],
    fg: t['basis-text-strong'],
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
    status: {
      working: t['basis-status-working'],
      background: t['basis-status-background'],
      needs: t['basis-status-needs'],
      question: t['basis-status-question'],
      done: t['basis-status-done'],
      error: t['basis-status-error'],
    },
    statusWash: { done: t['basis-status-done-wash'], error: t['basis-status-error-wash'] },
    shadow: { float: t['float-shadow'], rest: t['float-shadow-rest'] },
    shadowLayers: { float: shadows['float-shadow'], rest: shadows['float-shadow-rest'] },
    tokens: t,
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
