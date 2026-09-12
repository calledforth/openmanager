import { describe, expect, it } from 'vitest'
import { createMockEnvironmentClient, createThreadState } from '@openmanager/environment-client'
import { contentText, createEnvironmentThreadStores, projectThread } from './environment-thread'

const THREAD = { threadId: 'thread-1', sessionId: 'session-1' }

function thread(patch: Partial<ReturnType<typeof createThreadState>> = {}) {
  return { ...createThreadState(THREAD, 'ready'), ...patch }
}

describe('projectThread', () => {
  it('renders one user row and one assistant row per turn, in turn order', () => {
    const state = thread({
      turns: [
        { turnId: 't1', threadId: THREAD.threadId, state: 'completed' },
        { turnId: 't2', threadId: THREAD.threadId, state: 'running' },
      ],
      messages: [
        { messageId: 'u1', threadId: THREAD.threadId, turnId: 't1', role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { messageId: 'a1', threadId: THREAD.threadId, turnId: 't1', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { messageId: 'u2', threadId: THREAD.threadId, turnId: 't2', role: 'user', content: [{ type: 'text', text: 'more' }] },
      ],
    })
    const projection = projectThread(state)
    expect(projection.messages.map((message) => [message.externalId, message.role, message.isFinal])).toEqual([
      ['u1', 'user', true],
      ['a1', 'assistant', true],
      ['u2', 'user', true],
      ['turn:t2:assistant', 'assistant', false],
    ])
    expect(projection.messages.map((message) => message.sequenceNum)).toEqual([0, 1, 2, 3])
    expect(projection.byId.get('a1')?.content).toEqual({
      content: 'hello',
      parts: [{ type: 'text', id: 'a1', text: 'hello' }],
    })
  })

  it('orders an assistant row as reasoning, tools, then text and maps tool status', () => {
    const state = thread({
      turns: [{ turnId: 't1', threadId: THREAD.threadId, state: 'running' }],
      messages: [
        { messageId: 'a1', threadId: THREAD.threadId, turnId: 't1', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
      reasoning: [
        { messageId: 'r1', turnId: 't1', phase: 'stop', content: [{ type: 'text', text: 'think' }], tokens: 12 },
      ],
      tools: [{ toolCallId: 'tool-1', turnId: 't1', title: 'pnpm test', kind: 'execute', status: 'in_progress' }],
    })
    const row = projectThread(state).byId.get('a1')!
    expect(row.streaming.parts.map((part) => part.type)).toEqual(['reasoning', 'tool', 'text'])
    expect(row.streaming.parts[0]).toMatchObject({ text: 'think', tokens: 12, time: { end: 0 } })
    expect(row.streaming.parts[1]).toMatchObject({
      id: 'tool-1',
      callID: 'tool-1',
      tool: 'pnpm test',
      state: { status: 'running' },
    })
    expect(row.message.isFinal).toBe(false)
  })

  it('keeps row identity for turns whose inputs did not change', () => {
    const settled = thread({
      turns: [{ turnId: 't1', threadId: THREAD.threadId, state: 'completed' }],
      messages: [
        { messageId: 'a1', threadId: THREAD.threadId, turnId: 't1', role: 'assistant', content: [{ type: 'text', text: 'old' }] },
      ],
    })
    const first = projectThread(settled)
    const grown = thread({
      ...settled,
      turns: [...settled.turns, { turnId: 't2', threadId: THREAD.threadId, state: 'running' }],
      messages: [
        ...settled.messages,
        { messageId: 'a2', threadId: THREAD.threadId, turnId: 't2', role: 'assistant', content: [{ type: 'text', text: 'n' }] },
      ],
    })
    const second = projectThread(grown, first)
    expect(second.byId.get('a1')).toBe(first.byId.get('a1'))
    expect(second.messages[0]).toBe(first.messages[0])
    expect(second.messages).toHaveLength(2)
    expect(projectThread(grown, second)).toBe(second)
    expect(projectThread(null, second).messages).toEqual([])
  })

  it('surfaces a failed turn on its assistant row', () => {
    const state = thread({
      turns: [{ turnId: 't1', threadId: THREAD.threadId, state: 'failed' }],
      failures: [{ turnId: 't1', reason: 'provider_error', message: 'boom' }],
    })
    const row = projectThread(state).byId.get('turn:t1:assistant')!
    expect(row.message.isFinal).toBe(true)
    expect(row.content.content).toBe('')
    expect(row.content.parts?.[0]).toMatchObject({ type: 'text', text: 'Turn failed: boom' })
  })

  it('keeps URI-only resource blocks in the projected text', () => {
    expect(
      contentText([
        { type: 'text', text: 'see ' },
        { type: 'resource_link', uri: 'file:///a.ts' },
        { type: 'resource', uri: 'file:///b.ts' },
        { type: 'resource', uri: 'file:///c.ts', text: ' inline' },
      ]),
    ).toBe('see file:///a.tsfile:///b.ts inline')
  })
})

describe('createEnvironmentThreadStores', () => {
  it('serves the active thread and notifies subscribers on updates', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        workspaces: [{ workspaceId: 'ws', name: 'ws' }],
        sessions: [
          {
            session: { sessionId: THREAD.sessionId, workspaceId: 'ws', title: null },
            threads: [THREAD],
          },
        ],
        activeSessionId: THREAD.sessionId,
      },
      respond: () => null,
    })
    const stores = createEnvironmentThreadStores(client)
    expect(stores.current().messages).toEqual([])

    let notified = 0
    const stop = stores.streamingStore.subscribe('any', () => {
      notified += 1
    })
    const { turn, userMessage } = await client.commands.sendTurn({ ...THREAD, text: 'go' })
    expect(notified).toBeGreaterThan(0)
    expect(stores.messageContentStore.get(userMessage.messageId)).toEqual({ content: 'go' })

    const assistantId = client.streamAssistantText({ ...THREAD, turnId: turn.turnId }, 'partial')
    expect(stores.streamingStore.get(assistantId)).toMatchObject({ content: 'partial' })
    expect(stores.current().messages.at(-1)).toMatchObject({ externalId: assistantId, isFinal: false })
    client.completeTurn({ ...THREAD, turnId: turn.turnId })
    expect(stores.current().messages.at(-1)).toMatchObject({ externalId: assistantId, isFinal: true })
    expect(stores.messageContentStore.get('missing')).toBeNull()
    stop()
    client.dispose()
  })
})
