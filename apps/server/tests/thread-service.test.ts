import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@agentpack/runtime/node'
import { ProofResponseSchemas, type EventEnvelope } from '@openmanager/protocol/node'
import { createThreadService, type WorkspaceRuntimeResolver } from '../src/thread-service.js'

/** The registry seam: every ID the tests use maps to one canonical root. */
const registered: WorkspaceRuntimeResolver = (workspaceId) =>
  workspaceId === '/workspace/project'
    ? { providerId: 'opencode', cwd: '/workspace/project' }
    : undefined

describe('workspace lifecycle', () => {
  it('keeps sessions listed while unavailable, refuses runtime work, and opens after recovery', async () => {
    let available = true
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-1', state: 'created' }),
      prompt: vi.fn(),
      cancel: vi.fn(),
    }
    const service = createThreadService(
      runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
      { rejection: () => undefined },
      vi.fn(),
      undefined,
      (id) => (available ? registered(id) : undefined),
    )
    const created = ProofResponseSchemas['session.create'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'create',
        name: 'session.create',
        payload: { workspaceId: '/workspace/project' },
      }),
    ).payload
    await service.resolveRuntimeSession(created.session.sessionId)
    runtime.ensureSession.mockClear()
    available = false
    const open = () =>
      service.dispatch({
        type: 'command',
        requestId: 'open',
        name: 'session.open',
        payload: { sessionId: created.session.sessionId },
      })
    expect(open()).toMatchObject({
      type: 'error',
      error: { code: 'not_found', message: expect.stringContaining('try again') },
    })
    expect(
      service.dispatch({
        type: 'command',
        requestId: 'send',
        name: 'turn.send',
        payload: {
          sessionId: created.session.sessionId,
          threadId: created.thread.threadId,
          text: 'hello',
        },
      }),
    ).toMatchObject({ type: 'error', error: { code: 'not_found' } })
    expect(
      service.dispatch({ type: 'command', requestId: 'list', name: 'session.list', payload: {} }),
    ).toMatchObject({
      payload: { sessions: [expect.objectContaining({ sessionId: created.session.sessionId })] },
    })
    expect(runtime.ensureSession).not.toHaveBeenCalled()
    expect(runtime.prompt).not.toHaveBeenCalled()
    available = true
    expect(open()).toMatchObject({
      type: 'response',
      payload: { session: { sessionId: created.session.sessionId } },
    })
  })

  it('reports a session as started only once the provider opened it', async () => {
    let gate!: (value: { sessionId: string; state: 'created' }) => void
    let fail!: (error: Error) => void
    const runtime = {
      ensureSession: vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => (gate = resolve)))
        .mockImplementationOnce(() => new Promise((_, reject) => (fail = reject))),
      prompt: vi.fn(),
      cancel: vi.fn(),
    } as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>
    // A throwing stamp is bookkeeping trouble, not a failed start.
    const started = vi.fn(() => {
      throw new Error('database locked')
    })
    const service = createThreadService(
      runtime,
      { rejection: () => undefined },
      vi.fn(),
      undefined,
      () => ({ providerId: 'opencode', cwd: '/workspace/project', onSessionStarted: started }),
    )
    service.setEnvironmentId('environment-1')
    const create = (requestId: string) =>
      ProofResponseSchemas['session.create'].parse(
        service.dispatch({
          type: 'command',
          requestId,
          name: 'session.create',
          payload: { workspaceId: '/workspace/project' },
        }),
      ).payload.session.sessionId
    const first = create('create-1')
    await vi.waitFor(() => expect(runtime.ensureSession).toHaveBeenCalledTimes(1))
    expect(started).not.toHaveBeenCalled()
    gate({ sessionId: 'provider-1', state: 'created' })
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1))
    await expect(service.resolveRuntimeSession(first)).resolves.toMatchObject({
      sessionId: 'provider-1',
    })

    // A start the provider refuses is not a use.
    const refused = create('create-2')
    await vi.waitFor(() => expect(runtime.ensureSession).toHaveBeenCalledTimes(2))
    fail(new Error('provider refused'))
    await vi.waitFor(() =>
      expect(
        service.dispatch({
          type: 'command',
          requestId: 'open-refused',
          name: 'session.open',
          payload: { sessionId: refused },
        }),
      ).toMatchObject({ type: 'error', error: { code: 'not_found' } }),
    )
    expect(started).toHaveBeenCalledTimes(1)
  })

  it('closes the sessions of an unregistered workspace and stops their active turns', async () => {
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
      prompt: vi.fn(() => new Promise(() => undefined)),
      cancel: vi.fn().mockResolvedValue(undefined),
    } as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>
    const events: EventEnvelope[] = []
    const service = createThreadService(
      runtime,
      { rejection: () => undefined },
      (event) => events.push(event),
      undefined,
      (workspaceId) => ({ providerId: 'opencode', cwd: workspaceId }),
    )
    service.setEnvironmentId('environment-1')
    const create = (requestId: string, workspaceId: string) =>
      ProofResponseSchemas['session.create'].parse(
        service.dispatch({
          type: 'command',
          requestId,
          name: 'session.create',
          payload: { workspaceId },
        }),
      ).payload
    const doomed = create('create-1', '/workspace/doomed')
    const kept = create('create-2', '/workspace/kept')
    expect(
      service.dispatch({
        type: 'command',
        requestId: 'send-1',
        name: 'turn.send',
        payload: {
          sessionId: doomed.session.sessionId,
          threadId: doomed.thread.threadId,
          text: 'keep going',
        },
      }),
    ).toMatchObject({ type: 'response' })
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(1))

    expect(service.closeWorkspaceSessions('/workspace/doomed')).toBe(1)
    expect(service.closeWorkspaceSessions('/workspace/doomed')).toBe(0)
    await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledTimes(1))
    expect(
      service.dispatch({
        type: 'command',
        requestId: 'open-1',
        name: 'session.open',
        payload: { sessionId: doomed.session.sessionId },
      }),
    ).toMatchObject({ type: 'error', error: { code: 'not_found' } })
    expect(service.resolveRuntimeSession(kept.session.sessionId)).toBeDefined()
    // A late provider event for the closed thread is dropped, not projected.
    const before = events.length
    service.onRuntimeEvent({
      event: 'prompt_completed',
      threadId: doomed.thread.threadId,
      providerId: 'opencode',
    } as never)
    expect(events).toHaveLength(before)
  })
})

