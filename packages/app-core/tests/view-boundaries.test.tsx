// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ViewActionsContext } from '../src/providers/view-actions'
import { PermissionStateContext } from '../src/providers/permission-provider'
import { ToolCallPermission } from '../src/components/permissions/InlinePermissionPrompt'
import { SubtaskCard } from '../src/components/parts/SubtaskCard'
import { ProjectIcon } from '../src/components/sidebar/ProjectIcon'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render(node: ReactNode) {
  await act(() => root.render(node))
}

describe('host supplied actions', () => {
  it('navigates child transcripts and displays host errors without Electron globals', async () => {
    const openChildSession = vi.fn().mockRejectedValue(new Error('Session unavailable'))
    await render(
      <ViewActionsContext.Provider value={{ activeSessionId: 'parent', openChildSession }}>
        <SubtaskCard part={{ type: 'subtask', id: 'task', targetSessionId: 'child' }} />
      </ViewActionsContext.Provider>,
    )
    await act(() => container.querySelector('button')!.click())
    expect(openChildSession).toHaveBeenCalledWith('child', 'parent')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Session unavailable')
    await render(<SubtaskCard part={{ type: 'subtask', id: 'task', targetSessionId: 'child' }} />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('claims, resolves, and releases the existing permission context', async () => {
    const release = vi.fn()
    const claimPermission = vi.fn(() => release)
    const resolvePermission = vi.fn().mockResolvedValue(undefined)
    await render(
      <PermissionStateContext.Provider
        value={{
          activeSessionId: 'session',
          isPermissionClaimed: false,
          claimPermission,
          resolvePermission,
          pendingPermission: {
            requestId: 'request',
            toolCallId: 'tool',
            toolName: 'Bash',
            description: 'Run command',
            createdAt: 1,
            updatedAt: 1,
            options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
          },
        }}
      >
        <ToolCallPermission callID="tool" />
      </PermissionStateContext.Provider>,
    )
    expect(claimPermission).toHaveBeenCalledWith('request')
    await act(() => container.querySelector('button')!.click())
    expect(resolvePermission).toHaveBeenCalledWith({ optionId: 'allow' })
    await render(null)
    expect(release).toHaveBeenCalledOnce()
  })

  it('ignores stale icon results when the host workspace changes', async () => {
    let resolveOld!: (value: string) => void
    const old = new Promise<string>((resolve) => {
      resolveOld = resolve
    })
    const resolveWorkspaceIcon = vi.fn((path: string) =>
      path === 'old' ? old : Promise.resolve('data:image/png;base64,new'),
    )
    const view = (path: string) => (
      <ViewActionsContext.Provider value={{ activeSessionId: null, resolveWorkspaceIcon }}>
        <ProjectIcon workspacePath={path} />
      </ViewActionsContext.Provider>
    )
    await render(view('old'))
    await render(view('new'))
    await act(() => resolveOld('data:image/png;base64,old'))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,new')
    await render(null)
    await render(view('new'))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,new')
    expect(resolveWorkspaceIcon).toHaveBeenCalledTimes(2)
    await render(<ProjectIcon workspacePath="browser-only" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
