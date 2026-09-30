// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMockEnvironmentClient,
  type BackgroundTask,
  type MockEnvironmentClient,
} from '@openmanager/environment-client'
import {
  BackgroundTasksPill,
  SessionBackgroundTasks,
} from '../src/components/chat/BackgroundTasksPill'
import { AssistantMessage } from '../src/components/chat/ChatViewPrimitives'
import { EnvironmentClientProvider } from '../src/providers/environment-client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as unknown as typeof window.matchMedia
// Motion measures the opening list with it; jsdom only logs that it cannot.
window.scrollTo = () => undefined

const BUILD: BackgroundTask = { taskId: 'task-1', kind: 'shell', description: 'pnpm build' }
const REVIEW: BackgroundTask = { taskId: 'task-2', kind: 'agent', description: 'Review the diff' }

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
})

function mount(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(node))
  return host
}
const button = (name: string | RegExp) =>
  [...host!.querySelectorAll('button')].find((item) => {
    const label = item.getAttribute('aria-label') ?? item.textContent ?? ''
    return typeof name === 'string' ? label === name : name.test(label)
  })
const click = async (target: HTMLElement | undefined) => {
  expect(target).toBeDefined()
  await act(async () => {
    target!.click()
    await Promise.resolve()
  })
}

describe('BackgroundTasksPill', () => {
  it('shows nothing when no work is running', () => {
    expect(mount(<BackgroundTasksPill tasks={[]} onStop={vi.fn()} />).textContent).toBe('')
  })

  it('names a single task and stops it, holding "Stopping…" until the task is gone', async () => {
    const onStop = vi.fn().mockResolvedValue(undefined)
    mount(<BackgroundTasksPill tasks={[BUILD]} onStop={onStop} />)
    expect(host!.textContent).toContain('pnpm build')

    await click(button('Stop'))
    expect(onStop).toHaveBeenCalledWith(undefined)
    // The command settling only means the provider was asked.
    expect(button('Stopping…')?.disabled).toBe(true)

    act(() => root!.render(<BackgroundTasksPill tasks={[]} onStop={onStop} />))
    expect(host!.textContent).toBe('')
  })

  it('falls back to what kind of task it is when the provider describes nothing', () => {
    mount(<BackgroundTasksPill tasks={[{ ...REVIEW, description: '  ' }]} onStop={vi.fn()} />)
    expect(host!.textContent).toContain('Background agent')
  })

  it('collapses several tasks to a count that opens the list, each stoppable by itself', async () => {
    const onStop = vi.fn().mockResolvedValue(undefined)
    mount(<BackgroundTasksPill tasks={[BUILD, REVIEW]} onStop={onStop} />)
    expect(host!.textContent).toContain('2 background tasks')
    expect(host!.textContent).not.toContain('pnpm build')

    await click(button(/2 background tasks/))
    expect(host!.textContent).toContain('pnpm build')
    expect(host!.textContent).toContain('Review the diff')

    await click(button('Stop Review the diff'))
    expect(onStop).toHaveBeenLastCalledWith(['task-2'])
    // Only that row is pending; the other task can still be stopped.
    expect(button('Stop pnpm build')?.disabled).toBe(false)
    expect(button('Stop all')?.disabled).toBe(false)

    await click(button('Stop all'))
    expect(onStop).toHaveBeenLastCalledWith(undefined)
    expect(button('Stopping…')).toBeDefined()
  })

  it('says so and offers Stop again when the environment refuses', async () => {
    const onStop = vi.fn().mockRejectedValue(new Error('unavailable'))
    mount(<BackgroundTasksPill tasks={[BUILD]} onStop={onStop} />)

    await click(button('Stop'))

    expect(host!.querySelector('[role=alert]')?.textContent).toBe('Couldn’t stop')
    expect(button('Stop')?.disabled).toBe(false)
  })
})

describe('SessionBackgroundTasks', () => {
  const WORKSPACE = {
    workspaceId: 'C:/repo',
    name: 'repo',
    path: 'C:/repo',
    lastUsedAt: null,
    lastActivityAt: null,
    capabilities: { git: false, providers: ['claude'] },
    exists: true,
  }
  const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: null }
  const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }

  const report = (client: MockEnvironmentClient, tasks: BackgroundTask[]) =>
    act(() =>
      client.emit({
        type: 'event',
        eventId: `roster-${tasks.length}-${Math.random()}`,
        timestamp: '2026-09-30T10:00:00.000Z',
        name: 'session.updated',
        scope: { type: 'environment', environmentId: client.getState().environment!.environmentId },
        payload: { sessionId: SESSION.sessionId, backgroundTasks: tasks, status: 'running' },
      }),
    )

  it('shows the active session’s background work and stops it through the environment', async () => {
    const client = createMockEnvironmentClient({
      seed: { workspaces: [WORKSPACE], sessions: [{ session: SESSION, threads: [THREAD] }] },
    })
    await client.commands.openSession(SESSION.sessionId)
    mount(
      <EnvironmentClientProvider client={client}>
        <SessionBackgroundTasks />
      </EnvironmentClientProvider>,
    )
    expect(host!.textContent).toBe('')

    report(client, [BUILD])
    expect(host!.textContent).toContain('pnpm build')

    await click(button('Stop'))
    await act(async () => {
      await client.settle()
    })
    expect(client.calls.at(-1)).toEqual({
      command: 'stopBackgroundTasks',
      input: { sessionId: SESSION.sessionId },
    })
    expect(host!.textContent).toBe('')
  })

  it('renders nothing on a host with no environment', () => {
    expect(mount(<SessionBackgroundTasks />).textContent).toBe('')
  })
})

describe('an unprompted turn in the transcript', () => {
  it('is introduced where the user message would have been', () => {
    mount(
      <AssistantMessage
        content="The build passed."
        isFinal
        parts={[{ type: 'text', id: 'a1', text: 'The build passed.' }]}
        runtime={{ unprompted: true }}
      />,
    )
    expect(host!.textContent).toContain('Resumed after background work')
    expect(host!.textContent).toContain('The build passed.')
  })

  it('leaves an ordinary answer unlabelled', () => {
    mount(
      <AssistantMessage
        content="Hello."
        isFinal
        parts={[{ type: 'text', id: 'a1', text: 'Hello.' }]}
      />,
    )
    expect(host!.textContent).not.toContain('Resumed after background work')
  })
})
