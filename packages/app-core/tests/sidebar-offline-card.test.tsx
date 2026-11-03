// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import type { ProviderId } from '@agentpack/contract'
import { SidebarProvider } from '../src/components/fluid/ui/sidebar'
import { WorkspaceSidebarView } from '../src/components/sidebar/WorkspaceSidebarView'
import type { SidebarWorkspace } from '../src/components/sidebar/sidebar-sessions'
import type { SidebarRowEnvironment } from '../src/providers/sidebar-provider'
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

const laptop = (offline: boolean): SidebarRowEnvironment => ({
  name: 'Laptop',
  canSettle: false,
  canPin: false,
  offline,
  iconLookup: null,
})

const workspace = (status: string): SidebarWorkspace => ({
  path: '/laptop/project',
  name: 'project',
  environmentId: 'laptop',
  sessions: [
    {
      externalId: 'laptop-session',
      environmentId: 'laptop',
      title: 'Finished on the laptop',
      status,
      providerId: 'opencode' as ProviderId,
      updatedAt: '2026-11-01T10:00:00.000Z',
    },
  ],
})

async function show(status: string, offline: boolean) {
  await act(async () =>
    root.render(
      <ThemeProvider>
        <SidebarProvider>
          <WorkspaceSidebarView
            rowEnvironments={{ laptop: laptop(offline), desk: { ...laptop(false), name: 'Desk' } }}
            workspaces={[workspace(status)]}
            activeEnvironmentId="desk"
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
}

const flash = () => container.querySelector('.session-card-flash')

describe('an offline environment coming back', () => {
  it('shows no status while offline, and the word instead', async () => {
    await show('done', false)
    expect(container.textContent).toContain('Done')
    await show('done', true)
    expect(container.textContent).not.toContain('Done')
    expect(container.textContent).toContain('· offline')
  })

  it('plays nothing for a status that did not change while it was away', async () => {
    await show('done', false)
    await show('done', true)
    await show('done', false)
    expect(container.textContent).toContain('Done')
    expect(flash()).toBeNull()
  })

  it('still marks a status that is new when it comes back', async () => {
    await show('ready', false)
    await show('ready', true)
    await show('error', false)
    expect(flash()).not.toBeNull()
  })
})
