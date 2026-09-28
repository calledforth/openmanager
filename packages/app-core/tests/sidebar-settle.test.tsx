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
import { useActiveThreadState } from '../src/providers/active-thread-provider'
import { useComposerState } from '../src/providers/composer-provider'
import { EnvironmentApplicationProviders } from '../src/providers/environment-application'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import { useSessionState } from '../src/providers/session-provider'
import { useSidebarData } from '../src/providers/sidebar-provider'
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
  // jsdom never finishes the rows' fold, so a row that left would linger.
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
const SESSION = {
  sessionId: 'session-1',
  workspaceId: WORKSPACE.workspaceId,
  title: 'Finished work',
}
const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }

/** Counts renders of whatever reads each contract outside the sidebar. */
const renders = { session: 0, catalog: 0, thread: 0, composer: 0 }
function SessionReader() {
  useSessionState()
  renders.session += 1
  return null
}
function CatalogReader() {
  useSidebarData()
  renders.catalog += 1
  return null
}
function ThreadReader() {
  useActiveThreadState()
  renders.thread += 1
  return null
}
function ComposerReader() {
  useComposerState()
  renders.composer += 1
  return null
}

function App({ client }: { client: MockEnvironmentClient }) {
  return (
    <ThemeProvider>
      <EnvironmentClientProvider client={client}>
        <EnvironmentApplicationProviders collapsedWorkspaceStorage={null}>
          <SidebarProvider persist={false}>
            <WorkspaceSidebar />
            <SessionReader />
            <CatalogReader />
            <ThreadReader />
            <ComposerReader />
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

const activeList = () => container.querySelector('[role="list"]')!
const settledRow = () =>
  [...container.querySelectorAll('li')].find((row) => row.textContent?.includes('Finished work'))

async function mount() {
  const client = createMockEnvironmentClient({
    seed: { workspaces: [WORKSPACE], sessions: [{ session: SESSION, threads: [THREAD] }] },
    latencyMs: 20,
  })
  await act(() => root.render(<App client={client} />))
  await drain(client)
  return client
}

describe('settling from the sidebar', () => {
  it('moves the row on the click, before the environment answers', async () => {
    const client = await mount()
    expect(activeList().textContent).toContain('Finished work')

    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Settle"]')!.click())
    expect(activeList().textContent).not.toContain('Finished work')
    expect(settledRow()).toBeDefined()

    await drain(client)
    expect(client.getState().sessions[SESSION.sessionId]?.settledAt).toEqual(expect.any(String))
    expect(activeList().textContent).not.toContain('Finished work')
    expect(settledRow()).toBeDefined()

    await act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Move back to active"]')!.click(),
    )
    expect(activeList().textContent).toContain('Finished work')
    await drain(client)
    expect(client.getState().sessions[SESSION.sessionId]?.settledAt).toBeNull()
  })

  it('renders nothing outside the sidebar, even for the session on screen', async () => {
    const client = await mount()
    await act(() => client.commands.openSession(SESSION.sessionId))
    await drain(client)
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)

    Object.assign(renders, { session: 0, catalog: 0, thread: 0, composer: 0 })
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Settle"]')!.click())
    await drain(client)
    expect(settledRow()).toBeDefined()
    expect(renders).toEqual({ session: 0, catalog: 0, thread: 0, composer: 0 })
  })
})