describe('thread command provider routing', () => {
  it('rejects an unregistered workspace before runtime work', () => {
    const runtime = {
      ensureSession: vi.fn(),
      prompt: vi.fn(),
      cancel: vi.fn(),
    } as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>
    const service = createThreadService(
      runtime,
      { rejection: () => undefined },
      vi.fn(),
      undefined,
      registered,
    )
    expect(
      service.dispatch({
        type: 'command',
        requestId: 'create-1',
        name: 'session.create',
        payload: { workspaceId: '/workspace/other' },
      }),
    ).toEqual({
      type: 'error',
      requestId: 'create-1',
      error: { code: 'not_found', message: 'Workspace not found.' },
    })
    expect(runtime.ensureSession).not.toHaveBeenCalled()
  })

  it('rejects a workspace mapped to a missing provider before runtime work', () => {
    const runtime = {
      ensureSession: vi.fn(),
      prompt: vi.fn(),
      cancel: vi.fn(),
    } as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>
    const service = createThreadService(
      runtime,
      {
        rejection: (providerId) =>
          providerId === 'missing'
            ? { code: 'not_found' as const, message: 'Provider not found.' }
            : undefined,
      },
      vi.fn(),
      undefined,
      () => ({ providerId: 'missing', cwd: '/workspace/project' }),
    )

    expect(
      service.dispatch({
        type: 'command',
        requestId: 'create-1',
        name: 'session.create',
        payload: { workspaceId: 'workspace-1' },
      }),
    ).toEqual({
      type: 'error',
      requestId: 'create-1',
      error: { code: 'not_found', message: 'Provider not found.' },
    })
    expect(runtime.ensureSession).not.toHaveBeenCalled()
  })

  it('rolls back host identities and publishes deletion when session startup fails', async () => {
    const runtime = {
      ensureSession: vi.fn().mockRejectedValue(new Error('spawn failed')),
      prompt: vi.fn(),
      cancel: vi.fn(),
    } as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>
    const events: EventEnvelope[] = []
    const service = createThreadService(
      runtime,
      { rejection: () => undefined },
      (event) => events.push(event),
      undefined,
      registered,
    )
    service.setEnvironmentId('environment-1')

    const created = ProofResponseSchemas['session.create'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'create-1',
        name: 'session.create',
        payload: { workspaceId: '/workspace/project' },
      }),
    )
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          name: 'session.deleted',
          payload: { sessionId: created.payload.session.sessionId },
        }),
      ),
    )

    expect(
      service.dispatch({
        type: 'command',
        requestId: 'open-1',
        name: 'session.open',
        payload: { sessionId: created.payload.session.sessionId },
      }),
    ).toMatchObject({ type: 'error', error: { code: 'not_found' } })
  })

  it('keeps the turn active and allows interrupt retry when cancellation fails', async () => {
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
      prompt: vi.fn(() => new Promise(() => undefined)),
      cancel: vi
        .fn()
        .mockRejectedValueOnce(new Error('cancel failed'))
        .mockResolvedValueOnce(undefined),
    } as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>
    const events: EventEnvelope[] = []
    const service = createThreadService(
      runtime,
      { rejection: () => undefined },
      (event) => events.push(event),
      undefined,
      registered,
    )
    service.setEnvironmentId('environment-1')
    const created = ProofResponseSchemas['session.create'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'create-1',
        name: 'session.create',
        payload: { workspaceId: '/workspace/project' },
      }),
    )
    const sent = ProofResponseSchemas['turn.send'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'send-1',
        name: 'turn.send',
        payload: {
          sessionId: created.payload.session.sessionId,
          threadId: created.payload.thread.threadId,
          text: 'Run',
        },
      }),
    )
    const target = {
      sessionId: created.payload.session.sessionId,
      threadId: created.payload.thread.threadId,
    }

    expect(
      service.dispatch({
        type: 'command',
        requestId: 'interrupt-1',
        name: 'turn.interrupt',
        payload: { ...target, turnId: sent.payload.turn.turnId },
      }),
    ).toMatchObject({ type: 'response', requestId: 'interrupt-1' })
    await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(events).not.toContainEqual(expect.objectContaining({ name: 'turn.failed' }))

    expect(
      service.dispatch({
        type: 'command',
        requestId: 'send-2',
        name: 'turn.send',
        payload: { ...target, text: 'Must wait' },
      }),
    ).toMatchObject({ type: 'error', error: { code: 'conflict' } })

    expect(
      service.dispatch({
        type: 'command',
        requestId: 'interrupt-2',
        name: 'turn.interrupt',
        payload: { ...target, turnId: sent.payload.turn.turnId },
      }),
    ).toMatchObject({ type: 'response', requestId: 'interrupt-2' })
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          name: 'turn.interrupted',
          payload: { turnId: sent.payload.turn.turnId },
        }),
      ),
    )
    expect(runtime.cancel).toHaveBeenCalledTimes(2)
  })

  it('ignores delayed completion from an interrupted turn after a new turn starts', async () => {
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
      prompt: vi.fn(() => new Promise(() => undefined)),
      cancel: vi.fn().mockResolvedValue(undefined),
    } as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>
    const events: EventEnvelope[] = []
    const service = createThreadService(
      runtime,
      { rejection: () => undefined },
      (event) => events.push(event),
      undefined,
      registered,
    )
    service.setEnvironmentId('environment-1')
    const created = ProofResponseSchemas['session.create'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'create-1',
        name: 'session.create',
        payload: { workspaceId: '/workspace/project' },
      }),
    )
    const target = {
      sessionId: created.payload.session.sessionId,
      threadId: created.payload.thread.threadId,
    }
    const first = ProofResponseSchemas['turn.send'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'send-1',
        name: 'turn.send',
        payload: { ...target, text: 'First' },
      }),
    )
    service.onRuntimeEvent({
      id: 'event-1',
      seq: 1,
      timestamp: '2026-09-09T00:00:00Z',
      providerId: 'opencode',
      threadId: target.threadId,
      workspaceId: '/workspace/project',
      sessionId: 'provider-session',
      messageId: 'assistant-1',
      category: 'lifecycle',
      event: 'prompt_started',
      data: { prompt: 'First', userMessageId: first.payload.userMessage.messageId },
    })
    service.dispatch({
      type: 'command',
      requestId: 'interrupt-1',
      name: 'turn.interrupt',
      payload: { ...target, turnId: first.payload.turn.turnId },
    })
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ name: 'turn.interrupted' })),
    )

    const second = ProofResponseSchemas['turn.send'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'send-2',
        name: 'turn.send',
        payload: { ...target, text: 'Second' },
      }),
    )
    service.onRuntimeEvent({
      id: 'event-2',
      seq: 2,
      timestamp: '2026-09-09T00:00:01Z',
      providerId: 'opencode',
      threadId: target.threadId,
      workspaceId: '/workspace/project',
      sessionId: 'provider-session',
      messageId: 'assistant-2',
      category: 'lifecycle',
      event: 'prompt_started',
      data: { prompt: 'Second', userMessageId: second.payload.userMessage.messageId },
    })
    service.onRuntimeEvent({
      id: 'event-3',
      seq: 3,
      timestamp: '2026-09-09T00:00:02Z',
      providerId: 'opencode',
      threadId: target.threadId,
      workspaceId: '/workspace/project',
      sessionId: 'provider-session',
      messageId: 'assistant-1',
      category: 'lifecycle',
      event: 'prompt_completed',
      data: { stopReason: 'cancelled' },
    })

    expect(
      service.dispatch({
        type: 'command',
        requestId: 'send-3',
        name: 'turn.send',
        payload: { ...target, text: 'Must conflict' },
      }),
    ).toMatchObject({ type: 'error', error: { code: 'conflict' } })
  })

  it('turns a provider crash into one generic terminal failure', async () => {
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
      prompt: vi.fn(() => new Promise(() => undefined)),
      cancel: vi.fn(),
    } as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>
    const events: EventEnvelope[] = []
    const service = createThreadService(
      runtime,
      { rejection: () => undefined },
      (event) => events.push(event),
      undefined,
      registered,
    )
    service.setEnvironmentId('environment-1')
    const created = ProofResponseSchemas['session.create'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'create-1',
        name: 'session.create',
        payload: { workspaceId: '/workspace/project' },
      }),
    )
    const sent = ProofResponseSchemas['turn.send'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'send-1',
        name: 'turn.send',
        payload: {
          sessionId: created.payload.session.sessionId,
          threadId: created.payload.thread.threadId,
          text: 'Run',
        },
      }),
    )
    const runtimeBase = {
      providerId: 'opencode' as const,
      threadId: created.payload.thread.threadId,
      workspaceId: '/workspace/project',
      sessionId: 'provider-session',
      messageId: 'runtime-message',
    }
    service.onRuntimeEvent({
      ...runtimeBase,
      id: 'provider-start',
      seq: 41,
      timestamp: '2026-09-09T00:00:00Z',
      category: 'lifecycle',
      event: 'prompt_started',
      data: { prompt: 'Run', userMessageId: sent.payload.userMessage.messageId },
    })
    service.onRuntimeEvent({
      ...runtimeBase,
      id: 'provider-exit',
      seq: 42,
      timestamp: '2026-09-09T00:00:01Z',
      category: 'lifecycle',
      event: 'process_exited',
      data: { exitCode: null, signal: 'SECRET_PROVIDER_SIGNAL', expected: false },
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        name: 'turn.failed',
        payload: {
          turnId: sent.payload.turn.turnId,
          reason: 'provider_process_crashed',
          message: 'The provider process crashed before the turn completed.',
        },
      }),
    )
    const wire = JSON.stringify(events)
    expect(wire).not.toContain('SECRET_PROVIDER_SIGNAL')
    expect(wire).not.toContain('provider-exit')
    expect(wire).not.toContain('"seq":42')
  })
})

