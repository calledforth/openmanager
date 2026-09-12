// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
  type MockSeed,
} from '@openmanager/environment-client'
import { MockEnvironmentApp } from '../src/testing/mock-environment-app'

const WORKSPACE = { workspaceId: 'C:/repo', name: 'repo' }
const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: 'First' }
const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }

/** A session with one settled turn, so opening it shows a mocked history. */
const SEEDED_HISTORY: MockSeed = {
  workspaces: [WORKSPACE],
  sessions: [
    {
      session: SESSION,
      threads: [THREAD],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' }],
      messages: [
        {
          messageId: 'user-1',
          threadId: THREAD.threadId,
          turnId: 'turn-1',
          role: 'user',
          content: [{ type: 'text', text: 'What changed?' }],
        },
        {
          messageId: 'assistant-1',
          threadId: THREAD.threadId,
          turnId: 'turn-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Two files were edited.' }],
        },
      ],
    },
  ],
}

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
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  globalThis.localStorage?.clear()
  vi.unstubAllGlobals()
})
const render = (node: ReactNode) => act(() => root.render(node))
/** Drain the mock, then yield so a command chained after the last one gets
 * scheduled, and drain again; a draft send is three commands deep. */
const settle = async (client: MockEnvironmentClient) => {
  for (let round = 0; round < 6; round += 1) {
    await act(() => client.settle())
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

function App({ client, addWorkspace }: { client: MockEnvironmentClient; addWorkspace?: () => Promise<void> }) {
  return <MockEnvironmentApp client={client} addWorkspace={addWorkspace} />
}

const occurrences = (text: string) => (container.textContent?.split(text).length ?? 1) - 1

const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const buttonWithText = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    node.textContent?.includes(text),
  )
const type = async (text: string) => {
  const textarea = container.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the shared application over the environment client', () => {
  it('renders the sidebar, the empty-chat landing and a disabled composer', async () => {
    const client = createMockEnvironmentClient({ seed: SEEDED_HISTORY })
    await render(<App client={client} />)
    expect(container.textContent).toContain('repo')
    expect(container.textContent).toContain('First')
    // No session and no draft: the landing invites a workspace pick.
    expect(container.textContent).toContain("Let's build in")
    expect(container.querySelector('textarea')?.disabled).toBe(true)
  })

  it('opens a session from the sidebar and shows its mocked message list', async () => {
    const client = createMockEnvironmentClient({ seed: SEEDED_HISTORY })
    await render(<App client={client} />)
    await act(() => buttonWithText('First')!.click())
    await settle(client)
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    expect(container.textContent).toContain('What changed?')
    expect(container.textContent).toContain('Two files were edited.')
    expect(container.querySelector('textarea')?.disabled).toBe(false)
  })

  it('starts a session from a draft and streams the reply through the composer', async () => {
    const client = createMockEnvironmentClient({ seed: { workspaces: [WORKSPACE] } })
    await render(<App client={client} />)
    await act(() => button('New Agent')!.click())
    expect(container.textContent).toContain('Start with a message below')
    expect(container.querySelector('textarea')?.disabled).toBe(false)

    await type('hello there')
    await act(() => button('Send')!.click())
    await settle(client)

    const commands = client.calls.map((call) => call.command)
    expect(commands).toEqual(expect.arrayContaining(['createSession', 'openSession', 'sendTurn']))
    expect(client.getState().activeSessionId).not.toBeNull()
    expect(container.textContent).toContain('hello there')
    expect(container.textContent).toContain('You said: hello there')
    expect(button('Stop')).toBeNull()
  })

  it('shows Stop while a turn runs and interrupts it through the client', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
      respond: () => null,
    })
    await render(<App client={client} />)
    await type('slow')
    await act(() => button('Send')!.click())
    await settle(client)
    expect(button('Stop')).not.toBeNull()
    await act(() => button('Stop')!.click())
    await settle(client)
    expect(button('Stop')).toBeNull()
    expect(client.getState().threads[THREAD.threadId]?.turns.at(-1)?.state).toBe('interrupted')
  })

  it('answers a permission request from the fallback card', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
      respond: () => null,
    })
    await render(<App client={client} />)
    const { turn } = await act(() => client.commands.sendTurn({ ...THREAD, text: 'run tests' }))
    await act(() =>
      client.requestInteraction(
        { ...THREAD, turnId: turn.turnId },
        {
          kind: 'permission',
          interactionId: 'perm-1',
          toolCall: { toolCallId: 'tool-1', title: 'pnpm test' },
          options: [
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          ],
        },
      ),
    )
    expect(container.textContent).toContain('pnpm test')
    await act(() => buttonWithText('Allow')!.click())
    await settle(client)
    const response = client.calls.find((call) => call.command === 'respondToInteraction')
    expect(response?.input).toMatchObject({
      response: { kind: 'permission', interactionId: 'perm-1', outcome: { optionId: 'allow' } },
    })
    expect(client.getState().threads[THREAD.threadId]?.interactions).toEqual([])
  })

  it('shows a pending question in the composer and a plan review chip', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
      respond: () => null,
    })
    await render(<App client={client} />)
    const { turn } = await act(() => client.commands.sendTurn({ ...THREAD, text: 'decide' }))
    const target = { ...THREAD, turnId: turn.turnId }
    await act(() =>
      client.requestInteraction(target, {
        kind: 'question',
        interactionId: 'q-1',
        questions: [
          {
            questionId: 'framework',
            prompt: 'Which framework?',
            options: [{ optionId: 'react', label: 'React' }],
          },
        ],
      }),
    )
    expect(container.textContent).toContain('Which framework?')

    await act(() =>
      client.commands.respondToInteraction({
        ...THREAD,
        response: {
          kind: 'question',
          interactionId: 'q-1',
          outcome: { outcome: 'answered', answers: [{ questionId: 'framework', selectedOptionIds: ['react'] }] },
        },
      }),
    )
    await settle(client)
    await act(() =>
      client.requestInteraction(target, {
        kind: 'plan',
        interactionId: 'plan-1',
        name: 'Migrate the sidebar',
        markdown: 'Move it.',
        todos: [{ id: 'todo-1', content: 'Move the sidebar', status: 'pending' }],
        continuation: 'follow_up_turn',
      }),
    )
    expect(container.textContent).toContain('Migrate the sidebar')
    await act(() => buttonWithText('Build')!.click())
    await settle(client)
    const accepted = client.calls.filter((call) => call.command === 'respondToInteraction').at(-1)
    expect(accepted?.input).toMatchObject({
      response: { kind: 'plan', interactionId: 'plan-1', outcome: { outcome: 'accepted' } },
    })
  })

  it('echoes the sent prompt before any assistant tokens arrive', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
      respond: () => null,
    })
    await render(<App client={client} />)
    await type('echo me')
    await act(() => button('Send')!.click())
    await settle(client)
    expect(container.textContent).toContain('echo me')
    expect(occurrences('echo me')).toBe(1)
    expect(container.textContent).not.toContain('You said:')
    expect(client.getState().threads[THREAD.threadId]?.messages).toHaveLength(3)
  })

  it('appends streamed tokens onto one assistant message', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
      respond: () => null,
    })
    await render(<App client={client} />)
    const { turn } = await act(() => client.commands.sendTurn({ ...THREAD, text: 'stream me' }))
    await settle(client)
    expect(container.textContent).toContain('stream me')
    expect(container.textContent).not.toContain('Tokens')

    const target = { ...THREAD, turnId: turn.turnId }
    await act(() => {
      client.streamAssistantText(target, 'Tok', 'assistant-stream')
    })
    expect(container.textContent).toContain('Tok')
    expect(container.textContent).not.toContain('Tokens')

    await act(() => {
      client.streamAssistantText(target, 'ens', 'assistant-stream')
    })
    expect(container.textContent).toContain('Tokens')
    expect(occurrences('Tokens')).toBe(1)
    expect(client.getState().threads[THREAD.threadId]?.messages.filter((message) => message.role === 'assistant')).toHaveLength(2)
  })

  it('reconnects without duplicating the open session transcript', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
    })
    await render(<App client={client} />)
    expect(occurrences('What changed?')).toBe(1)
    expect(occurrences('Two files were edited.')).toBe(1)

    await act(() => client.reconnect())
    expect(client.getState().connection.phase).toBe('connected')
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    expect(occurrences('What changed?')).toBe(1)
    expect(occurrences('Two files were edited.')).toBe(1)
    expect(container.querySelectorAll('[data-chat-view]').length).toBe(1)

    await act(() =>
      client.emit({
        type: 'event',
        eventId: 'replay-started',
        timestamp: '2026-09-12T00:00:00.000Z',
        name: 'turn.started',
        scope: {
          type: 'thread',
          environmentId: 'mock-environment',
          sessionId: SESSION.sessionId,
          threadId: THREAD.threadId,
        },
        payload: {
          turn: { turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' },
          userMessage: {
            messageId: 'user-1',
            threadId: THREAD.threadId,
            turnId: 'turn-1',
            role: 'user',
            content: [{ type: 'text', text: 'What changed?' }],
          },
        },
      }),
    )
    expect(occurrences('What changed?')).toBe(1)
    expect(client.getState().threads[THREAD.threadId]?.messages).toHaveLength(2)
  })

  it('routes Add project through the host callback', async () => {
    const addWorkspace = vi.fn(async () => undefined)
    const client = createMockEnvironmentClient()
    await render(<App client={client} addWorkspace={addWorkspace} />)
    await act(() => button('Add project')!.click())
    expect(addWorkspace).toHaveBeenCalledOnce()
  })
})
