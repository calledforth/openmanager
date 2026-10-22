// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_FAMILIES } from '@openmanager/app-core/lib/theme-families'

// The phone's theme store, mounted on plain DOM: React Native's pieces it
// touches are stood in for, AsyncStorage is a map.
const saved = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => saved.get(key) ?? null,
    setItem: async (key: string, value: string) => void saved.set(key, value),
    removeItem: async (key: string) => void saved.delete(key),
  },
}))
let system: 'light' | 'dark' = 'dark'
vi.mock('react-native', () => ({
  useColorScheme: () => system,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: async () => undefined }))
vi.mock('nativewind', () => ({ vars: (map: Record<string, string>) => map }))

const { ThemeProvider, useTheme } = await import('../src/theme/ThemeProvider')
const { APPEARANCE_STORAGE_KEY } = await import('../src/theme/appearance')
const { MODE_OPTIONS, familySwatches, modeIndex } =
  await import('../src/settings/appearance-options')

let root: Root
let host: HTMLElement
let theme: ReturnType<typeof useTheme> | null = null
function Probe() {
  theme = useTheme()
  return null
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  saved.clear()
  system = 'dark'
  theme = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
const flush = () => act(() => new Promise<void>((done) => setTimeout(done, 0)))

describe('appearance on Settings', () => {
  it('shows the six families, painted on the side in use, the chosen one marked', () => {
    const dark = familySwatches('dark', 'neutral')
    expect(dark.map((swatch) => swatch.label)).toEqual(THEME_FAMILIES.map((family) => family.label))
    expect(dark).toHaveLength(6)
    expect(dark.filter((swatch) => swatch.selected).map((swatch) => swatch.id)).toEqual(['neutral'])
    expect(dark.find((swatch) => swatch.id === 'neutral')!.canvas).toBe('#171717')
    expect(familySwatches('light', 'neutral').find((s) => s.id === 'neutral')!.canvas).toBe(
      '#fcfcfc',
    )
  })

  it('offers Light, Dark and System in the mockup’s order', () => {
    expect(MODE_OPTIONS.map((option) => option.label)).toEqual(['Light', 'Dark', 'System'])
    expect(modeIndex('system')).toBe(2)
  })

  it('a family and a mode picked go through the phone’s theme store and are kept', async () => {
    act(() =>
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      ),
    )
    await flush()
    expect(theme!.hydrated).toBe(true)
    act(() => theme!.setFamily('carbon'))
    expect(theme!.scheme).toBe('carbon')
    act(() => theme!.setMode('light'))
    expect(theme!.scheme).toBe('carbon-light')
    expect(theme!.resolved).toBe('light')
    await flush()
    expect(JSON.parse(saved.get(APPEARANCE_STORAGE_KEY)!)).toEqual({
      mode: 'light',
      family: 'carbon',
    })
    // System follows the phone again.
    act(() => theme!.setMode('system'))
    expect(theme!.scheme).toBe('carbon')
  })
})
