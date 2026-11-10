// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { MotionGlobalConfig } from 'motion/react'
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  useSidebar,
  type SidebarContextValue,
} from '../src/components/fluid/ui/sidebar'
import {
  SidePanel,
  SidePanelHost,
  SidePanelPillSlot,
  useSidePanel,
} from '../src/components/side-panel/SidePanel'

// Two sidebars at once: the app's left rail and a right panel whose provider
// nests inside the left one's inset, the way the web shell mounts them.

let container: HTMLDivElement
let root: Root
let desktop = true
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: desktop ? false : query.includes('max-width'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }))
  MotionGlobalConfig.skipAnimations = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  for (const name of ['sidebar_state', 'right_state', 'side_panel_state']) {
    document.cookie = `${name}=; path=/; max-age=0`
  }
  globalThis.localStorage?.clear()
  vi.unstubAllGlobals()
  MotionGlobalConfig.skipAnimations = false
  desktop = true
})

const seen: Record<string, SidebarContextValue> = {}
function Probe({ name, side }: { name: string; side?: 'left' | 'right' }) {
  seen[name] = useSidebar(side)
  return null
}

function Shell({
  rightDisabled = false,
  rightDefaultOpen = false,
  inPanel,
}: {
  rightDisabled?: boolean
  rightDefaultOpen?: boolean
  inPanel?: ReactNode
}) {
  return (
    <SidebarProvider>
      <Sidebar>
        <Probe name="inLeft" />
        <button data-testid="left-row">row</button>
      </Sidebar>
      <SidebarInset>
        <SidebarProvider
          side="right"
          disabled={rightDisabled}
          defaultOpen={rightDefaultOpen}
          stateCookieName="right_state"
          widthStorageKey="right_width"
          width="400px"
          minWidth={320}
          maxWidth={640}
        >
          <div>
            <Probe name="topbar" />
            <Probe name="topbarRight" side="right" />
            <button data-testid="chat">chat</button>
            <input data-testid="composer" />
          </div>
          <Sidebar side="right">
            <Probe name="inRight" />
            <button data-testid="panel-row">row</button>
            {inPanel}
          </Sidebar>
        </SidebarProvider>
      </SidebarInset>
    </SidebarProvider>
  )
}

