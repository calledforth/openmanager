// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
} from '@openmanager/environment-client'
import type { Workspace } from '@openmanager/protocol'
import { ChatWorkspace } from '../src/components/chat/ChatWorkspace'
import { EnvironmentPicker } from '../src/components/chat/EnvironmentPicker'
import { NewSessionLandingView } from '../src/components/chat/NewSessionLanding'
import { SidebarProvider } from '../src/components/fluid/ui/sidebar'
import { WorkspaceSidebarView } from '../src/components/sidebar/WorkspaceSidebarView'
import type { SidebarWorkspace } from '../src/components/sidebar/sidebar-sessions'
import { EnvironmentApplicationProviders } from '../src/providers/environment-application'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import {
  EnvironmentChoiceContext,
  type EnvironmentChoiceValue,
  type EnvironmentOption,
} from '../src/providers/sidebar-provider'
import { ThemeProvider } from '../src/providers/theme-provider'

const ENVIRONMENTS: EnvironmentOption[] = [
  { environmentId: 'desk', label: 'Desk', reachable: true },
  { environmentId: 'laptop', label: 'Laptop', reachable: true },
  { environmentId: 'lab', label: 'Lab', reachable: false },
]

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

const render = (node: ReactNode) => act(async () => root.render(node))
const trigger = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label^="Environment: "]')
const option = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
    row.textContent?.startsWith(label),
  )

describe('EnvironmentPicker', () => {
  const picker = async (onSelect = vi.fn(), selectedId = 'desk') => {
    await render(
      <EnvironmentPicker environments={ENVIRONMENTS} selectedId={selectedId} onSelect={onSelect} />,
    )
    await act(async () => trigger()!.click())
    return onSelect
  }

  it('lists the environments and marks the one the page is on', async () => {
    await picker()
    expect(trigger()!.textContent).toContain('Desk')
    expect(option('Desk')?.querySelector('[aria-label="Current environment"]')).toBeTruthy()
    expect(option('Laptop')?.querySelector('[aria-label="Current environment"]')).toBeNull()
  })

  it('goes where it is told', async () => {
    const onSelect = await picker()
    await act(async () => option('Laptop')!.click())
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('laptop')
  })

  it('has nothing to do for the environment already on the page', async () => {
    const onSelect = await picker()
    await act(async () => option('Desk')!.click())
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('will not go to one it cannot reach', async () => {
    const onSelect = await picker()
    expect(option('Lab')?.getAttribute('aria-disabled')).toBe('true')
    expect(option('Lab')?.textContent).toContain('Not connected')
    await act(async () => option('Lab')!.click())
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('tells apart twins that are not connected by their addresses', async () => {
    await render(
      <EnvironmentPicker
        environments={[
          { environmentId: 'a', label: 'Clemax', detail: '127.0.0.1:1', reachable: true },
          { environmentId: 'b', label: 'Clemax', detail: '127.0.0.1:2', reachable: false },
        ]}
        selectedId="a"
        onSelect={() => undefined}
      />,
    )
    await act(async () => trigger()!.click())
    const rows = [...document.querySelectorAll('[role="option"]')].map((row) => row.textContent)
    expect(rows[1]).toContain('127.0.0.1:2 · Not connected')
  })

  it('leaves the environment the page is on usable when it is not connected', async () => {
    await picker(vi.fn(), 'lab')
    expect(option('Lab')?.getAttribute('aria-disabled')).toBeNull()
  })

  it('does not open while a session is starting', async () => {
    await render(
      <EnvironmentPicker
        environments={ENVIRONMENTS}
        selectedId="desk"
        disabled
        onSelect={() => undefined}
      />,
    )
    expect(trigger()!.disabled).toBe(true)
  })
})

describe('NewSessionLandingView', () => {
  const picker = (
    <EnvironmentPicker environments={ENVIRONMENTS} selectedId="desk" onSelect={() => undefined} />
  )
  const landing = {
    environmentLabel: 'Desk',
    environmentPicker: picker,
    activeWorkspacePath: '/repo',
    isWorkspacesLoading: false,
    isStarting: false,
    onSelectWorkspace: () => undefined,
    onAddWorkspace: () => undefined,
  }

  it('shows the picker in place of the label', async () => {
    await render(
      <NewSessionLandingView {...landing} workspaces={[{ path: '/repo', name: 'repo' }]} />,
    )
    expect(trigger()).toBeTruthy()
    expect(container.textContent).not.toContain('Sessions run on')
  })

  it('is there while the workspace is still opening', async () => {
    await render(<NewSessionLandingView {...landing} workspaces={[]} isWorkspacesLoading />)
    expect(container.textContent).toContain('Opening your workspace')
    expect(trigger()).toBeTruthy()
  })

  it('still offers the way out of an environment with no projects', async () => {
    await render(<NewSessionLandingView {...landing} workspaces={[]} />)
    expect(container.textContent).toContain('Start with a project')
    expect(trigger()).toBeTruthy()
  })
})

describe('New agent in the sidebar', () => {
  const place = (environmentId: string, name: string, missing = false): SidebarWorkspace => ({
    path: `/${name}`,
    name,
    environmentId,
    missing,
    sessions: [],
  })
  const row = (reachable: boolean) => ({
    name: 'name',
    reachable,
    canSettle: false,
    canPin: false,
    iconLookup: null,
  })
  const view = async (
    workspaces: SidebarWorkspace[],
    laptopReachable = true,
    onCreateSession = vi.fn(),
  ) => {
    await render(
      <ThemeProvider>
        <SidebarProvider persist={false}>
          <WorkspaceSidebarView
            rowEnvironments={{ desk: row(true), laptop: row(laptopReachable) }}
            workspaces={workspaces}
            activeEnvironmentId="desk"
            activeWorkspacePath={null}
            activeSessionId={null}
            onCreateSession={onCreateSession}
            onSelectSession={() => undefined}
            onAddWorkspace={() => undefined}
          />
        </SidebarProvider>
      </ThemeProvider>,
    )
    const button = [...document.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('New agent'),
    )!
    return { button, onCreateSession }
  }

  it('starts in the open environment while it has somewhere to', async () => {
    const { button, onCreateSession } = await view([
      place('desk', 'desk-project'),
      place('laptop', 'laptop-project'),
    ])
    await act(async () => button.click())
    expect(onCreateSession).toHaveBeenCalledExactlyOnceWith('/desk-project', undefined)
  })

  it('passes over a project whose folder is gone, and says whose the next one is', async () => {
    const { button, onCreateSession } = await view([
      place('desk', 'gone', true),
      place('laptop', 'gone-too', true),
      place('laptop', 'laptop-project'),
    ])
    await act(async () => button.click())
    expect(onCreateSession).toHaveBeenCalledExactlyOnceWith('/laptop-project', 'laptop')
  })

  it('stays off when the only projects are on an environment out of reach', async () => {
    const { button } = await view([place('laptop', 'laptop-project')], false)
    expect(button.disabled).toBe(true)
  })
})

describe('starting a session', () => {
  const workspace: Workspace = {
    workspaceId: '/repo',
    name: 'repo',
    path: '/repo',
    lastUsedAt: null,
    lastActivityAt: null,
    exists: true,
    capabilities: { git: false },
  } as Workspace

  const mount = async (client: MockEnvironmentClient, environmentId: string) => {
    await render(
      <ThemeProvider>
        <EnvironmentClientProvider client={client}>
          <EnvironmentApplicationProviders environmentId={environmentId} onLanding>
            <SidebarProvider persist={false}>
              <ChatWorkspace />
            </SidebarProvider>
          </EnvironmentApplicationProviders>
        </EnvironmentClientProvider>
      </ThemeProvider>,
    )
    await act(() => client.settle())
  }

  const send = async () => {
    const box = container.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(box, 'Run this')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.getAttribute('aria-label') === 'Send')!
        .click(),
    )
  }

  const creates = (client: MockEnvironmentClient) =>
    client.calls.filter((call) => call.command === 'createSession')

  it('names the environment the page is on', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        environment: { environmentId: 'env-desk', name: 'Desk' },
        workspaces: [workspace],
      },
    })
    await mount(client, 'env-desk')
    await send()
    await act(() => client.settle())
    expect(creates(client)[0]?.input).toMatchObject({ environmentId: 'env-desk' })
  })

  it('refuses on a client that says it is another environment', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        environment: { environmentId: 'env-other', name: 'Other' },
        workspaces: [workspace],
      },
    })
    await mount(client, 'env-desk')
    await send()
    await act(() => client.settle())
    expect(creates(client)).toEqual([])
    expect(container.textContent).toContain('This page is on another environment now')
    expect(container.querySelector('textarea')!.value).toBe('Run this')
  })
})

