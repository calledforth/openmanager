// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { SidebarProvider } from '../src/components/fluid/ui/sidebar'
import { WorkspaceSidebarView } from '../src/components/sidebar/WorkspaceSidebarView'
import type { SidebarWorkspace } from '../src/components/sidebar/sidebar-sessions'
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

const WORKSPACE: SidebarWorkspace = {
  path: '/repo',
  name: 'repo',
  sessions: [{ externalId: 's1', title: 'Finished work', status: 'idle' }],
}

/** Stands in for the environment: the change lands once `settle` resolves. */
function Host({ settle }: { settle: (settled: boolean) => Promise<void> }) {
  const [workspaces, setWorkspaces] = useState([WORKSPACE])
  return (
    <ThemeProvider>
      <SidebarProvider persist={false}>
        <WorkspaceSidebarView
          workspaces={workspaces}
          activeWorkspacePath="/repo"
          activeSessionId={null}
          onCreateSession={() => undefined}
          onSelectSession={() => undefined}
          onAddWorkspace={() => undefined}
          onSettleSession={(_path, id, settled) =>
            settle(settled).then(() =>
              setWorkspaces((current) =>
                current.map((workspace) => ({
                  ...workspace,
                  sessions: workspace.sessions.map((session) =>
                    session.externalId === id
                      ? { ...session, settledAt: settled ? new Date().toISOString() : null }
                      : session,
                  ),
                })),
              ),
            )
          }
        />
      </SidebarProvider>
    </ThemeProvider>
  )
}

const activeList = () => container.querySelector('[role="list"]')!
const settledRow = () =>
  [...container.querySelectorAll('li')].find((row) => row.textContent?.includes('Finished work'))

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('settling from the sidebar', () => {
  it('moves the row on the click, before the environment answers', async () => {
    const answer = deferred()
    await act(() => root.render(<Host settle={() => answer.promise} />))
    const settleButton = container.querySelector<HTMLButtonElement>('[aria-label="Settle"]')!

    await act(() => settleButton.click())
    expect(activeList().textContent).not.toContain('Finished work')
    expect(settledRow()).toBeDefined()

    await act(async () => answer.resolve())
    expect(activeList().textContent).not.toContain('Finished work')
    expect(settledRow()).toBeDefined()
  })

  it('moves the row back when the environment refuses', async () => {
    const answer = deferred()
    await act(() => root.render(<Host settle={() => answer.promise} />))

    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Settle"]')!.click())
    expect(settledRow()).toBeDefined()

    await act(async () => answer.reject(new Error('conflict')))
    expect(activeList().textContent).toContain('Finished work')
    expect(settledRow()).toBeUndefined()
  })
})
