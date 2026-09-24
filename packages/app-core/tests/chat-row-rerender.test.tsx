// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMockEnvironmentClient, type MockSeed } from '@openmanager/environment-client'

/**
 * Row components replaced by counting stubs. A settled row re-rendering is
 * exactly a `UserMessage` / `AssistantMessage` call with unchanged inputs, so
 * these counters measure the per-token cascade this timeline must not have.
 */
const renders = { user: [] as string[], assistant: [] as string[] }
vi.mock('../src/components/chat/ChatViewPrimitives', () => ({
  ChatViewPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ChatLoadingSkeleton: () => <div role="status" aria-label="Loading conversation" />,
  UserMessage: ({ content }: { content: string }) => {
    renders.user.push(content)
    return <div data-role="user">{content}</div>
  },
  AssistantMessage: ({ content }: { content: string }) => {
    renders.assistant.push(content)
    return <div data-role="assistant">{content}</div>
  },
}))

const { MockEnvironmentApp } = await import('../src/testing/mock-environment-app')

const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false, providers: ['opencode'] },
  exists: true,
}
const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: 'First' }
const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }

const SEED: MockSeed = {
  workspaces: [WORKSPACE],
  activeSessionId: SESSION.sessionId,
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
  renders.user = []
  renders.assistant = []
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

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

describe('chat timeline re-renders', () => {
  it('leaves settled rows alone while an assistant turn streams', async () => {
    const client = createMockEnvironmentClient({ seed: SEED, respond: () => null })
    await act(() => root.render(<MockEnvironmentApp client={client} />))
    for (let round = 0; round < 6; round += 1) await flush()

    await act(() => client.commands.sendTurn({ ...THREAD, text: 'and now?' }))
    for (let round = 0; round < 6; round += 1) await flush()
    const turnId = client.getState().threads[THREAD.threadId]!.turns.at(-1)!.turnId

    const settledUserRenders = renders.user.filter((text) => text === 'What changed?').length
    const promptRenders = renders.user.filter((text) => text === 'and now?').length

    // Two tokens of one text run share a message id, as a server's deltas do.
    let messageId = ''
    await act(() => {
      messageId = client.streamAssistantText({ ...THREAD, turnId }, 'one ')
    })
    await flush()
    await act(() => {
      client.streamAssistantText({ ...THREAD, turnId }, 'two ', messageId)
    })
    await flush()

    // Two tokens arrived. Neither the settled user message nor the prompt that
    // started this turn changed, so neither row may have been rendered again.
    expect(renders.user.filter((text) => text === 'What changed?').length).toBe(settledUserRenders)
    expect(renders.user.filter((text) => text === 'and now?').length).toBe(promptRenders)
    expect(renders.assistant.at(-1)).toContain('one two ')
  })
})
