// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
} from '@openmanager/environment-client'
import { SidebarProvider } from '../src/components/fluid/ui/sidebar'
import { WorkspaceSidebar } from '../src/components/sidebar/WorkspaceSidebar'
import { WorkspaceSidebarView } from '../src/components/sidebar/WorkspaceSidebarView'
import { EnvironmentApplicationProviders } from '../src/providers/environment-application'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
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

const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false },
  exists: true,
}
const TITLES = ['first', 'second', 'third']
const seedSession = (title: string) => ({
  session: { sessionId: title, workspaceId: WORKSPACE.workspaceId, title },
  threads: [{ threadId: `thread-${title}`, sessionId: title }],
})

function App({ client }: { client: MockEnvironmentClient }) {
  return (
    <ThemeProvider>
      <EnvironmentClientProvider client={client}>
        <EnvironmentApplicationProviders>
          <SidebarProvider persist={false}>
            <WorkspaceSidebar />
          </SidebarProvider>
        </EnvironmentApplicationProviders>
      </EnvironmentClientProvider>
    </ThemeProvider>
  )
}

const drain = async (client: MockEnvironmentClient) => {
  for (let round = 0; round < 4; round += 1) {
    await act(() => client.settle())
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

async function mount(options: { turnsStayOpen?: boolean } = {}) {
  const client = createMockEnvironmentClient({
    seed: { workspaces: [WORKSPACE], sessions: TITLES.map(seedSession) },
    latencyMs: 20,
    ...(options.turnsStayOpen ? { respond: () => null } : {}),
  })
  await act(() => root.render(<App client={client} />))
  await drain(client)
  return client
}

const cards = () => [...container.querySelectorAll<HTMLElement>('[role="listitem"]')]
const titles = () =>
  cards().map((card) => TITLES.find((title) => card.textContent?.includes(title)))
const button = (title: string, label: string) =>
  cards()
    .find((card) => card.textContent?.includes(title))
    ?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? null
const click = (element: HTMLElement | null, detail = 1) =>
  act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }))
  })

describe('pinning from the sidebar', () => {
  it('moves the card on the click, before the environment answers, and back on unpin', async () => {
    const client = await mount()
    const before = titles()
    const last = before.at(-1)!

    await click(button(last, 'Pin to top'))
    expect(titles()[0]).toBe(last)
    expect(client.getState().sessions[last]?.pinnedAt).toEqual(expect.any(String))

    await drain(client)
    expect(titles()[0]).toBe(last)

    await click(button(last, 'Unpin'))
    expect(titles()).toEqual(before)
    await drain(client)
    expect(client.getState().sessions[last]?.pinnedAt).toBeNull()
  })

  it('offers the pin on live work, which cannot be settled', async () => {
    const client = await mount({ turnsStayOpen: true })
    const last = titles().at(-1)!
    await act(() =>
      client.commands.sendTurn({ threadId: `thread-${last}`, sessionId: last, text: 'go' }),
    )
    await drain(client)
    expect(client.getState().sessions[last]?.status).toBe('running')
    expect(button(last, 'Settle')).toBeNull()

    await click(button(last, 'Pin to top'))
    await drain(client)
    expect(titles()[0]).toBe(last)
  })

  it('shows a pin made on another client', async () => {
    const client = await mount()
    const last = titles().at(-1)!
    await act(() => client.commands.pinSession(last, true))
    await drain(client)
    expect(titles()[0]).toBe(last)
    expect(button(last, 'Unpin')).not.toBeNull()
  })

  it('puts the newest pin on top', async () => {
    const client = await mount()
    const [first, second] = titles()
    await click(button(second!, 'Pin to top'))
    await drain(client)
    // Pinned a moment later than the mock's clock can tell apart otherwise.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await click(button(first!, 'Pin to top'))
    await drain(client)
    expect(titles().slice(0, 2)).toEqual([first, second])
  })

  it('ignores the second half of a double click', async () => {
    const client = await mount()
    const [top, under] = titles()
    await click(button(under!, 'Pin to top'))
    await click(button(top!, 'Pin to top'), 2)
    await drain(client)
    expect(client.getState().sessions[top!]?.pinnedAt ?? null).toBeNull()
  })
})

describe('a host that cannot keep pins', () => {
  it('keeps the card pinned and shows the mark, with no button', async () => {
    const workspace = {
      path: '/repo',
      name: 'repo',
      sessions: [
        {
          externalId: 'newer',
          title: 'newer',
          status: 'ready',
          providerId: 'opencode' as const,
          updatedAt: '2026-09-24T10:30:00Z',
        },
        {
          externalId: 'older',
          title: 'older',
          status: 'ready',
          providerId: 'opencode' as const,
          updatedAt: '2026-09-24T10:00:00Z',
          pinnedAt: '2026-09-24T10:10:00Z',
        },
      ],
    }
    await act(async () =>
      root.render(
        <ThemeProvider>
          <SidebarProvider persist={false}>
            <WorkspaceSidebarView
              workspaces={[workspace]}
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
    expect(cards()[0]?.textContent).toContain('older')
    expect(cards()[0]?.textContent).toContain('Pinned')
    expect(container.querySelector('button[aria-label="Unpin"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Pin to top"]')).toBeNull()
  })
})

describe('a sidebar with one environment', () => {
  it('reads no environment name out on its cards', async () => {
    await mount()
    expect(cards().length).toBeGreaterThan(0)
    for (const card of cards()) expect(card.textContent).not.toContain('on Mock environment')
  })
})
