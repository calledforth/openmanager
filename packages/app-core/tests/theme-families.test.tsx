// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  THEME_FAMILIES,
  THEME_MODES,
  ThemeProvider,
  familyOfTheme,
  isLightTheme,
  readStoredAppearance,
  resolveTheme,
  useTheme,
} from '../src/providers/theme-provider'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A controllable `prefers-color-scheme: light` query. */
let systemLight = false
const listeners = new Set<() => void>()
function setSystemLight(next: boolean) {
  systemLight = next
  for (const listener of listeners) listener()
}
window.matchMedia = ((query: string) => ({
  get matches() {
    return query.includes('light') ? systemLight : false
  },
  media: query,
  addEventListener: (_: string, listener: () => void) => listeners.add(listener),
  removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  addListener() {},
  removeListener() {},
})) as unknown as typeof window.matchMedia

let root: Root | null = null
let host: HTMLElement | null = null
let api: ReturnType<typeof useTheme>

function Probe() {
  api = useTheme()
  return null
}

function mount() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    ),
  )
}

const dataTheme = () => document.documentElement.dataset.theme ?? 'dark'
const stored = () => JSON.parse(localStorage.getItem('openmanager-appearance') ?? 'null')

beforeEach(() => {
  localStorage.clear()
  systemLight = false
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  listeners.clear()
})

describe('theme families', () => {
  it('puts every scheme in exactly one family, with both a light and a dark side', () => {
    const placed = THEME_FAMILIES.flatMap((family) => [...family.light, ...family.dark])
    expect(placed.map((variant) => variant.id).sort()).toEqual([...THEME_MODES].sort())
    for (const family of THEME_FAMILIES) {
      expect(family.light.every((variant) => isLightTheme(variant.id))).toBe(true)
      expect(family.dark.every((variant) => !isLightTheme(variant.id))).toBe(true)
    }
    expect(familyOfTheme('lovable-light-inverse').id).toBe('lovable')
    expect(familyOfTheme('black').id).toBe('default')
  })

  it('carries a saved scheme from before families over as its family and mode', () => {
    localStorage.setItem('openmanager-theme', 'lovable-light-inverse')
    expect(readStoredAppearance()).toEqual({
      mode: 'light',
      family: 'lovable',
      picks: { lovable: { light: 'lovable-light-inverse' } },
    })
    mount()
    expect(dataTheme()).toBe('lovable-light-inverse')
  })

  it('starts on the default family following the system', () => {
    systemLight = true
    mount()
    expect(api.mode).toBe('system')
    expect(api.family.id).toBe('default')
    expect(dataTheme()).toBe('light')
    act(() => setSystemLight(false))
    expect(dataTheme()).toBe('dark')
  })

  it('switches family without changing the mode', () => {
    mount()
    act(() => api.setMode('light'))
    act(() => api.setFamily('claude'))
    expect(dataTheme()).toBe('claude-light')
    act(() => api.setMode('dark'))
    expect(dataTheme()).toBe('claudeish')
    act(() => api.setFamily('carbon'))
    expect(dataTheme()).toBe('carbon')
    act(() => api.setMode('light'))
    expect(dataTheme()).toBe('carbon-light')
  })

  it('remembers the variant picked in each family', () => {
    mount()
    act(() => api.setMode('dark'))
    act(() => api.setVariant('black'))
    expect(dataTheme()).toBe('black')
    act(() => api.setFamily('neutral'))
    expect(dataTheme()).toBe('neutral')
    act(() => api.setFamily('default'))
    expect(dataTheme()).toBe('black')
    expect(api.variants).toEqual({ light: 'light', dark: 'black' })
  })

  it('saves what each mode resolves to, for the boot script', () => {
    mount()
    act(() => api.setFamily('lovable'))
    act(() => api.setVariant('lovable-light-inverse'))
    expect(stored()).toMatchObject({
      mode: 'system',
      family: 'lovable',
      light: 'lovable-light-inverse',
      dark: 'lovable',
    })
    expect(localStorage.getItem('openmanager-theme')).toBe('lovable')
  })

  it('pins a scheme and its mode with setTheme, so the system no longer moves it', () => {
    mount()
    act(() => api.setTheme('black'))
    expect(api.mode).toBe('dark')
    expect(dataTheme()).toBe('black')
    act(() => setSystemLight(true))
    expect(dataTheme()).toBe('black')
    act(() => api.setTheme('neutral-light'))
    expect(api.mode).toBe('light')
    expect(dataTheme()).toBe('neutral-light')
  })

  it('ignores picks that do not belong to the family', () => {
    expect(
      resolveTheme(
        { mode: 'light', family: 'carbon', picks: { carbon: { light: 'lovable-light' } } },
        'dark',
      ),
    ).toBe('carbon-light')
    localStorage.setItem(
      'openmanager-appearance',
      JSON.stringify({ mode: 'sepia', family: 'nope', picks: { lovable: { dark: 'light' } } }),
    )
    expect(readStoredAppearance()).toEqual({ mode: 'system', family: 'default', picks: {} })
  })

  it('falls back to the single saved scheme when the appearance is unreadable', () => {
    localStorage.setItem('openmanager-appearance', '{not json')
    localStorage.setItem('openmanager-theme', 'carbon')
    expect(readStoredAppearance()).toMatchObject({ mode: 'dark', family: 'carbon' })
  })
})
