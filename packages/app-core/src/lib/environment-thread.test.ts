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
        {
          messageId: 'u1',
          threadId: THREAD.threadId,
          turnId: 't1',
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
        },
        {
          messageId: 'a1',
          threadId: THREAD.threadId,
          turnId: 't1',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
        },
        {
          messageId: 'u2',
          threadId: THREAD.threadId,
          turnId: 't2',
          role: 'user',
          content: [{ type: 'text', text: 'more' }],
        },
      ],
    })
    const projection = projectThread(state)
    expect(
      projection.messages.map((message) => [message.externalId, message.role, message.isFinal]),
    ).toEqual([
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

  it('follows arrival order across thoughts, tools and text runs', () => {
    const message = (messageId: string, text: string) => ({
      messageId,
      threadId: THREAD.threadId,
      turnId: 't1',
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
    })
    const state = thread({
      turns: [{ turnId: 't1', threadId: THREAD.threadId, state: 'completed' }],
      messages: [message('a1', 'Looking closer'), message('a2', 'Found it')],
      reasoning: [
        { messageId: 'r1', turnId: 't1', phase: 'stop', content: [{ type: 'text', text: 'plan' }] },
        {
          messageId: 'r2',
          turnId: 't1',
          phase: 'stop',
          content: [{ type: 'text', text: 'check' }],
        },
      ],
      tools: [
        { toolCallId: 'tool-1', turnId: 't1', title: 'Read', status: 'completed' },
        { toolCallId: 'tool-2', turnId: 't1', title: 'Grep', status: 'completed' },
      ],
      order: [
        { kind: 'reasoning', id: 'r1', turnId: 't1' },
        { kind: 'message', id: 'a1', turnId: 't1' },
        { kind: 'tool', id: 'tool-1', turnId: 't1' },
        { kind: 'reasoning', id: 'r2', turnId: 't1' },
        { kind: 'tool', id: 'tool-2', turnId: 't1' },
        { kind: 'message', id: 'a2', turnId: 't1' },
        // A ref to something the thread does not hold places nothing.
        { kind: 'tool', id: 'tool-gone', turnId: 't1' },
      ],
    })
    const row = projectThread(state).byId.get('a1')!
    expect(row.content.parts?.map((part) => part.id)).toEqual([
      'reasoning:r1',
      'a1',
      'tool-1',
      'reasoning:r2',
      'tool-2',
      'a2',
    ])
    // Separate runs stay separate paragraphs in the plain-text fallback.
    expect(row.content.content).toBe('Looking closer\n\nFound it')
    expect(row.message.isFinal).toBe(true)
  })

  it('labels a settled row with how long the turn ran when the environment says', () => {
    const settledAt = (turn: Record<string, unknown>) =>
      projectThread(
        thread({
          turns: [{ turnId: 't1', threadId: THREAD.threadId, state: 'completed', ...turn }],
          tools: [{ toolCallId: 'tool-1', turnId: 't1', title: 'Read', status: 'completed' }],
        }),
      ).byId.get('turn:t1:assistant')!.content.runtime
    expect(
      settledAt({ startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:00:45.000Z' }),
    ).toEqual({
      startedAt: Date.parse('2026-09-24T10:00:00.000Z'),
      completedAt: Date.parse('2026-09-24T10:00:45.000Z'),
    })
    // An older environment reports no timing; the row keeps the plain label.
    expect(settledAt({})).toBeUndefined()
    expect(settledAt({ startedAt: '2026-09-24T10:00:00.000Z' })).toBeUndefined()
  })

  it('orders an unplaced assistant row as reasoning, tools, then text and maps tool status', () => {
    const state = thread({
      turns: [{ turnId: 't1', threadId: THREAD.threadId, state: 'running' }],
      messages: [
        {
          messageId: 'a1',
          threadId: THREAD.threadId,
          turnId: 't1',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      ],
      reasoning: [
        {
          messageId: 'r1',
          turnId: 't1',
          phase: 'stop',
          content: [{ type: 'text', text: 'think' }],
          tokens: 12,
        },
      ],
      tools: [
        {
          toolCallId: 'tool-1',
          turnId: 't1',
          title: 'pnpm test',
          kind: 'execute',
          status: 'in_progress',
        },
      ],
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

  it.each(['completed', 'interrupted', 'failed'] as const)(
    'closes snapshot reasoning on %s',
    (state) => {
      const projection = projectThread(
        thread({
          turns: [{ turnId: 't1', threadId: THREAD.threadId, state }],
          reasoning: [
            {
              messageId: 'r1',
              turnId: 't1',
              phase: 'delta',
              content: [{ type: 'text', text: 'thinking' }],
            },
          ],
        }),
      )
      expect(projection.messages[0]?.isFinal).toBe(true)
      expect(projection.byId.get('turn:t1:assistant')?.content.parts?.[0]).toMatchObject({
        type: 'reasoning',
        time: { end: 0 },
      })
    },
  )

  it('keeps row identity for turns whose inputs did not change', () => {
    const settled = thread({
      turns: [{ turnId: 't1', threadId: THREAD.threadId, state: 'completed' }],
      messages: [
        {
          messageId: 'a1',
          threadId: THREAD.threadId,
          turnId: 't1',
          role: 'assistant',
          content: [{ type: 'text', text: 'old' }],
        },
      ],
    })
    const first = projectThread(settled)
    const grown = thread({
      ...settled,
      turns: [...settled.turns, { turnId: 't2', threadId: THREAD.threadId, state: 'running' }],
      messages: [
        ...settled.messages,
        {
          messageId: 'a2',
          threadId: THREAD.threadId,
          turnId: 't2',
          role: 'assistant',
          content: [{ type: 'text', text: 'n' }],
        },
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
  it.each(['completed', 'interrupted'] as const)(
    'settles %s through protocol events and preserves the partial reply',
    async (outcome) => {
      const client = createMockEnvironmentClient({
        seed: {
          workspaces: [
            {
              workspaceId: 'ws',
              name: 'ws',
              path: 'ws',
              lastUsedAt: null,
              lastActivityAt: null,
              exists: true,
              capabilities: { git: false, providers: [] },
            },
          ],
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
      expect(stores.current().messages.at(-1)).toMatchObject({
        externalId: assistantId,
        isFinal: false,
      })
      if (outcome === 'completed') client.completeTurn({ ...THREAD, turnId: turn.turnId })
      else await client.commands.interruptTurn({ ...THREAD, turnId: turn.turnId })
      expect(stores.current().messages.at(-1)).toMatchObject({
        externalId: assistantId,
        isFinal: true,
      })
      expect(stores.messageContentStore.get(assistantId)?.content).toBe('partial')
      expect(stores.messageContentStore.get('missing')).toBeNull()
      stop()
      client.dispose()
    },
  )

  it('does not expose a remote stream_chunks store', () => {
    const client = createMockEnvironmentClient()
    const stores = createEnvironmentThreadStores(client)
    expect(stores).not.toHaveProperty('remoteStreamingStore')
    client.dispose()
  })
})

describe('artifact references', () => {
  const reference = {
    type: 'artifact' as const,
    artifactId: 'artifact-1',
    mimeType: 'image/png',
    name: 'screenshot.png',
    sizeBytes: 12,
  }

  it('projects attached and generated images as parts that name the stored bytes', () => {
    const projection = projectThread(
      thread({
        turns: [{ turnId: 't1', threadId: THREAD.threadId, state: 'completed' }],
        messages: [
          {
            messageId: 'u1',
            threadId: THREAD.threadId,
            turnId: 't1',
            role: 'user',
            content: [{ type: 'text', text: 'what is this?' }, reference],
          },
          {
            messageId: 'a1',
            threadId: THREAD.threadId,
            turnId: 't1',
            role: 'assistant',
            content: [
              { type: 'text', text: 'a chart' },
              { ...reference, artifactId: 'artifact-2', name: 'generated-artifact-2.png' },
              // Only images preview; other stored files are not a broken thumbnail.
              { ...reference, artifactId: 'artifact-3', mimeType: 'application/pdf' },
            ],
          },
        ],
      }),
    )
    const artifact = (artifactId: string) => ({ sessionId: THREAD.sessionId, artifactId })
    expect(projection.byId.get('u1')?.content).toEqual({
      content: 'what is this?',
      parts: [
        {
          type: 'image',
          id: 'u1:artifact:artifact-1',
          artifact: artifact('artifact-1'),
          name: 'screenshot.png',
        },
      ],
    })
    expect(projection.byId.get('a1')?.content.parts).toEqual([
      { type: 'text', id: 'a1', text: 'a chart' },
      {
        type: 'image',
        id: 'a1:artifact:artifact-2',
        artifact: artifact('artifact-2'),
        name: 'generated-artifact-2.png',
        generated: true,
      },
    ])
  })

  it('shows the attachments of a send the environment has not confirmed yet', () => {
    const projection = projectThread(
      thread({
        outbox: [
          { commandId: 'cmd-1', text: 'look', artifactIds: ['artifact-1'], status: 'pending' },
        ],
      }),
    )
    expect(projection.messages).toMatchObject([
      {
        externalId: 'send:cmd-1',
        optimisticContent: 'look',
        optimisticAttachments: [
          {
            id: 'artifact-1',
            name: 'image-1',
            artifact: { sessionId: THREAD.sessionId, artifactId: 'artifact-1' },
          },
        ],
      },
    ])
  })
})
