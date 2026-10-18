import { afterEach, describe, expect, it } from 'vitest'
import { readStoredTheme } from '@openmanager/app-core/providers/theme-provider'
import script from '../public/theme-boot.js?raw'

// public/theme-boot.js paints the saved scheme before React runs. It can't
// import the theme catalog, so these pin that it paints what ThemeProvider
// will, including for values saved before families lost their variants.

function boot(systemLight = false) {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    ...original(query),
    matches: query.includes('light') ? systemLight : false,
  })) as typeof window.matchMedia
  try {
    delete document.documentElement.dataset.theme
    new Function(script)()
    return {
      painted: document.documentElement.dataset.theme ?? 'dark',
      provider: readStoredTheme(),
    }
  } finally {
    window.matchMedia = original
  }
}

afterEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.uiFont
})

describe('theme-boot.js', () => {
  it.each([
    ['neutral-light-soft', 'neutral-light'],
    ['lovable-light-inverse', 'lovable-light'],
    ['lovable-light', 'lovable-light'],
    ['lovable', 'lovable'],
    ['black', 'lovable'],
    ['claude-light', 'claude-light'],
    ['dark', 'dark'],
  ])('paints a scheme saved alone (%s) as ThemeProvider will show it', (saved, shown) => {
    localStorage.setItem('openmanager-theme', saved)
    expect(boot()).toEqual({ painted: shown, provider: shown })
  })

  it.each([
    [
      'Default with Black',
      { mode: 'dark', family: 'default', light: 'light', dark: 'black' },
      'lovable',
    ],
    [
      'Default with Black, on its light side',
      { mode: 'light', family: 'default', light: 'light', dark: 'black' },
      'lovable-light',
    ],
    [
      'Neutral with Soft',
      { mode: 'light', family: 'neutral', light: 'neutral-light-soft', dark: 'neutral' },
      'neutral-light',
    ],
    [
      'Lovable with Inverse',
      { mode: 'light', family: 'lovable', light: 'lovable-light-inverse', dark: 'lovable' },
      'lovable-light',
    ],
    [
      'Lovable on its old light',
      { mode: 'light', family: 'lovable', light: 'lovable-light', dark: 'lovable' },
      'lovable-light',
    ],
    [
      'Lovable on its old dark',
      { mode: 'dark', family: 'lovable', light: 'lovable-light', dark: 'lovable' },
      'lovable',
    ],
  ])('paints an appearance saved with variants (%s) as ThemeProvider will', (_, saved, shown) => {
    localStorage.setItem('openmanager-appearance', JSON.stringify({ ...saved, picks: {} }))
    localStorage.setItem('openmanager-theme', saved[saved.mode as 'light' | 'dark'])
    expect(boot()).toEqual({ painted: shown, provider: shown })
  })

  it('follows the system for a system appearance', () => {
    localStorage.setItem(
      'openmanager-appearance',
      JSON.stringify({ mode: 'system', family: 'carbon', light: 'carbon-light', dark: 'carbon' }),
    )
    expect(boot(false)).toEqual({ painted: 'carbon', provider: 'carbon' })
    expect(boot(true)).toEqual({ painted: 'carbon-light', provider: 'carbon-light' })
  })
})
