// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
} from '@openmanager/environment-client'
import { SidebarProvider, useSidebar } from '../src/components/fluid/ui/sidebar'
import { WorkspaceSidebar } from '../src/components/sidebar/WorkspaceSidebar'
import { usePortaledMenu } from '../src/components/ui/usePortaledMenu'
import { EnvironmentApplicationProviders } from '../src/providers/environment-application'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import { ThemeProvider } from '../src/providers/theme-provider'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // A phone: every max-width query matches, so the sidebar is the sheet.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width'),
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
  globalThis.localStorage?.clear()
  vi.unstubAllGlobals()
  MotionGlobalConfig.skipAnimations = false
})

const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false, providers: ['opencode'] },
  exists: true,
}
const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: 'Phone work' }
const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }

const sheet: { open: boolean; setOpen: (open: boolean) => void } = {
  open: false,
  setOpen: () => undefined,
}
function SheetProbe() {
  const { openMobile, setOpenMobile } = useSidebar()
  useEffect(() => {
    sheet.open = openMobile
    sheet.setOpen = setOpenMobile
  })
  return null
}

const drain = async (client: MockEnvironmentClient) => {
  for (let round = 0; round < 4; round += 1) {
    await act(() => client.settle())
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

describe('the sidebar sheet on a phone', () => {
  it('closes when a session is picked from it', async () => {
    const client = createMockEnvironmentClient({
      seed: { workspaces: [WORKSPACE], sessions: [{ session: SESSION, threads: [THREAD] }] },
      latencyMs: 5,
    })
    await act(() =>
      root.render(
        <ThemeProvider>
          <EnvironmentClientProvider client={client}>
            <EnvironmentApplicationProviders collapsedWorkspaceStorage={null}>
              <SidebarProvider persist={false}>
                <WorkspaceSidebar />
                <SheetProbe />
              </SidebarProvider>
            </EnvironmentApplicationProviders>
          </EnvironmentClientProvider>
        </ThemeProvider>,
      ),
    )
    await drain(client)
    await act(() => sheet.setOpen(true))
    await drain(client)
    expect(sheet.open).toBe(true)

    const dialog = document.querySelector('[role="dialog"]')!
    const row = [...dialog.querySelectorAll<HTMLElement>('[role="listitem"] button')].find(
      (button) => button.textContent?.includes('Phone work'),
    )
    expect(row).toBeDefined()
    await act(() => row!.click())
    await drain(client)
    expect(sheet.open).toBe(false)
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
  })
})

describe('composer menus on a narrow window', () => {
  it('are never wider than the window, and stay inside it', async () => {
    vi.stubGlobal('innerWidth', 360)
    const seen: { left: number; width: number }[] = []
    function Menu() {
      const { triggerRef, setOpen, menuCoords } = usePortaledMenu({ minWidth: 440 })
      useEffect(() => setOpen(true), [setOpen])
      useEffect(() => {
        if (menuCoords) seen.push({ left: menuCoords.left, width: menuCoords.width })
      }, [menuCoords])
      return <button ref={triggerRef}>Model</button>
    }
    await act(() => root.render(<Menu />))
    expect(seen.at(-1)).toEqual({ left: 8, width: 344 })
  })
})
