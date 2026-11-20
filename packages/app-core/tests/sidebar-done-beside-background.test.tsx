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

const desk: SidebarRowEnvironment = {
  name: 'Desk',
  canSettle: true,
  canPin: true,
  canCook: true,
  offline: false,
  iconLookup: null,
}

const workspace = (inBackground: boolean): SidebarWorkspace => ({
  path: '/desk/project',
  name: 'project',
  environmentId: 'desk',
  sessions: [
    {
      externalId: 'codex-session',
      environmentId: 'desk',
      title: 'Dev server up',
      // What `groupSidebarSessions` makes of a turn done beside a terminal.
      status: 'done',
      providerId: 'codex' as ProviderId,
      updatedAt: '2026-11-01T10:00:00.000Z',
      ...(inBackground ? { inBackground: true, backgroundTaskCount: 1 } : {}),
    },
  ],
})

async function show(inBackground: boolean) {
  await act(async () =>
    root.render(
      <ThemeProvider>
        <SidebarProvider>
          <WorkspaceSidebarView
            rowEnvironments={{ desk }}
            workspaces={[workspace(inBackground)]}
            activeEnvironmentId="desk"
            activeWorkspacePath={null}
            activeSessionId={null}
            onCreateSession={() => undefined}
            onSelectSession={() => undefined}
            onAddWorkspace={() => undefined}
            onSettleSession={() => undefined}
            onCookSession={() => undefined}
          />
        </SidebarProvider>
      </ThemeProvider>,
    ),
  )
}

const action = (label: string) => container.querySelector(`button[aria-label="${label}"]`)

describe('a session done beside background work that runs on', () => {
  it('shows done, and offers neither settling (live work) nor cooking (it needs you)', async () => {
    await show(true)
    expect(container.textContent).toContain('Done')
    expect(action('Settle')).toBeNull()
    expect(action('Send to Cooking')).toBeNull()
  })

  it('can be settled once nothing runs any more', async () => {
    await show(false)
    expect(container.textContent).toContain('Done')
    expect(action('Settle')).not.toBeNull()
    expect(action('Send to Cooking')).toBeNull()
  })
})
