// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  ProviderModelPicker,
  type ProviderModelGroup,
} from '../src/components/chat/ProviderModelPicker'
import { FAVORITE_MODELS_STORAGE_KEY } from '../src/components/chat/favoriteModels'
import { ThemeProvider } from '../src/providers/theme-provider'

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as unknown as typeof window.matchMedia
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GROUPS: ProviderModelGroup[] = [
  {
    providerId: 'claude',
    providerName: 'Claude Code',
    models: [
      { id: 'default', name: 'Default' },
      { id: 'opus', name: 'Opus', contextWindowTokens: 1_000_000 },
      { id: 'sonnet', name: 'Sonnet' },
    ],
  },
  {
    providerId: 'cursor',
    providerName: 'Cursor',
    models: [
      { id: 'composer-2.5', name: 'Composer 2.5' },
      { id: 'gpt-5.5', name: 'GPT-5.5' },
    ],
  },
  {
    providerId: 'opencode',
    providerName: 'OpenCode',
    unavailableReason: 'Not signed in',
    models: [{ id: 'kimi', name: 'Kimi K2' }],
  },
]

let root: Root | null = null
let host: HTMLElement | null = null
// Favorites persist to localStorage, which Node 25+ shadows with its own
// (absent without --localstorage-file); give each test a fresh in-memory one.
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  }
}

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  vi.unstubAllGlobals()
})

function render(props: Partial<Parameters<typeof ProviderModelPicker>[0]> = {}) {
  const onChange = vi.fn()
  const onDone = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <ThemeProvider>
        <ProviderModelPicker
          groups={GROUPS}
          currentProviderId="claude"
          currentModelId="opus"
          onChange={onChange}
          canChangeProvider
          shortcut="mod+shift+m"
          onDone={onDone}
          {...props}
        />
      </ThemeProvider>,
    ),
  )
  return { onChange, onDone }
}

function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? window
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
}

