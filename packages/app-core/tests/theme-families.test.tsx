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
  isThemeMode,
  readStoredAppearance,
  readStoredTheme,
  resolveTheme,
  themeFamily,
  themeModeFrom,
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
  root = null
  host?.remove()
  listeners.clear()
})

describe('theme families', () => {
  it('puts every scheme in exactly one family: one light side, one dark side', () => {
    const placed = THEME_FAMILIES.flatMap((family) => [family.light.id, family.dark.id])
    expect([...placed].sort()).toEqual([...THEME_MODES].sort())
    expect(new Set(placed).size).toBe(placed.length)
    for (const family of THEME_FAMILIES) {
      expect(isLightTheme(family.light.id)).toBe(true)
      expect(isLightTheme(family.dark.id)).toBe(false)
    }
  })

  it('pairs each family with its light and dark scheme', () => {
    expect(
      Object.fromEntries(
        THEME_FAMILIES.map((family) => [family.id, [family.light.id, family.dark.id]]),
      ),
    ).toEqual({
      default: ['light', 'dark'],
      neutral: ['neutral-light', 'neutral'],
      paper: ['paper-light', 'paper'],
      lovable: ['lovable-light', 'lovable'],
      claude: ['claude-light', 'claudeish'],
      carbon: ['carbon-light', 'carbon'],
    })
    expect(familyOfTheme('lovable').id).toBe('lovable')
  })

  it('maps schemes that have gone to the ones that replaced them', () => {
    expect(themeModeFrom('neutral-light-soft')).toBe('neutral-light')
    expect(themeModeFrom('lovable-light-inverse')).toBe('lovable-light')
    expect(themeModeFrom('black')).toBe('lovable')
    expect(themeModeFrom('lovable-light')).toBe('lovable-light')
    expect(themeModeFrom('carbon')).toBe('carbon')
    expect(themeModeFrom('sepia')).toBeUndefined()
    expect(themeModeFrom('toString')).toBeUndefined()
    expect(themeModeFrom(null)).toBeUndefined()
    for (const gone of ['neutral-light-soft', 'lovable-light-inverse', 'black']) {
      expect(isThemeMode(gone)).toBe(false)
    }
  })

  it.each([
    ['neutral-light-soft', 'light', 'neutral', 'neutral-light'],
    ['lovable-light-inverse', 'light', 'lovable', 'lovable-light'],
    ['lovable-light', 'light', 'lovable', 'lovable-light'],
    ['lovable', 'dark', 'lovable', 'lovable'],
    ['black', 'dark', 'lovable', 'lovable'],
    ['carbon', 'dark', 'carbon', 'carbon'],
  ] as const)(
    'carries a scheme saved alone before families (%s) over as its family and mode',
    (saved, mode, family, shown) => {
      localStorage.setItem('openmanager-theme', saved)
      expect(readStoredAppearance()).toEqual({ mode, family })
      mount()
      expect(dataTheme()).toBe(shown)
    },
  )

  it.each([
    [
      'Neutral with Soft picked',
      'neutral',
      'light',
      { neutral: { light: 'neutral-light-soft' } },
      'neutral-light',
    ],
    [
      'Lovable with Inverse picked',
      'lovable',
      'light',
      { lovable: { light: 'lovable-light-inverse' } },
      'lovable-light',
    ],
    ['Lovable on its old light', 'lovable', 'light', {}, 'lovable-light'],
    ['Lovable on its old dark', 'lovable', 'dark', {}, 'lovable'],
  ] as const)(
    'drops the variant picks of an appearance saved with them (%s)',
    (_, family, mode, picks, shown) => {
      localStorage.setItem(
        'openmanager-appearance',
        JSON.stringify({ mode, family, picks, light: 'gone', dark: 'gone' }),
      )
      localStorage.setItem('openmanager-theme', 'black')
      expect(readStoredAppearance()).toEqual({ mode, family })
      mount()
      expect(dataTheme()).toBe(shown)
      // Saved again without the picks, naming only schemes that exist.
      expect(stored()).toEqual({
        mode,
        family,
        light: themeFamily(family).light.id,
        dark: themeFamily(family).dark.id,
      })
      expect(localStorage.getItem('openmanager-theme')).toBe(shown)
    },
  )

  it('moves whoever picked Black under Default to Lovable, where Black lives now', () => {
    localStorage.setItem(
      'openmanager-appearance',
      JSON.stringify({
        mode: 'dark',
        family: 'default',
        picks: { default: { dark: 'black' } },
        light: 'light',
        dark: 'black',
      }),
    )
    expect(readStoredAppearance()).toEqual({ mode: 'dark', family: 'lovable' })
    mount()
    expect(dataTheme()).toBe('lovable')
    expect(stored()).toEqual({
      mode: 'dark',
      family: 'lovable',
      light: 'lovable-light',
      dark: 'lovable',
    })
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
    act(() => api.setFamily('lovable'))
    expect(dataTheme()).toBe('lovable')
    act(() => api.setMode('light'))
    expect(dataTheme()).toBe('lovable-light')
    act(() => api.setFamily('carbon'))
    expect(dataTheme()).toBe('carbon-light')
  })

  it('saves what each mode resolves to, for the boot script', () => {
    mount()
    act(() => api.setFamily('lovable'))
    expect(stored()).toEqual({
      mode: 'system',
      family: 'lovable',
      light: 'lovable-light',
      dark: 'lovable',
    })
    expect(localStorage.getItem('openmanager-theme')).toBe('lovable')
  })

  it('pins a scheme and its mode with setTheme, so the system no longer moves it', () => {
    mount()
    act(() => api.setTheme('lovable'))
    expect(api.mode).toBe('dark')
    expect(api.family.id).toBe('lovable')
    expect(dataTheme()).toBe('lovable')
    act(() => setSystemLight(true))
    expect(dataTheme()).toBe('lovable')
    act(() => api.setTheme('neutral-light'))
    expect(api.mode).toBe('light')
    expect(api.family.id).toBe('neutral')
    expect(dataTheme()).toBe('neutral-light')
  })

  it('reads the scheme a shell should paint before it mounts', () => {
    localStorage.setItem(
      'openmanager-appearance',
      JSON.stringify({ mode: 'system', family: 'paper' }),
    )
    expect(readStoredTheme()).toBe('paper')
    systemLight = true
    expect(readStoredTheme()).toBe('paper-light')
    localStorage.clear()
    localStorage.setItem('openmanager-theme', 'black')
    expect(readStoredTheme()).toBe('lovable')
  })

  it('ignores an appearance it does not understand', () => {
    expect(resolveTheme({ mode: 'light', family: 'carbon' }, 'dark')).toBe('carbon-light')
    localStorage.setItem(
      'openmanager-appearance',
      JSON.stringify({ mode: 'sepia', family: 'nope', picks: { lovable: { dark: 'light' } } }),
    )
    expect(readStoredAppearance()).toEqual({ mode: 'system', family: 'default' })
  })

  it('falls back to the single saved scheme when the appearance is unreadable', () => {
    localStorage.setItem('openmanager-appearance', '{not json')
    localStorage.setItem('openmanager-theme', 'carbon')
    expect(readStoredAppearance()).toEqual({ mode: 'dark', family: 'carbon' })
  })
})