const press = async (key: string, target: Element = document.body, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`)!

describe('useSidebar binding', () => {
  it('binds sidebar internals to their own instance and everything else to the left one', async () => {
    await act(() => root.render(<Shell />))
    expect(seen.inLeft!.side).toBe('left')
    expect(seen.inRight!.side).toBe('right')
    // The topbar sits inside the right provider, yet its trigger keeps
    // driving the left rail.
    expect(seen.topbar).toBe(seen.inLeft)
    expect(seen.topbarRight).toBe(seen.inRight)
    expect(seen.inRight!.minWidth).toBe(320)
    expect(seen.inRight!.maxWidth).toBe(640)
    expect(seen.inLeft!.minWidth).toBe(160)
  })

  it('falls back to the nearest provider when there is no left one', async () => {
    await act(() =>
      root.render(
        <SidebarProvider side="right">
          <Probe name="lonely" />
        </SidebarProvider>,
      ),
    )
    expect(seen.lonely!.side).toBe('right')
  })

  it('throws for a side with no provider', () => {
    expect(() =>
      renderToString(
        <SidebarProvider>
          <Probe name="missing" side="right" />
        </SidebarProvider>,
      ),
    ).toThrow(/right SidebarProvider/)
  })
})

describe('separate persistence', () => {
  it('keeps each instance in its own cookie', async () => {
    await act(() => root.render(<Shell />))
    expect(seen.inLeft!.open).toBe(true)
    expect(seen.inRight!.open).toBe(false)
    await act(() => seen.inRight!.setOpen(true))
    expect(document.cookie).toContain('right_state=true')
    expect(document.cookie).not.toContain('sidebar_state')
    await act(() => seen.inLeft!.setOpen(false))
    expect(document.cookie).toContain('sidebar_state=false')
    expect(document.cookie).toContain('right_state=true')
  })

  it('restores each instance from its own keys, clamped to its own range', async () => {
    document.cookie = 'sidebar_state=false; path=/'
    document.cookie = 'right_state=true; path=/'
    localStorage.setItem('sidebar_width', '300')
    localStorage.setItem('right_width', '900')
    await act(() => root.render(<Shell />))
    expect(seen.inLeft!.open).toBe(false)
    expect(seen.inLeft!.width).toBe('300px')
    expect(seen.inRight!.open).toBe(true)
    expect(seen.inRight!.width).toBe('640px')
  })
})

describe('[ and ] routing', () => {
  it('sends [ to the left instance and ] to the right one with focus on the page', async () => {
    await act(() => root.render(<Shell />))
    await press(']')
    expect(seen.inRight!.open).toBe(true)
    expect(seen.inLeft!.open).toBe(true)
    await press('[')
    expect(seen.inLeft!.open).toBe(false)
    expect(seen.inRight!.open).toBe(true)
  })

  it('routes by key wherever focus is, nested or not', async () => {
    await act(() => root.render(<Shell rightDefaultOpen />))
    // Focus in the right panel: "[" still reaches the outer left provider.
    await press('[', byTestId('panel-row'))
    expect(seen.inLeft!.open).toBe(false)
    expect(seen.inRight!.open).toBe(true)
    // Focus in the left rail: "]" reaches the right provider it doesn't contain.
    await press(']', byTestId('left-row'))
    expect(seen.inRight!.open).toBe(false)
    // Focus in the chat column (inside both providers).
    await press(']', byTestId('chat'))
    expect(seen.inRight!.open).toBe(true)
    await press('[', byTestId('chat'))
    expect(seen.inLeft!.open).toBe(true)
  })

  it('ignores typing and modified keys', async () => {
    await act(() => root.render(<Shell />))
    await press(']', byTestId('composer'))
    await press(']', document.body, { metaKey: true })
    await press('[', document.body, { ctrlKey: true })
    expect(seen.inRight!.open).toBe(false)
    expect(seen.inLeft!.open).toBe(true)
  })

  it('leaves a disabled instance out of reach and remembers its saved state', async () => {
    document.cookie = 'right_state=true; path=/'
    await act(() => root.render(<Shell rightDisabled />))
    expect(seen.inRight!.open).toBe(false)
    await press(']')
    await act(() => seen.inRight!.toggleSidebar())
    expect(seen.inRight!.open).toBe(false)
    expect(document.cookie).toContain('right_state=true')
    await act(() => root.render(<Shell />))
    expect(seen.inRight!.open).toBe(true)
  })

  it('still lets the outermost of two same-side providers answer', async () => {
    await act(() =>
      root.render(
        <SidebarProvider persist={false}>
          <Probe name="outer" />
          <SidebarProvider persist={false}>
            <Probe name="inner" />
            <button data-testid="inner-row">row</button>
          </SidebarProvider>
        </SidebarProvider>,
      ),
    )
    await press('[')
    expect(seen.outer!.open).toBe(false)
    expect(seen.inner!.open).toBe(true)
    await press('[', byTestId('inner-row'))
    expect(seen.inner!.open).toBe(false)
    expect(seen.outer!.open).toBe(false)
  })
})

describe('SidePanelHost', () => {
  let controls: ReturnType<typeof useSidePanel> | null = null
  function Pill() {
    controls = useSidePanel()
    return (
      <button data-testid="pill" onClick={controls.toggle}>
        PRs
      </button>
    )
  }
  function Page({ panel, available = true }: { panel: boolean; available?: boolean }) {
    return (
      <SidebarProvider persist={false}>
        <SidebarInset>
          <SidePanelHost>
            <header>
              <SidePanelPillSlot />
            </header>
            {panel ? (
              <SidePanel available={available} title="Pull requests" pill={<Pill />}>
                <p data-testid="panel-body">Pull requests</p>
              </SidePanel>
            ) : null}
          </SidePanelHost>
        </SidebarInset>
      </SidebarProvider>
    )
  }

  it('is out of reach until a panel declares itself', async () => {
    await act(() => root.render(<Page panel={false} />))
    await press(']')
    expect(container.querySelector('[data-side-panel="pill"]')!.childElementCount).toBe(0)
    expect(
      container
        .querySelector('[data-slot="sidebar"][data-side="right"]')!
        .getAttribute('data-state'),
    ).toBe('collapsed')
  })

  it('renders the pill in the topbar slot and the content in the panel, and toggles', async () => {
    await act(() => root.render(<Page panel />))
    const slot = container.querySelector('[data-side-panel="pill"]')!
    expect(slot.contains(byTestId('pill'))).toBe(true)
    const panel = container.querySelector('[data-slot="sidebar"][data-side="right"]')!
    expect(panel.contains(byTestId('panel-body'))).toBe(true)
    expect(controls!.open).toBe(false)
    await act(() => (byTestId('pill') as HTMLButtonElement).click())
    expect(controls!.open).toBe(true)
    expect(panel.getAttribute('data-state')).toBe('expanded')
    await press(']')
    expect(controls!.open).toBe(false)
  })

  it('keeps ] inert when the panel says it has nothing to show', async () => {
    await act(() => root.render(<Page panel available={false} />))
    expect(controls!.available).toBe(false)
    await press(']')
    expect(controls!.open).toBe(false)
    expect(container.querySelector('[data-testid="panel-body"]')).toBeNull()
  })

  it('opens as a sheet from the right on a narrow screen', async () => {
    desktop = false
    await act(() => root.render(<Page panel />))
    await press(']')
    expect(controls!.open).toBe(true)
    const sheet = document.querySelector('[data-mobile="true"][data-side="right"]')
    expect(sheet).not.toBeNull()
    expect(sheet!.contains(document.querySelector('[data-testid="panel-body"]'))).toBe(true)
  })
})