function openWithShortcut() {
  press('M', { ctrlKey: true, shiftKey: true, code: 'KeyM' })
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')
  expect(input).toBeTruthy()
  return input!
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
const labels = () => rows().map((row) => row.querySelector('.truncate')?.textContent)
const highlighted = () =>
  rows()
    .find((row) => row.getAttribute('aria-selected') === 'true')
    ?.querySelector('.truncate')?.textContent
// A tab draws its label twice (one copy sizes the other), so match within it.
const selectedTab = () =>
  document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? ''

describe('ProviderModelPicker', () => {
  it('opens from its shortcut on the current provider, its model highlighted', () => {
    render()
    const input = openWithShortcut()
    expect(document.activeElement).toBe(input)
    expect(selectedTab()).toContain('Claude Code')
    expect(labels()).toEqual(['Default', 'Opus', 'Sonnet'])
    expect(highlighted()).toBe('Opus')
  })

  it('has no All tab: Favorites, then one tab per provider', () => {
    render()
    openWithShortcut()
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
    expect(tabs).toHaveLength(4)
    expect(tabs[0]).toContain('Favorites')
    expect(tabs.some((tab) => tab?.includes('All'))).toBe(false)
  })

  it('picks with the arrows and Enter, then hands focus back', () => {
    const { onChange, onDone } = render()
    openWithShortcut()
    press('ArrowDown')
    expect(highlighted()).toBe('Sonnet')
    press('Enter')
    expect(onChange).toHaveBeenCalledWith('claude', 'sonnet')
    expect(onDone).toHaveBeenCalled()
    expect(document.querySelector('input[role="combobox"]')).toBeNull()
  })

  it('steps through the provider tabs with Tab and Shift+Tab', () => {
    render()
    openWithShortcut()
    press('Tab')
    expect(selectedTab()).toContain('Cursor')
    expect(labels()).toEqual(['Composer 2.5', 'GPT-5.5'])
    press('Tab')
    expect(selectedTab()).toContain('OpenCode')
    press('Tab')
    expect(selectedTab()).toContain('Favorites')
    press('Tab', { shiftKey: true })
    expect(selectedTab()).toContain('OpenCode')
  })

  it('searches the tab on screen, and says which tabs hold a match', () => {
    render()
    const input = openWithShortcut()
    type(input, 'gpt')
    expect(labels()).toEqual([])
    expect(document.body.textContent).toContain('Found in Cursor. Tab to look there')
    press('Tab')
    expect(labels()).toEqual(['GPT-5.5'])
    type(input, 'cursor')
    expect(labels()).toEqual(['Composer 2.5', 'GPT-5.5'])
  })

  it('matches a model id anywhere, not just from its start', () => {
    render({ currentProviderId: 'cursor', currentModelId: 'gpt-5.5' })
    const input = openWithShortcut()
    // Only the id `composer-2.5` holds "r-2"; the name reads "Composer 2.5".
    type(input, 'r-2')
    expect(labels()).toEqual(['Composer 2.5'])
  })

  it('offers a typed id as a model of a provider that takes them', () => {
    const { onChange } = render({
      groups: GROUPS.map((group) =>
        group.providerId === 'claude' ? { ...group, acceptsTypedIds: true } : group,
      ),
    })
    const input = openWithShortcut()
    type(input, 'opus')
    // A typed id the tab already lists is just that row.
    expect(labels()).toEqual(['Opus'])
    type(input, 'claude-opus-9')
    expect(labels()).toEqual(['Use \u201cclaude-opus-9\u201d'])
    press('Enter')
    expect(onChange).toHaveBeenCalledWith('claude', 'claude-opus-9')
  })

  it('never offers a typed id for a provider that does not take them', () => {
    render()
    const input = openWithShortcut()
    type(input, 'claude-opus-9')
    expect(labels()).toEqual([])
  })

  it('keeps a starred typed id listed after another model is picked, in its own favorites', () => {
    localStorage.setItem('title-stars', JSON.stringify(['claude:claude-opus-9', 'cursor:auto']))
    render({
      favoritesStorageKey: 'title-stars',
      groups: GROUPS.map((group) =>
        group.providerId === 'claude' ? { ...group, acceptsTypedIds: true } : group,
      ),
    })
    openWithShortcut()
    expect(labels()).toContain('claude-opus-9')
    press('Tab', { shiftKey: true })
    expect(selectedTab()).toContain('Favorites')
    // Cursor takes no typed ids here, so its star has nothing to stand for.
    expect(labels()).toEqual(['claude-opus-9'])
    press('ArrowDown')
    press('s', { ctrlKey: true })
    expect(JSON.parse(localStorage.getItem('title-stars')!)).toEqual(['cursor:auto'])
    expect(localStorage.getItem(FAVORITE_MODELS_STORAGE_KEY)).toBeNull()
  })

  it('lets Tab leave the field when there are no tabs', () => {
    render({ canChangeProvider: false })
    const input = openWithShortcut()
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => {
      input.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(false)
  })

  it('stars a model whose provider is unavailable', () => {
    render({ currentProviderId: 'opencode', currentModelId: 'kimi' })
    const input = openWithShortcut()
    type(input, 'kimi')
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Favorite Kimi K2"]')!.click())
    expect(JSON.parse(localStorage.getItem(FAVORITE_MODELS_STORAGE_KEY)!)).toEqual([
      'opencode:kimi',
    ])
  })

  it('lists an unavailable provider with its reason but will not pick it', () => {
    const { onChange } = render()
    const input = openWithShortcut()
    press('Tab')
    press('Tab')
    type(input, 'kimi')
    const [row] = rows()
    expect(row?.getAttribute('aria-disabled')).toBe('true')
    expect(row?.textContent).toContain('Not signed in')
    press('Enter')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stars the highlighted model with Ctrl+S and picks favorites with Alt+digit', () => {
    const { onChange } = render()
    openWithShortcut()
    press('ArrowDown') // Sonnet
    press('s', { ctrlKey: true })
    expect(JSON.parse(localStorage.getItem(FAVORITE_MODELS_STORAGE_KEY)!)).toEqual([
      'claude:sonnet',
    ])
    press('1', { altKey: true, code: 'Digit1' })
    expect(onChange).toHaveBeenCalledWith('claude', 'sonnet')
  })

  it('closes on Escape even with a query typed', () => {
    const { onDone } = render()
    const input = openWithShortcut()
    type(input, 'son')
    press('Escape')
    expect(document.querySelector('input[role="combobox"]')).toBeNull()
    expect(onDone).toHaveBeenCalled()
  })

  it('shows no tabs when the provider cannot change', () => {
    render({ canChangeProvider: false })
    openWithShortcut()
    expect(document.querySelector('[role="tab"]')).toBeNull()
    expect(labels()).toEqual(['Default', 'Opus', 'Sonnet'])
  })

  it('ignores its shortcut while disabled', () => {
    render({ disabled: true })
    press('M', { ctrlKey: true, shiftKey: true, code: 'KeyM' })
    expect(document.querySelector('input[role="combobox"]')).toBeNull()
  })
})
