// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, memo, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import type { ProviderId } from '@agentpack/contract'
import { SidebarProvider } from '../src/components/fluid/ui/sidebar'
import { ProjectIcon } from '../src/components/sidebar/ProjectIcon'
import { WorkspaceSidebarView } from '../src/components/sidebar/WorkspaceSidebarView'
import type { SidebarSession } from '../src/components/sidebar/sidebar-sessions'
import { ThemeProvider } from '../src/providers/theme-provider'
import { ViewActionsContext, WorkspaceIconContext } from '../src/providers/view-actions'

/** Every string a rendered element would show. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) {
    return textOf((node.props as { children?: ReactNode }).children)
  }
  return ''
}

// Count what the sidebar's header buttons and section labels render, by what they read.
const rendered = vi.hoisted(() => [] as string[])
vi.mock('../src/components/fluid/ui/sidebar', async (importActual) => {
  const actual = await importActual<typeof import('../src/components/fluid/ui/sidebar')>()
  const counted = <P extends { children?: ReactNode }>(Component: unknown) =>
    function Counted(props: P) {
      rendered.push(textOf(props.children))
      return createElement(Component as never, props)
    }
  return {
    ...actual,
    SidebarMenuButton: counted(actual.SidebarMenuButton),
    SidebarGroupLabel: counted(actual.SidebarGroupLabel),
  }
})

const session = (
  externalId: string,
  title: string,
  updatedAt: string,
  settledAt: string | null = null,
): SidebarSession => ({
  externalId,
  title,
  status: 'ready',
  providerId: 'opencode' as ProviderId,
  updatedAt,
  settledAt,
})

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

/** Card bodies call this once per render, so it counts the cards that rendered. */
const providerLabel = vi.fn((providerId: ProviderId) => providerId)

async function render(sessions: SidebarSession[], activeSessionId: string | null = null) {
  // Fresh handlers every render, as a host that does not memoize them passes.
  await act(() =>
    root.render(
      <ThemeProvider>
        <SidebarProvider persist={false}>
          <WorkspaceSidebarView
            workspaces={[{ path: '/workspace/alpha', name: 'alpha', sessions }]}
            activeWorkspacePath="/workspace/alpha"
            activeSessionId={activeSessionId}
            onCreateSession={() => undefined}
            onSelectSession={() => undefined}
            onSettleSession={() => undefined}
            onAddWorkspace={() => undefined}
            providerLabel={providerLabel}
          />
        </SidebarProvider>
      </ThemeProvider>,
    ),
  )
}

const ACTIVE_A = session('a', 'Session A', '2026-10-01T12:00:00.000Z')
const ACTIVE_B = session('b', 'Session B', '2026-10-01T11:00:00.000Z')
const SETTLED = session('s', 'Put away', '2026-10-01T08:00:00.000Z', '2026-10-01T09:00:00.000Z')

const headerRenders = () => rendered.filter((text) => text === 'New agent').length
const shelfRenders = () => rendered.filter((text) => text.startsWith('Settled')).length

describe('what a session update re-renders', () => {
  it('leaves the header and the Settled shelf alone when an active session changes', async () => {
    await render([ACTIVE_A, ACTIVE_B, SETTLED])
    expect(headerRenders()).toBeGreaterThan(0)
    expect(shelfRenders()).toBeGreaterThan(0)
    rendered.length = 0
    providerLabel.mockClear()
    await render([{ ...ACTIVE_A, status: 'running' }, { ...ACTIVE_B }, { ...SETTLED }])
    expect(headerRenders()).toBe(0)
    expect(shelfRenders()).toBe(0)
    // The one card that changed.
    expect(providerLabel).toHaveBeenCalledTimes(1)
  })

  it('re-renders the shelf when one of its rows changes', async () => {
    await render([ACTIVE_A, SETTLED])
    rendered.length = 0
    await render([ACTIVE_A, { ...SETTLED, title: 'Renamed while away' }])
    expect(shelfRenders()).toBeGreaterThan(0)
    expect(container.textContent).toContain('Renamed while away')
  })

  it('re-renders the shelf when the selection moves onto one of its rows, and off it', async () => {
    await render([ACTIVE_A, SETTLED], 'a')
    rendered.length = 0
    await render([ACTIVE_A, SETTLED], 's')
    expect(shelfRenders()).toBeGreaterThan(0)
    rendered.length = 0
    await render([ACTIVE_A, SETTLED], 'a')
    expect(shelfRenders()).toBeGreaterThan(0)
  })

  it('does not re-render the shelf for a selection that stays among the active cards', async () => {
    await render([ACTIVE_A, ACTIVE_B, SETTLED], 'a')
    rendered.length = 0
    await render([ACTIVE_A, ACTIVE_B, SETTLED], 'b')
    expect(shelfRenders()).toBe(0)
  })
})

describe('project icons', () => {
  const fallbackRenders = vi.fn()
  function Fallback() {
    fallbackRenders()
    return null
  }
  // A row that is itself memoized: only context can re-render the icon in it.
  const Row = memo(function Row() {
    return <ProjectIcon workspacePath="ws-1" fallbackIcon={Fallback} />
  })

  async function renderIcon(activeSessionId: string, withIconSource: boolean) {
    const icon = <Row />
    await act(() =>
      root.render(
        <ViewActionsContext.Provider value={{ activeSessionId }}>
          {withIconSource ? (
            <WorkspaceIconContext.Provider value={null}>{icon}</WorkspaceIconContext.Provider>
          ) : (
            icon
          )}
        </ViewActionsContext.Provider>,
      ),
    )
  }

  it('stay put when the open session changes, given their own icon source', async () => {
    await renderIcon('one', true)
    fallbackRenders.mockClear()
    await renderIcon('two', true)
    expect(fallbackRenders).not.toHaveBeenCalled()
  })

  it('still read the lookup from ViewActions where a host gives no icon source', async () => {
    const resolveWorkspaceIcon = vi.fn(async () => null)
    await act(() =>
      root.render(
        <ViewActionsContext.Provider value={{ activeSessionId: null, resolveWorkspaceIcon }}>
          <ProjectIcon workspacePath="ws-1" />
        </ViewActionsContext.Provider>,
      ),
    )
    expect(resolveWorkspaceIcon).toHaveBeenCalledWith('ws-1')
  })
})
