// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { THEME_FAMILIES, THEME_MODES } from '../src/lib/theme-families'
import { THEME_SHADOWS, THEME_TOKENS } from '../src/lib/theme-tokens.generated'
import {
  SCHEMES,
  currentThemeTokensFile,
  generateThemeTokens,
  renderThemeTokens,
} from '../scripts/theme-tokens.mjs'

describe('theme tokens', () => {
  it('the checked-in file is what the generator produces from the CSS', () => {
    // Change a token in globals.css or fluid.css and this fails until
    // `pnpm --filter @openmanager/app-core theme-tokens` is run.
    expect(currentThemeTokensFile()).toBe(renderThemeTokens())
  })

  it('covers every scheme theme-families declares, and no other', () => {
    expect([...SCHEMES].sort()).toEqual([...THEME_MODES].sort())
    expect(Object.keys(THEME_TOKENS).sort()).toEqual([...THEME_MODES].sort())
  })

  it('resolves every var() and colour function', () => {
    for (const [scheme, tokens] of Object.entries(THEME_TOKENS)) {
      for (const [name, value] of Object.entries(tokens)) {
        expect(value, `${scheme} ${name}`).not.toMatch(/var\(|color-mix\(|oklch\(|oklab\(/)
      }
    }
  })

  it('paints each family the colours its swatch promises', () => {
    for (const family of THEME_FAMILIES) {
      for (const side of ['light', 'dark'] as const) {
        const scheme = family[side]
        const tokens = THEME_TOKENS[scheme.id]
        expect(tokens['basis-canvas-bg'], `${scheme.id} canvas`).toBe(scheme.swatch.canvas)
        // A swatch's ink is the body text or the strong text, by family.
        expect([tokens['basis-text'], tokens['basis-text-strong']], `${scheme.id} ink`).toContain(
          scheme.swatch.ink,
        )
      }
    }
  })

  it('keeps the cascade: a family override beats the root default', () => {
    // fluid.css sets Neutral's canvas on `:root[data-theme='neutral']`, which
    // beats globals.css's later `:root { --basis-canvas-bg: #141414 }` by
    // specificity, not order.
    expect(THEME_TOKENS.neutral['basis-canvas-bg']).toBe('#171717')
    expect(THEME_TOKENS.dark['basis-canvas-bg']).toBe('#141414')
    // The light schemes replace the translucent status washes with pastels.
    expect(THEME_TOKENS['neutral-light']['basis-status-done-wash']).toBe('#e3f6ec')
    expect(THEME_TOKENS.neutral['basis-status-done-wash']).toMatch(/^rgba\(/)
  })

  it('parses the floating-surface shadows into layers', () => {
    const rest = THEME_SHADOWS.neutral['float-shadow-rest']
    expect(rest.length).toBeGreaterThan(2)
    expect(rest[0]).toMatchObject({ inset: true, x: 0, y: 1 })
    expect(rest.every((layer) => /^(#[0-9a-f]{6}|rgba\()/.test(layer.color))).toBe(true)
    const light = THEME_SHADOWS['neutral-light']['float-shadow-rest']
    expect(light.every((layer) => !layer.inset)).toBe(true)
  })

  it('exposes the same token set on every scheme', () => {
    const generated = generateThemeTokens()
    const names = new Set<string>()
    for (const tokens of generated.values()) for (const name of tokens.keys()) names.add(name)
    for (const required of [
      'basis-canvas-bg',
      'basis-text',
      'basis-text-muted',
      'basis-text-faint',
      'basis-action-bg',
      'basis-action-fg',
      'basis-status-working',
      'basis-status-background',
      'basis-status-needs',
      'basis-status-question',
      'basis-status-done',
      'basis-status-error',
      'basis-chat-user-bg',
      'hover',
      'active',
      'rule',
      'float-bg',
      'float-scrim',
      'float-shadow',
      'float-shadow-rest',
    ]) {
      expect(names.has(required), required).toBe(true)
      for (const [scheme, tokens] of generated) {
        expect(tokens.has(required), `${scheme} ${required}`).toBe(true)
      }
    }
  })
})
