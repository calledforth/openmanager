/**
 * Web's theme tokens as data, for a client with no CSS engine.
 *
 * `THEME_TOKENS` is generated from styles/globals.css and styles/fluid.css by
 * scripts/theme-tokens.mjs: for each `data-theme` scheme, every custom
 * property the root element resolves to, with `var()` substituted and the
 * colour maths (`color-mix`, `oklch`, `rgb(… / a)`) evaluated, so a colour is
 * always `#rrggbb` or `rgba(r, g, b, a)`. Sizes, line heights and the shadow
 * recipes come through as their text; shadows also come parsed as layers in
 * `THEME_SHADOWS`.
 *
 * The CSS stays the source of truth. The generated file is checked in and
 * tests/theme-tokens.test.ts fails when it is stale.
 */
import type { ThemeMode } from './theme-families'
import {
  THEME_SHADOWS,
  THEME_TOKENS,
  type OptionalThemeTokenName,
  type ShadowLayer,
  type ShadowTokenName,
  type ThemeTokenName,
  type ThemeTokens,
} from './theme-tokens.generated'

export {
  THEME_SHADOWS,
  THEME_TOKENS,
  type OptionalThemeTokenName,
  type ShadowLayer,
  type ShadowTokenName,
  type ThemeTokenName,
  type ThemeTokens,
}

/** The resolved tokens of one scheme. */
export function themeTokens(scheme: ThemeMode): ThemeTokens {
  return THEME_TOKENS[scheme]
}

/** The parsed shadow layers of one scheme. */
export function themeShadows(scheme: ThemeMode): Record<ShadowTokenName, ShadowLayer[]> {
  return THEME_SHADOWS[scheme]
}

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const RGBA = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/

/** A generated colour broken into channels, or null for a non-colour value. */
export function colorChannels(
  value: string,
): { r: number; g: number; b: number; alpha: number } | null {
  const hex = HEX.exec(value)
  if (hex) {
    return {
      r: parseInt(hex[1]!, 16),
      g: parseInt(hex[2]!, 16),
      b: parseInt(hex[3]!, 16),
      alpha: 1,
    }
  }
  const rgba = RGBA.exec(value)
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      alpha: Number(rgba[4]),
    }
  }
  return null
}

/** The same colour at another opacity; a non-colour value comes back unchanged. */
export function withAlpha(value: string, alpha: number): string {
  const channels = colorChannels(value)
  if (!channels) return value
  return `rgba(${channels.r}, ${channels.g}, ${channels.b}, ${Number(alpha.toFixed(4))})`
}
