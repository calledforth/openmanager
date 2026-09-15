import { describe, expect, it } from 'vitest'
import { createMockEnvironmentClient } from '../src/mock'
import { EnvironmentClientError } from '../src/errors'
import { selectActiveThread, selectPendingInteractions, selectSessionList } from '../src/state'
import { SESSION, THREAD, WORKSPACE, permission } from './fixtures'

const seed = { workspaces: [WORKSPACE], sessions: [{ session: SESSION, threads: [THREAD] }] }

describe('mock environment client', () => {
  it('lists seeded workspaces and sessions without a server', async () => {
    const client = createMockEnvironmentClient({ seed })
    expect(await client.commands.listWorkspaces()).toEqual([WORKSPACE])
    expect((await client.commands.listSessions(WORKSPACE.workspaceId)).sessions).toHaveLength(1)
    expect(client.getState().connection.phase).toBe('connected')
  })

  it('pages session summaries without transcripts for empty, one-page and multi-page lists', async () => {
    const empty = createMockEnvironmentClient({ seed: { workspaces: [WORKSPACE] } })
    expect(await empty.commands.listSessions({ workspaceId: WORKSPACE.workspaceId })).toEqual({
      sessions: [],
      nextCursor: null,
    })

    const one = createMockEnvironmentClient({
      seed: {
        workspaces: [WORKSPACE],
        sessions: [
          {
            session: SESSION,
            threads: [THREAD],
            updatedAt: '2026-09-14T04:00:00.000Z',
            providerId: 'opencode',
          },
        ],
      },
    })
    const single = await one.commands.listSessions({ limit: 10 })
    expect(single.sessions).toHaveLength(1)
    expect(single.sessions[0]).toMatchObject({
      sessionId: SESSION.sessionId,
      status: 'idle',
      providerId: 'opencode',
      updatedAt: '2026-09-14T04:00:00.000Z',
    })
    expect(single.sessions[0]).not.toHaveProperty('messages')
    expect(single.nextCursor).toBeNull()

    const many = createMockEnvironmentClient({
      seed: {
        workspaces: [WORKSPACE],
        sessions: [
          {
            session: { sessionId: 'session-a', workspaceId: WORKSPACE.workspaceId, title: 'A' },
            updatedAt: '2026-09-14T04:03:00.000Z',
          },
          {
            session: { sessionId: 'session-b', workspaceId: WORKSPACE.workspaceId, title: 'B' },
            updatedAt: '2026-09-14T04:02:00.000Z',
          },
          {
            session: { sessionId: 'session-c', workspaceId: WORKSPACE.workspaceId, title: 'C' },
            updatedAt: '2026-09-14T04:01:00.000Z',
          },
        ],
      },
    })
    const first = await many.commands.listSessions({ limit: 2 })
    expect(first.sessions.map((session) => session.sessionId)).toEqual(['session-a', 'session-b'])
    expect(first.nextCursor).toEqual({
      updatedAt: '2026-09-14T04:02:00.000Z',
      sessionId: 'session-b',
    })
    const rest = await many.commands.listSessions({ cursor: first.nextCursor!, limit: 2 })
    expect(rest.sessions.map((session) => session.sessionId)).toEqual(['session-c'])
    expect(rest.nextCursor).toBeNull()
  })

  it('creates, opens, renames and deletes sessions through events', async () => {
    const client = createMockEnvironmentClient({ seed })
    const created = await client.commands.createSession({
      environmentId: 'mock-environment',
      providerId: 'opencode',
      workspaceId: WORKSPACE.workspaceId,
      title: 'New',
    })
    expect(selectSessionList(client.getState())).toHaveLength(2)

    await client.commands.openSession(created.session.sessionId)
    expect(client.getState().activeThreadId).toBe(created.thread.threadId)
    expect(selectActiveThread(client.getState())?.hydration).toBe('ready')

    await client.commands.renameSession(created.session.sessionId, 'Renamed')
    expect(client.getState().sessions[created.session.sessionId]?.title).toBe('Renamed')

    await client.commands.deleteSession(created.session.sessionId)
    expect(selectSessionList(client.getState())).toHaveLength(1)
    expect(client.getState().activeSessionId).toBeNull()
  })

  it('echoes a streamed reply for sendTurn and completes the turn', async () => {
    const client = createMockEnvironmentClient({ seed })
    await client.commands.openSession(SESSION.sessionId)
    const updates: string[] = []
    client.subscribe(() => updates.push(client.getState().sessions[SESSION.sessionId]!.status))

    const { turn } = await client.commands.sendTurn({ ...THREAD, text: 'ping' })
    expect(client.getState().sessions[SESSION.sessionId]?.status).toBe('running')
    await client.settle()

    const thread = selectActiveThread(client.getState())!
    const assistant = thread.messages.find((message) => message.role === 'assistant')
    expect(assistant?.content).toEqual([{ type: 'text', text: 'You said: ping' }])
    expect(thread.turns.find((item) => item.turnId === turn.turnId)?.state).toBe('completed')
    expect(updates.at(-1)).toBe('idle')
  })

  it('leaves the turn running when respond returns null so tests can script it', async () => {
    const client = createMockEnvironmentClient({ seed, respond: () => null })
    const { turn } = await client.commands.sendTurn({ ...THREAD, text: 'wait' })
    const target = { ...THREAD, turnId: turn.turnId }
    client.requestInteraction(target, permission)
    expect(selectPendingInteractions(client.getState(), THREAD.threadId)).toHaveLength(1)
    expect(client.getState().sessions[SESSION.sessionId]?.status).toBe('waiting')

    await client.commands.respondToInteraction({
      ...THREAD,
      response: {
        kind: 'permission',
        interactionId: permission.interactionId,
        outcome: { outcome: 'selected', optionId: 'allow' },
      },
    })
    expect(selectPendingInteractions(client.getState(), THREAD.threadId)).toHaveLength(0)

    client.streamAssistantText(target, 'ok')
    client.completeTurn(target)
    expect(client.getState().sessions[SESSION.sessionId]?.status).toBe('idle')
  })

  it('interrupts a scripted reply before it completes', async () => {
    const client = createMockEnvironmentClient({ seed, chunkDelayMs: 50 })
    const { turn } = await client.commands.sendTurn({ ...THREAD, text: 'long' })
    await client.commands.interruptTurn({ ...THREAD, turnId: turn.turnId })
    await client.settle()
    const state = client.getState().threads[THREAD.threadId]!
    expect(state.turns[0]?.state).toBe('interrupted')
    expect(state.messages.filter((message) => message.role === 'assistant')).toHaveLength(0)
  })

  it('settles after a manual interrupt cancels the last scripted chunk', async () => {
    const client = createMockEnvironmentClient({ seed, chunkDelayMs: 50 })
    const { turn } = await client.commands.sendTurn({ ...THREAD, text: 'long' })
    client.interruptTurn({ ...THREAD, turnId: turn.turnId })
    await client.settle()
    expect(client.getState().threads[THREAD.threadId]?.turns[0]?.state).toBe('interrupted')
  })

  it('stops the scripted reply when a turn is completed by hand', async () => {
    const client = createMockEnvironmentClient({ seed, chunkDelayMs: 50 })
    const { turn } = await client.commands.sendTurn({ ...THREAD, text: 'long' })
    client.completeTurn({ ...THREAD, turnId: turn.turnId })
    await client.settle()
    const thread = client.getState().threads[THREAD.threadId]!
    expect(thread.turns[0]?.state).toBe('completed')
    expect(thread.messages.filter((message) => message.role === 'assistant')).toHaveLength(0)
  })

  it('removing a workspace cancels scripted replies for its sessions', async () => {
    const client = createMockEnvironmentClient({ seed, chunkDelayMs: 50 })
    await client.commands.sendTurn({ ...THREAD, text: 'long' })
    await client.commands.removeWorkspace(WORKSPACE.workspaceId)
    await client.settle()
    expect(client.getState().threads[THREAD.threadId]).toBeUndefined()
  })

  it('rejects delayed commands when disposed instead of leaving them pending', async () => {
    const client = createMockEnvironmentClient({ seed, latencyMs: 1000 })
    const pending = client.commands.listWorkspaces()
    client.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('seeds a session whose last turn failed as errored', () => {
    const client = createMockEnvironmentClient({
      seed: {
        ...seed,
        sessions: [
          {
            session: SESSION,
            threads: [THREAD],
            turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'failed' }],
          },
        ],
      },
    })
    expect(selectSessionList(client.getState())[0]?.status).toBe('error')
  })

  it('answers a retried command id with the same turn, even while it runs', async () => {
    const client = createMockEnvironmentClient({ seed, respond: () => null })
    const first = await client.commands.sendTurn({ ...THREAD, text: 'one', commandId: 'cmd-1' })
    const retry = await client.commands.sendTurn({ ...THREAD, text: 'one', commandId: 'cmd-1' })
    expect(retry).toEqual(first)
    const thread = client.getState().threads[THREAD.threadId]!
    expect(thread.turns).toHaveLength(1)
    expect(thread.messages).toHaveLength(1)
    expect(thread.outbox).toEqual([])
  })

  it('marks a refused send failed on its row and keeps the text', async () => {
    const client = createMockEnvironmentClient({ seed, respond: () => null })
    await client.commands.sendTurn({ ...THREAD, text: 'one' })
    await expect(
      client.commands.sendTurn({ ...THREAD, text: 'two', commandId: 'cmd-2' }),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(client.getState().threads[THREAD.threadId]?.outbox).toEqual([
      {
        commandId: 'cmd-2',
        text: 'two',
        status: 'failed',
        error: 'A turn is already in progress.',
      },
    ])
  })

  it('rejects a second turn while one is running', async () => {
    const client = createMockEnvironmentClient({ seed, respond: () => null })
    await client.commands.sendTurn({ ...THREAD, text: 'one' })
    await expect(client.commands.sendTurn({ ...THREAD, text: 'two' })).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  it('rejects commands the environment does not advertise', async () => {
    const client = createMockEnvironmentClient({
      seed,
      capabilities: ['listWorkspaces', 'createSession'],
    })
    expect(client.supports('deleteSession')).toBe(false)
    const error = await client.commands.deleteSession(SESSION.sessionId).catch((e) => e)
    expect(error).toBeInstanceOf(EnvironmentClientError)
    expect(error.code).toBe('capability_missing')
  })

  it('records every command for assertions', async () => {
    const client = createMockEnvironmentClient({ seed })
    await client.commands.listWorkspaces()
    expect(client.calls).toEqual([{ command: 'listWorkspaces', input: null }])
  })

  it('rejects malformed events instead of corrupting state', () => {
    const client = createMockEnvironmentClient({ seed })
    expect(() =>
      client.emit({
        type: 'event',
        eventId: '',
        timestamp: 'nope',
        name: 'turn.completed',
        scope: { type: 'thread', environmentId: 'x', sessionId: 'y', threadId: 'z' },
        payload: { turnId: 't' },
      }),
    ).toThrow()
  })

  it('echoes the user message immediately and ignores a replayed turn.started', async () => {
    const client = createMockEnvironmentClient({ seed, respond: () => null })
    const { turn, userMessage } = await client.commands.sendTurn({ ...THREAD, text: 'echo' })
    const afterSend = client.getState().threads[THREAD.threadId]!
    expect(afterSend.messages).toEqual([userMessage])
    expect(afterSend.turns).toHaveLength(1)

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
      payload: { turn, userMessage },
    })
    expect(client.getState().threads[THREAD.threadId]?.messages).toEqual([userMessage])
  })

  it('reconnects by rehydrating the open session without duplicating messages', async () => {
    const client = createMockEnvironmentClient({ seed, respond: () => null })
    await client.commands.openSession(SESSION.sessionId)
    const { turn, userMessage } = await client.commands.sendTurn({ ...THREAD, text: 'stay' })
    const assistantId = client.streamAssistantText({ ...THREAD, turnId: turn.turnId }, 'ok')
    client.completeTurn({ ...THREAD, turnId: turn.turnId })

    client.reconnect()
    expect(client.getState().connection.phase).toBe('connected')
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    expect(client.getState().threads[THREAD.threadId]?.messages).toEqual([
      userMessage,
      {
        messageId: assistantId,
        threadId: THREAD.threadId,
        turnId: turn.turnId,
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      },
    ])

    client.reconnect()
    expect(client.getState().threads[THREAD.threadId]?.messages).toHaveLength(2)
  })
})

it('validates explicit mock creation and returns its first turn', async () => {
  const client = createMockEnvironmentClient({ seed, respond: () => null })
  const input = {
    environmentId: 'mock-environment',
    workspaceId: WORKSPACE.workspaceId,
    providerId: 'opencode',
  }
  for (const payload of [
    { ...input, environmentId: 'wrong' },
    { ...input, providerId: 'missing' },
    { ...input, firstMessage: '' },
  ]) {
    await expect(client.commands.createSession(payload)).rejects.toMatchObject({
      code: 'validation',
    })
  }
  expect(selectSessionList(client.getState())).toHaveLength(1)
  const created = await client.commands.createSession({ ...input, firstMessage: 'hello' })
  expect(created.firstTurn?.userMessage.content).toEqual([{ type: 'text', text: 'hello' }])
  expect(client.getState().sessions[created.session.sessionId]).toMatchObject({
    providerId: 'opencode',
    status: 'running',
  })
  expect(client.calls.some((call) => call.command === 'sendTurn')).toBe(false)
})
