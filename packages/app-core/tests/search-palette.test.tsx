// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MessageSearchHit } from '@openmanager/protocol'
import {
  SearchPaletteBody,
  SearchPaletteDialog,
  requestSearch,
  type SearchableSession,
} from '../src/components/command/SearchPalette'
import type { ChatSearchSource } from '../src/lib/chat-search'
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

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  vi.useRealTimers()
})

const SESSIONS: SearchableSession[] = [
  {
    environmentId: 'desktop',
    externalId: 's1',
    title: 'Socket keeps dropping',
    providerId: 'claude',
    workspacePath: '/w/app',
    workspaceName: 'app',
    updatedAt: '2026-11-10T09:00:00.000Z',
  },
  {
    environmentId: 'laptop',
    externalId: 's2',
    title: 'Cloudflare tunnel restarts',
    providerId: 'cursor',
    workspacePath: '/w/infra',
    workspaceName: 'infra',
    updatedAt: '2026-11-10T10:00:00.000Z',
  },
]

const hit = (
  sessionId: string,
  snippet: string,
  highlights: [number, number][],
): MessageSearchHit => ({
  sessionId,
  workspaceId: 'w',
  title: null,
  messageId: `${sessionId}-m`,
  role: 'assistant',
  at: '2026-11-10T09:30:00.000Z',
  snippet,
  highlights,
  matches: 1,
})

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const groups = () =>
  [...document.querySelectorAll('[role="group"]')].map((group) => ({
    heading: group.querySelector('[role="presentation"]')?.textContent,
    rows: [...group.querySelectorAll('[role="option"]')].map((row) => row.textContent ?? ''),
  }))

function mount(sources: ChatSearchSource[], onOpenSession = vi.fn()) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <ThemeProvider>
        <SearchPaletteDialog>
          <SearchPaletteBody
            sessions={SESSIONS}
            sources={sources}
            environmentName={(id) => (id === 'desktop' ? 'Desktop' : 'Laptop')}
            onOpenSession={onOpenSession}
          />
        </SearchPaletteDialog>
      </ThemeProvider>,
    ),
  )
  return onOpenSession
}

const field = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')

describe('SearchPalette', () => {
  it('opens on Ctrl+Shift+F and on request, listing recent sessions newest first', () => {
    mount([])
    expect(field()).toBeNull()
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }),
      )
    })
    expect(document.activeElement).toBe(field())
    expect(groups()).toEqual([
      {
        heading: 'Recent',
        rows: [
          expect.stringContaining('Cloudflare tunnel restarts'),
          expect.stringContaining('Socket keeps dropping'),
        ],
      },
    ])
    // Two environments: each row names its own.
    expect(groups()[0]!.rows[0]).toContain('Laptop')

    act(() => {
      field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    act(() => requestSearch())
    expect(field()).toBeTruthy()
  })

  it('matches titles at once, then lists message hits under them without repeating a session', async () => {
    vi.useFakeTimers()
    const desktop = vi.fn(async () => [hit('s1', 'the reconnect loop', [[4, 13]])])
    const laptop = vi.fn(async () => [
      hit('s2', 'restart backoff', [[8, 15]]),
      hit('unknown', 'a session the sidebar does not hold', []),
    ])
    const open = mount([
      { environmentId: 'desktop', search: desktop },
      { environmentId: 'laptop', search: laptop },
    ])
    act(() => requestSearch())
    act(() => type(field()!, 'tunnel'))
    expect(groups()).toEqual([
      { heading: 'Sessions', rows: [expect.stringContaining('Cloudflare tunnel restarts')] },
    ])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(desktop).toHaveBeenCalledWith('tunnel', 20)
    // s2 is already listed by title; the unknown session cannot be opened.
    expect(groups()).toEqual([
      { heading: 'Sessions', rows: [expect.stringContaining('Cloudflare tunnel restarts')] },
      { heading: 'Messages', rows: [expect.stringContaining('the reconnect loop')] },
    ])
    expect(document.querySelector('mark')?.textContent).toBe('reconnect')

    const messageRow = document.querySelectorAll('[role="option"]')[1] as HTMLElement
    act(() => messageRow.click())
    expect(open).toHaveBeenCalledWith(SESSIONS[0])
  })

  it('says which environment could not be searched, and when nothing matches', async () => {
    vi.useFakeTimers()
    mount([
      { environmentId: 'desktop', search: async () => [] },
      { environmentId: 'laptop', search: () => Promise.reject(new Error('down')) },
    ])
    act(() => requestSearch())
    act(() => type(field()!, 'zebra'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(document.body.textContent).toContain('Nothing matches “zebra”.')
    expect(
      document.querySelector('[role="status"][aria-live="polite"]:not([data-slot])')?.textContent,
    ).toBe('Couldn’t search Laptop.')
  })
})
