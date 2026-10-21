import { describe, expect, it, vi } from 'vitest'
import { THEME_FAMILIES, THEME_MODES } from '@openmanager/app-core/lib/theme-families'
import { THEME_TOKENS } from '@openmanager/app-core/lib/theme-tokens'

// NativeWind's `vars()` needs no native runtime, but importing the package
// pulls React Native in; a stand-in keeps the test on plain Node.
vi.mock('nativewind', () => ({ vars: (map: Record<string, string>) => map }))

const {
  appearanceFromLegacyMode,
  DEFAULT_APPEARANCE,
  parseAppearance,
  resolveColorScheme,
  resolveScheme,
  serializeAppearance,
} = await import('../src/theme/appearance')
const { basisDark, basisLight, legacyBasis, phoneTheme, themeVars } =
  await import('../src/theme/tokens')

describe('appearance', () => {
  it('reads what web saves and ignores what it does not know', () => {
    expect(parseAppearance(JSON.stringify({ mode: 'dark', family: 'carbon' }))).toEqual({
      mode: 'dark',
      family: 'carbon',
    })
    expect(parseAppearance(JSON.stringify({ mode: 'noon', family: 'velvet' }))).toEqual(
      DEFAULT_APPEARANCE,
    )
    expect(parseAppearance('not json')).toEqual(DEFAULT_APPEARANCE)
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE)
  })

  it('round-trips through its own serialisation', () => {
    const appearance = { mode: 'light', family: 'paper' } as const
    expect(parseAppearance(serializeAppearance(appearance))).toEqual(appearance)
  })

  it("carries the first build's mode-only value over", () => {
    expect(appearanceFromLegacyMode('light')).toEqual({ ...DEFAULT_APPEARANCE, mode: 'light' })
    expect(appearanceFromLegacyMode('system')).toEqual(DEFAULT_APPEARANCE)
    expect(appearanceFromLegacyMode('blue')).toBeNull()
    expect(appearanceFromLegacyMode(null)).toBeNull()
  })

  it('resolves system mode from the phone and fixed modes from the pick', () => {
    const system = { mode: 'system', family: 'claude' } as const
    expect(resolveScheme(system, 'dark')).toBe('claudeish')
    expect(resolveScheme(system, 'light')).toBe('claude-light')
    expect(resolveColorScheme(system, 'light')).toBe('light')
    const fixed = { mode: 'dark', family: 'claude' } as const
    expect(resolveScheme(fixed, 'light')).toBe('claudeish')
    expect(resolveColorScheme(fixed, 'light')).toBe('dark')
  })

  it('lands on a scheme for every family and mode', () => {
    for (const family of THEME_FAMILIES) {
      for (const mode of ['light', 'dark', 'system'] as const) {
        for (const system of ['light', 'dark'] as const) {
          const scheme = resolveScheme({ mode, family: family.id }, system)
          expect(THEME_MODES).toContain(scheme)
          expect(THEME_TOKENS[scheme]).toBeDefined()
        }
      }
    }
  })
})

describe('phone theme', () => {
  it("paints each scheme with web's tokens, not copied values", () => {
    for (const scheme of THEME_MODES) {
      const theme = phoneTheme(scheme)
      const tokens = THEME_TOKENS[scheme]
      expect(theme.bg).toBe(tokens['basis-canvas-bg'])
      expect(theme.fg).toBe(tokens['basis-text-strong'])
      expect(theme.muted).toBe(tokens['basis-text-muted'])
      expect(theme.hover).toBe(tokens.hover)
      expect(theme.active).toBe(tokens.active)
      expect(theme.bubble).toBe(tokens['basis-chat-user-bg'])
      expect(theme.status.working).toBe(tokens['basis-status-working'])
      expect(theme.shadow.rest).toBe(tokens['float-shadow-rest'])
    }
  })

  it('derives glass from the floating surface at a scheme-specific opacity', () => {
    const dark = phoneTheme('neutral')
    expect(dark.floatBg).toBe('#202020')
    expect(dark.glass).toBe('rgba(32, 32, 32, 0.58)')
    expect(dark.glassSheet).toBe('rgba(32, 32, 32, 0.82)')
    const light = phoneTheme('neutral-light')
    expect(light.floatBg).toBe('#ffffff')
    expect(light.glass).toBe('rgba(255, 255, 255, 0.6)')
  })

  it('matches the families swatches, the way the picker previews them', () => {
    for (const family of THEME_FAMILIES) {
      expect(phoneTheme(family.dark.id).bg).toBe(family.dark.swatch.canvas)
      expect(phoneTheme(family.light.id).bg).toBe(family.light.swatch.canvas)
      const dark = phoneTheme(family.dark.id)
      expect([dark.fg, dark.tokens['basis-text']]).toContain(family.dark.swatch.ink)
    }
  })

  it('keeps one theme object per scheme', () => {
    expect(phoneTheme('carbon')).toBe(phoneTheme('carbon'))
  })

  it('exposes every variable tailwind.config.js names, old and new', () => {
    const vars = themeVars(phoneTheme('paper-light')) as unknown as Record<string, string>
    for (const name of [
      '--canvas',
      '--ink',
      '--muted',
      '--faint',
      '--rule',
      '--hover',
      '--active',
      '--selected',
      '--surface-2',
      '--bubble',
      '--action-bg',
      '--action-fg',
      '--float',
      '--scrim',
      '--glass',
      '--glass-strong',
      '--glass-sheet',
      '--tint',
      '--status-working',
      '--status-error-wash',
      '--canvas-bg',
      '--text-strong',
      '--destructive',
      '--background',
      '--foreground',
    ]) {
      expect(vars[name], name).toBeTruthy()
    }
  })

  it("fills the first build's shape from the same tokens", () => {
    const legacy = legacyBasis(phoneTheme('dark'))
    expect(legacy).toEqual(basisDark)
    expect(legacy.canvasBg).toBe('#141414')
    expect(legacy.textStrong).toBe('#e0e0e0')
    expect(basisLight.canvasBg).toBe('#f8f8f8')
    expect(legacy.destructive).toBe('#cf3030')
  })
})