describe('choosing from the page', () => {
  it('names the environment the page is on, not the one selected', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        environment: { environmentId: 'env-desk', name: 'Desk' },
        workspaces: [
          {
            workspaceId: '/repo',
            name: 'repo',
            path: '/repo',
            lastUsedAt: null,
            lastActivityAt: null,
            exists: true,
            capabilities: { git: false },
          } as Workspace,
        ],
      },
    })
    const choose = vi.fn<EnvironmentChoiceValue['choose']>(() => true)
    const choice: EnvironmentChoiceValue = {
      environments: [
        { environmentId: 'env-desk', label: 'Desk', reachable: true },
        { environmentId: 'env-laptop', label: 'Laptop', reachable: true },
      ],
      // The selection has moved on; this page has not.
      selectedId: 'env-laptop',
      choose,
      opening: null,
      opened: () => undefined,
    }
    await render(
      <ThemeProvider>
        <EnvironmentClientProvider client={client}>
          <EnvironmentChoiceContext.Provider value={choice}>
            <EnvironmentApplicationProviders onLanding>
              <SidebarProvider persist={false}>
                <ChatWorkspace />
              </SidebarProvider>
            </EnvironmentApplicationProviders>
          </EnvironmentChoiceContext.Provider>
        </EnvironmentClientProvider>
      </ThemeProvider>,
    )
    await act(() => client.settle())
    expect(trigger()!.textContent).toContain('Desk')
    await act(async () => trigger()!.click())
    await act(async () => option('Laptop')!.click())

    expect(choose).toHaveBeenCalledTimes(1)
    const [to, from] = choose.mock.calls[0]!
    expect(to).toBe('env-laptop')
    expect(from).toMatchObject({ environmentId: 'env-desk', draftId: expect.any(String) })
  })
})
