// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { SidebarProvider } from '../src/components/fluid/ui/sidebar'
import { WorkspaceSidebarView } from '../src/components/sidebar/WorkspaceSidebarView'
import type { SidebarSession, SidebarWorkspace } from '../src/components/sidebar/sidebar-sessions'
import { ThemeProvider } from '../src/providers/theme-provider'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }))
  // Not every Node's jsdom has one, and these tests are about what it keeps.
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  })
  MotionGlobalConfig.skipAnimations = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  MotionGlobalConfig.skipAnimations = false
})

const session = (title: string, minute: number, status = 'ready'): SidebarSession => ({
  externalId: title,
  title,
  status,
  providerId: 'opencode',
  updatedAt: `2026-09-24T10:${String(minute).padStart(2, '0')}:00Z`,
})

const WORKSPACES: SidebarWorkspace[] = [
  {
    path: '/repo',
    name: 'repo',
    sessions: [session('newest', 30), session('middle', 20), session('oldest', 10, 'running')],
  },
]

const render = (target: Root, workspaces: SidebarWorkspace[] = WORKSPACES) =>
  act(async () =>
    target.render(
      <ThemeProvider>
        <SidebarProvider persist={false}>
          <WorkspaceSidebarView
            workspaces={workspaces}
            activeWorkspacePath={null}
            activeSessionId={null}
            onCreateSession={() => undefined}
            onSelectSession={() => undefined}
            onAddWorkspace={() => undefined}
          />
        </SidebarProvider>
      </ThemeProvider>,
    ),
  )

const cards = () => Array.from(container.querySelectorAll<HTMLElement>('[role="listitem"]'))
const titles = () =>
  cards().map((card) =>
    ['newest', 'middle', 'oldest'].find((title) => card.textContent?.includes(title)),
  )
const button = (title: string, label: string) =>
  cards()
    .find((card) => card.textContent?.includes(title))!
    .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const click = (element: HTMLElement | null) => act(async () => element!.click())

describe('pinning a session', () => {
  it('moves it to the top of Active and back to its place on unpin', async () => {
    await render(root)
    expect(titles()).toEqual(['newest', 'middle', 'oldest'])

    await click(button('middle', 'Pin to top'))
    expect(titles()).toEqual(['middle', 'newest', 'oldest'])

    await click(button('middle', 'Unpin'))
    expect(titles()).toEqual(['newest', 'middle', 'oldest'])
  })

  it('offers the pin on live work, which cannot be settled', async () => {
    await render(root)
    expect(button('oldest', 'Settle')).toBeNull()

    await click(button('oldest', 'Pin to top'))
    expect(titles()).toEqual(['oldest', 'newest', 'middle'])
  })

  it('puts the newest pin on top', async () => {
    await render(root)
    await click(button('middle', 'Pin to top'))
    await click(button('oldest', 'Pin to top'))
    expect(titles()).toEqual(['oldest', 'middle', 'newest'])
  })

  it('stays put when an unpinned session gets newer activity', async () => {
    await render(root)
    await click(button('oldest', 'Pin to top'))
    await render(root, [
      { ...WORKSPACES[0]!, sessions: [{ ...session('middle', 59) }, session('newest', 30)] },
      { path: '/other', name: 'other', sessions: [session('oldest', 10, 'running')] },
    ])
    expect(titles()).toEqual(['oldest', 'middle', 'newest'])
  })

  it('keeps the pin across a reload', async () => {
    await render(root)
    await click(button('oldest', 'Pin to top'))
    await act(async () => root.unmount())

    root = createRoot(container)
    await render(root)
    expect(titles()).toEqual(['oldest', 'newest', 'middle'])
    expect(button('oldest', 'Unpin')).not.toBeNull()
  })

  it('ignores the second half of a double click', async () => {
    await render(root)
    const pin = button('middle', 'Pin to top')!
    await act(async () => {
      pin.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    })
    const nowUnder = button('newest', 'Pin to top')!
    await act(async () => {
      nowUnder.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
    })
    expect(titles()).toEqual(['middle', 'newest', 'oldest'])
  })

  it('survives a corrupt stored value', async () => {
    localStorage.setItem('openmanager.sidebar.pinned-sessions', '{not json')
    await render(root)
    expect(titles()).toEqual(['newest', 'middle', 'oldest'])
  })
})