describe('session summaries and paginated history', () => {
  const runtime = {
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
    prompt: vi.fn(),
    cancel: vi.fn(),
  } as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>

  it('lists empty, one-page and multi-page summaries without transcripts', () => {
    const service = createThreadService(
      runtime,
      { rejection: () => undefined },
      vi.fn(),
      undefined,
      registered,
    )
    expect(
      ProofResponseSchemas['session.list'].parse(
        service.dispatch({
          type: 'command',
          requestId: 'list-empty',
          name: 'session.list',
          payload: {},
        }),
      ).payload,
    ).toEqual({ sessions: [], nextCursor: null })

    const created = ['a', 'b', 'c'].map(
      (requestId) =>
        ProofResponseSchemas['session.create'].parse(
          service.dispatch({
            type: 'command',
            requestId,
            name: 'session.create',
            payload: { workspaceId: '/workspace/project', title: requestId },
          }),
        ).payload,
    )
    const first = ProofResponseSchemas['session.list'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'list-1',
        name: 'session.list',
        payload: { limit: 2 },
      }),
    ).payload
    expect(first.sessions).toHaveLength(2)
    expect(first.sessions[0]).toMatchObject({
      title: expect.any(String),
      status: 'idle',
      workspaceId: '/workspace/project',
      providerId: 'opencode',
    })
    expect(first.sessions[0]).not.toHaveProperty('messages')
    expect(first.nextCursor).not.toBeNull()

    const rest = ProofResponseSchemas['session.list'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'list-2',
        name: 'session.list',
        payload: { cursor: first.nextCursor!, limit: 2 },
      }),
    ).payload
    expect(rest.sessions).toHaveLength(1)
    expect(rest.nextCursor).toBeNull()
    expect(
      [...first.sessions, ...rest.sessions].map((session) => session.sessionId).sort(),
    ).toEqual(created.map((item) => item.session.sessionId).sort())
  })

  it('opens a session as identities and fetches history separately', async () => {
    const completing = {
      ...runtime,
      prompt: vi.fn().mockResolvedValue(undefined),
    }
    const service = createThreadService(
      completing,
      { rejection: () => undefined },
      vi.fn(),
      undefined,
      registered,
    )
    service.setEnvironmentId('environment-1')
    const created = ProofResponseSchemas['session.create'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'create-1',
        name: 'session.create',
        payload: { workspaceId: '/workspace/project', title: 'Chat' },
      }),
    ).payload
    for (const text of ['one', 'two', 'three']) {
      expect(
        service.dispatch({
          type: 'command',
          requestId: `send-${text}`,
          name: 'turn.send',
          payload: {
            sessionId: created.session.sessionId,
            threadId: created.thread.threadId,
            text,
          },
        }),
      ).toMatchObject({ type: 'response' })
      await vi.waitFor(() => {
        const page = ProofResponseSchemas['session.history'].parse(
          service.dispatch({
            type: 'command',
            requestId: `wait-${text}`,
            name: 'session.history',
            payload: {
              sessionId: created.session.sessionId,
              threadId: created.thread.threadId,
            },
          }),
        ).payload
        expect(page.turns.every((turn) => turn.state !== 'running')).toBe(true)
        expect(
          page.messages.some(
            (message) => message.content[0]?.type === 'text' && message.content[0].text === text,
          ),
        ).toBe(true)
      })
    }

    const opened = ProofResponseSchemas['session.open'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'open-1',
        name: 'session.open',
        payload: { sessionId: created.session.sessionId },
      }),
    ).payload
    expect(opened.session).toMatchObject({
      sessionId: created.session.sessionId,
      title: 'Chat',
      status: 'idle',
      providerId: 'opencode',
    })
    expect(opened.threads).toEqual([created.thread])
    expect(opened).not.toHaveProperty('messages')

    const newest = ProofResponseSchemas['session.history'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'history-1',
        name: 'session.history',
        payload: {
          sessionId: created.session.sessionId,
          threadId: created.thread.threadId,
          limit: 2,
        },
      }),
    ).payload
    expect(newest.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'two' },
      { type: 'text', text: 'three' },
    ])
    expect(newest.nextCursor).toEqual({ ordinal: 1 })

    const older = ProofResponseSchemas['session.history'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'history-2',
        name: 'session.history',
        payload: {
          sessionId: created.session.sessionId,
          threadId: created.thread.threadId,
          cursor: newest.nextCursor!,
          limit: 2,
        },
      }),
    ).payload
    expect(older.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'one' },
    ])
    expect(older.nextCursor).toBeNull()
  })
})
