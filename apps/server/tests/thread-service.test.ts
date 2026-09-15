import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@agentpack/runtime/node'
import {
  ProofEventSchemas,
  ProofResponseSchemas,
  type EventEnvelope,
  type CommandEnvelope,
} from '@openmanager/protocol/node'
import { createThreadService, type WorkspaceRuntimeResolver } from '../src/thread-service.js'
import { createPersistentEventService } from '../src/event-service.js'
import { openEnvironmentDatabase } from '../src/db/database.js'

/** The registry seam: every ID the tests use maps to one canonical root. */
const registered: WorkspaceRuntimeResolver = (workspaceId) =>
  workspaceId === '/workspace/project'
    ? { providerId: 'opencode', cwd: '/workspace/project' }
    : undefined

const directories: string[] = []
const databases: DatabaseSync[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

/** A database with the registered workspace already known, ready for sessions. */
async function createDatabase(): Promise<{ database: DatabaseSync }> {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-threads-test-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  database
    .prepare(
      `INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
       VALUES (?, 'project', ?, 1, 1)`,
    )
    .run('/workspace/project', '/workspace/project')
  return { database }
}

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
    service.setEnvironmentId('environment-1')
    const created = ProofResponseSchemas['session.create'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'create',
        name: 'session.create',
        payload: {
          environmentId: 'environment-1',
          providerId: 'opencode',
          workspaceId: '/workspace/project',
        },
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
          payload: {
            environmentId: 'environment-1',
            providerId: 'opencode',
            workspaceId: '/workspace/project',
          },
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
          payload: { environmentId: 'environment-1', providerId: 'opencode', workspaceId },
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
    service.setEnvironmentId('environment-1')
    expect(
      service.dispatch({
        type: 'command',
        requestId: 'create-1',
        name: 'session.create',
        payload: {
          environmentId: 'environment-1',
          providerId: 'opencode',
          workspaceId: '/workspace/other',
        },
      }),
    ).toEqual({
      type: 'error',
      requestId: 'create-1',
      error: {
        code: 'not_found',
        message: 'Workspace not found.',
      },
    })
    expect(runtime.ensureSession).not.toHaveBeenCalled()
  })

  it('rejects an unhealthy provider before runtime work', () => {
    const runtime = {
      ensureSession: vi.fn(),
      prompt: vi.fn(),
      cancel: vi.fn(),
    } as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>
    const service = createThreadService(
      runtime,
      {
        rejection: (providerId) =>
          providerId === 'opencode'
            ? { code: 'unavailable' as const, message: 'Provider is unhealthy.' }
            : undefined,
      },
      vi.fn(),
      undefined,
      () => ({ providerId: 'opencode', cwd: '/workspace/project' }),
    )
    service.setEnvironmentId('environment-1')

    expect(
      service.dispatch({
        type: 'command',
        requestId: 'create-1',
        name: 'session.create',
        payload: {
          environmentId: 'environment-1',
          providerId: 'opencode',
          workspaceId: 'workspace-1',
        },
      }),
    ).toEqual({
      type: 'error',
      requestId: 'create-1',
      error: { code: 'unavailable', message: 'Provider is unhealthy.' },
    })
    expect(runtime.ensureSession).not.toHaveBeenCalled()
  })

  it('answers a provider this build cannot run with capability_missing', () => {
    const runtime = {
      ensureSession: vi.fn(),
      prompt: vi.fn(),
      cancel: vi.fn(),
    } as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>
    const service = createThreadService(
      runtime,
      { rejection: () => ({ code: 'not_found' as const, message: 'Provider not found.' }) },
      vi.fn(),
      undefined,
      () => ({ providerId: 'missing', cwd: '/workspace/project' }),
    )
    service.setEnvironmentId('environment-1')

    expect(
      service.dispatch({
        type: 'command',
        requestId: 'create-1',
        name: 'session.create',
        payload: {
          environmentId: 'environment-1',
          providerId: 'missing',
          workspaceId: 'workspace-1',
        },
      }),
    ).toEqual({
      type: 'error',
      requestId: 'create-1',
      error: {
        code: 'capability_missing',
        message: 'This server cannot run the requested provider.',
      },
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
        payload: {
          environmentId: 'environment-1',
          providerId: 'opencode',
          workspaceId: '/workspace/project',
        },
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
        payload: {
          environmentId: 'environment-1',
          providerId: 'opencode',
          workspaceId: '/workspace/project',
        },
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
        payload: {
          environmentId: 'environment-1',
          providerId: 'opencode',
          workspaceId: '/workspace/project',
        },
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
        payload: {
          environmentId: 'environment-1',
          providerId: 'opencode',
          workspaceId: '/workspace/project',
        },
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
    service.setEnvironmentId('environment-1')
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
            payload: {
              environmentId: 'environment-1',
              providerId: 'opencode',
              workspaceId: '/workspace/project',
              title: requestId,
            },
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
        payload: {
          environmentId: 'environment-1',
          providerId: 'opencode',
          workspaceId: '/workspace/project',
          title: 'Chat',
        },
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

describe('persistence failures on the provider path', () => {
  it('reports a failed write and still settles the turn in memory', async () => {
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
      prompt: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn(),
    } as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>
    const failures: string[] = []
    const service = createThreadService(
      runtime,
      { rejection: () => undefined },
      (event) => {
        if (event.name === 'turn.completed') throw new Error('disk full')
      },
      undefined,
      registered,
      { onPersistenceError: (_error, eventName) => failures.push(eventName) },
    )
    service.setEnvironmentId('environment-1')
    const created = ProofResponseSchemas['session.create'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'create',
        name: 'session.create',
        payload: {
          environmentId: 'environment-1',
          workspaceId: '/workspace/project',
          providerId: 'opencode',
        },
      }),
    ).payload
    const target = { sessionId: created.session.sessionId, threadId: created.thread.threadId }
    const sent = ProofResponseSchemas['turn.send'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'send',
        name: 'turn.send',
        payload: { ...target, text: 'hello' },
      }),
    ).payload
    await vi.waitFor(() => expect(failures).toEqual(['turn.completed']))
    expect(
      service.dispatch({
        type: 'command',
        requestId: 'history',
        name: 'session.history',
        payload: target,
      }),
    ).toMatchObject({ payload: { turns: [{ turnId: sent.turn.turnId, state: 'completed' }] } })
    expect(
      service.dispatch({ type: 'command', requestId: 'list', name: 'session.list', payload: {} }),
    ).toMatchObject({
      payload: { sessions: [{ sessionId: created.session.sessionId, status: 'idle' }] },
    })
  })
})

describe('explicit session creation', () => {
  const input = {
    environmentId: 'environment-1',
    workspaceId: '/workspace/project',
    providerId: 'opencode',
  }
  function setup(resolve: WorkspaceRuntimeResolver = registered) {
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-1', state: 'created' }),
      prompt: vi.fn().mockReturnValue(new Promise(() => undefined)),
      cancel: vi.fn(),
    }
    const events: EventEnvelope[] = []
    const service = createThreadService(
      runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
      { rejection: () => undefined },
      (event) => events.push(event),
      undefined,
      resolve,
    )
    service.setEnvironmentId(input.environmentId)
    const create = (payload: import('@openmanager/protocol/node').CommandEnvelope['payload']) =>
      service.dispatch({ type: 'command', name: 'session.create', requestId: 'create', payload })
    return { service, runtime, events, create }
  }

  it.each([
    [{ ...input, environmentId: 'other' }, 'validation'],
    [{ ...input, workspaceId: 'unknown' }, 'not_found'],
    [{ ...input, providerId: 'claude' }, 'validation'],
    [{ ...input, firstMessage: '' }, 'validation'],
    [{ workspaceId: input.workspaceId }, 'validation'],
  ])('rejects invalid creation without leaving a session: %j', async (payload, code) => {
    const { service, runtime, events, create } = setup()
    expect(create(payload)).toMatchObject({ type: 'error', error: { code } })
    expect(
      service.dispatch({ type: 'command', name: 'session.list', requestId: 'list', payload: {} }),
    ).toMatchObject({ payload: { sessions: [] } })
    await Promise.resolve()
    expect(runtime.ensureSession).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('recovers from a throwing workspace resolver without runtime work', async () => {
    const { create, runtime } = setup(() => {
      throw new Error('folder disappeared')
    })
    expect(create(input)).toMatchObject({ type: 'error', error: { code: 'not_found' } })
    await Promise.resolve()
    expect(runtime.ensureSession).not.toHaveBeenCalled()
  })

  it('uses the requested offered provider and starts the first turn in the create response', async () => {
    const { create, runtime, service, events } = setup(() => ({
      providerId: 'unused-default',
      providers: ['opencode'],
      cwd: '/workspace/project',
    }))
    const created = ProofResponseSchemas['session.create'].parse(
      create({ ...input, firstMessage: 'Hello' }),
    ).payload
    expect(created.firstTurn).toMatchObject({
      turn: { threadId: created.thread.threadId, state: 'running' },
      userMessage: { content: [{ type: 'text', text: 'Hello' }] },
    })
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(1))
    expect(runtime.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'opencode' }),
    )
    expect(runtime.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ userMessageId: created.firstTurn!.userMessage.messageId }),
    )
    expect(
      service.dispatch({
        type: 'command',
        name: 'session.history',
        requestId: 'history',
        payload: { sessionId: created.session.sessionId, threadId: created.thread.threadId },
      }),
    ).toMatchObject({
      payload: { turns: [created.firstTurn!.turn], messages: [created.firstTurn!.userMessage] },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        name: 'session.created',
        scope: { type: 'environment', environmentId: input.environmentId },
      }),
    )
  })

  it('does not start an orphan runtime when the workspace disappears before the first turn', async () => {
    let resolutions = 0
    const { create, runtime, events } = setup((id) =>
      ++resolutions === 1 ? registered(id) : undefined,
    )
    expect(create({ ...input, firstMessage: 'Hello' })).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runtime.ensureSession).not.toHaveBeenCalled()
    expect(runtime.prompt).not.toHaveBeenCalled()
    // The session was announced before the first turn, so its removal is too.
    expect(events.map((event) => event.name)).toEqual([
      'session.created',
      'thread.created',
      'session.deleted',
    ])
  })
})

describe('sends deduplicated by command id', () => {
  const input = {
    environmentId: 'environment-1',
    workspaceId: '/workspace/project',
    providerId: 'opencode',
  }

  function setup(
    options: Parameters<typeof createThreadService>[5] = {},
    resolve: WorkspaceRuntimeResolver = registered,
  ) {
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-1', state: 'created' }),
      prompt: vi.fn().mockReturnValue(new Promise(() => undefined)),
      cancel: vi.fn(),
    }
    const events: EventEnvelope[] = []
    const service = createThreadService(
      runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
      { rejection: () => undefined },
      (event) => events.push(event),
      undefined,
      (workspaceId, context) => resolve(workspaceId, context),
      options,
    )
    service.setEnvironmentId(input.environmentId)
    const created = ProofResponseSchemas['session.create'].parse(
      service.dispatch({
        type: 'command',
        name: 'session.create',
        requestId: 'create',
        payload: input,
      }),
    ).payload
    const send = (commandId: string | undefined, text = 'hello', requestId = 'send') =>
      service.dispatch({
        type: 'command',
        name: 'turn.send',
        requestId,
        payload: {
          sessionId: created.session.sessionId,
          threadId: created.thread.threadId,
          text,
          ...(commandId ? { commandId } : {}),
        },
      })
    return { service, runtime, events, created, send }
  }

  it('answers a repeated command id with the turn it already started', async () => {
    const { runtime, send } = setup()
    const first = ProofResponseSchemas['turn.send'].parse(send('cmd-1')).payload
    expect(first.commandId).toBe('cmd-1')
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(1))

    // The retry lands while the first turn is still running: it must replay,
    // not collide with it.
    const retry = ProofResponseSchemas['turn.send'].parse(send('cmd-1', 'hello', 'send-2')).payload
    expect(retry).toEqual(first)
    expect(runtime.prompt).toHaveBeenCalledTimes(1)
    // A different send during the same running turn is still a conflict.
    expect(send('cmd-2', 'other', 'send-3')).toMatchObject({
      type: 'error',
      error: { code: 'conflict' },
    })
  })

  it('refuses to replay a send whose workspace the caller cannot reach', async () => {
    let reachable = true
    const { send, runtime } = setup({}, (workspaceId) =>
      reachable ? registered(workspaceId) : undefined,
    )
    const first = ProofResponseSchemas['turn.send'].parse(send('cmd-1')).payload
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(1))

    reachable = false
    // The stored turn carries the prompt, so the access check has to come
    // before the replay rather than after it.
    expect(send('cmd-1', 'hello', 'send-2')).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
    expect(JSON.stringify(send('cmd-1', 'hello', 'send-3'))).not.toContain(
      first.userMessage.messageId,
    )
  })

  it('mints a command id for a client that sends none', async () => {
    const { send } = setup()
    const started = ProofResponseSchemas['turn.send'].parse(send(undefined)).payload
    expect(started.commandId).toEqual(expect.any(String))
  })

  it('persists one turn.started per command id', async () => {
    const { database } = await createDatabase()
    const publish = vi.fn()
    const events = createPersistentEventService(database, publish, {
      sessionProviderId: () => 'opencode',
    })
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-1', state: 'created' }),
      prompt: vi.fn().mockReturnValue(new Promise(() => undefined)),
      cancel: vi.fn(),
    }
    const build = (resolve: WorkspaceRuntimeResolver = registered) => {
      const service = createThreadService(
        runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
        { rejection: () => undefined },
        (event) => events.append(event),
        undefined,
        resolve,
        { database, flush: events.flush, appendAtomic: (batch) => events.appendAtomic(batch) },
      )
      service.setEnvironmentId(input.environmentId)
      return service
    }
    const service = build()
    const created = ProofResponseSchemas['session.create'].parse(
      service.dispatch({
        type: 'command',
        name: 'session.create',
        requestId: 'create',
        payload: input,
      }),
    ).payload
    const send = (service: ReturnType<typeof build>, requestId: string) =>
      service.dispatch({
        type: 'command',
        name: 'turn.send',
        requestId,
        payload: {
          sessionId: created.session.sessionId,
          threadId: created.thread.threadId,
          text: 'hello',
          commandId: 'cmd-1',
        },
      })
    const first = ProofResponseSchemas['turn.send'].parse(send(service, 'send-1')).payload
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(1))

    // A restart: nothing about this thread is left in memory, so the retry is
    // answered from the log alone.
    const restarted = build()
    const replayed = ProofResponseSchemas['turn.send'].parse(send(restarted, 'send-2')).payload
    expect(replayed).toEqual(first)
    expect(runtime.prompt).toHaveBeenCalledTimes(1)

    // Same retry, but the restarted service cannot reach the workspace: the
    // durable lookup must be refused before it reads the prompt back.
    const denied = build(() => undefined)
    const refused = send(denied, 'send-3')
    expect(refused).toMatchObject({ type: 'error', error: { code: 'not_found' } })
    expect(JSON.stringify(refused)).not.toContain(first.userMessage.messageId)

    events.flush()
    expect(database.prepare('SELECT count(*) AS count FROM turns').get()).toEqual({ count: 1 })
    expect(
      database.prepare('SELECT command_id FROM turns WHERE turn_id = ?').get(first.turn.turnId),
    ).toEqual({ command_id: 'cmd-1' })
    expect(
      database.prepare("SELECT count(*) AS count FROM messages WHERE role = 'user'").get(),
    ).toEqual({ count: 1 })
    expect(publish.mock.calls.filter(([record]) => record.event.name === 'turn.started')).toHaveLength(
      1,
    )
    events.close()
  })
})

describe('durable session lifecycle', () => {
  function setup() {
    const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true })
    runMigrations(database, MIGRATIONS)
    database.exec(
      "INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at) VALUES ('/workspace/project', 'Project', '/workspace/project', 1, 1)",
    )
    const published: EventEnvelope[] = []
    const events = createPersistentEventService(
      database,
      (record) => published.push(record.event),
      { sessionProviderId: () => 'opencode' },
    )
    const runtime = {
      ensureSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'provider-persisted', state: 'loaded' }),
      prompt: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    }
    const fresh = () => {
      const service = createThreadService(
        runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
        { rejection: () => undefined },
        events.append,
        undefined,
        registered,
        { database, flush: events.flush, appendAtomic: events.appendAtomic },
      )
      service.setEnvironmentId('environment-1')
      return service
    }
    const dispatch = (
      service: ReturnType<typeof fresh>,
      name: string,
      payload: CommandEnvelope['payload'],
    ) => service.dispatch({ type: 'command', requestId: name.replaceAll('.', '-'), name, payload })
    const service = fresh()
    const created = ProofResponseSchemas['session.create'].parse(
      dispatch(service, 'session.create', {
        environmentId: 'environment-1',
        workspaceId: '/workspace/project',
        providerId: 'opencode',
        title: 'Original',
      }),
    ).payload
    return {
      database,
      published,
      events,
      runtime,
      fresh,
      service,
      created,
      dispatch,
      close: () => {
        events.close()
        database.close()
      },
    }
  }

  it('renames live and SQLite-only sessions without loading a provider', async () => {
    const h = setup()
    try {
      const { sessionId } = h.created.session
      await h.service.resolveRuntimeSession(sessionId)
      for (const service of [h.service, h.fresh()]) {
        h.runtime.ensureSession.mockClear()
        expect(
          h.dispatch(service, 'session.rename', { sessionId, title: '  My title  ' }),
        ).toMatchObject({ payload: { session: { sessionId, title: 'My title' } } })
        expect(
          h.database
            .prepare('SELECT title, title_source, updated_at FROM sessions WHERE session_id = ?')
            .get(sessionId),
        ).toMatchObject({ title: 'My title', title_source: 'user', updated_at: expect.any(Number) })
        expect(h.published.at(-1)).toMatchObject({
          name: 'session.updated',
          scope: { type: 'environment' },
          payload: { sessionId, title: 'My title' },
        })
        expect(h.runtime.ensureSession).not.toHaveBeenCalled()
      }
    } finally {
      h.close()
    }
  })

  it('resumes the stored provider identity and status after restart and then sends a turn', async () => {
    const h = setup()
    try {
      const { sessionId } = h.created.session
      await h.service.resolveRuntimeSession(sessionId)
      // Reattaching stamps the row so the reattach is visible in the session list.
      expect(
        h.database.prepare('SELECT provider_session_id, updated_at FROM sessions').get(),
      ).toMatchObject({
        provider_session_id: 'provider-persisted',
        updated_at: expect.any(Number),
      })
      h.database.prepare("UPDATE sessions SET status = 'error'").run()
      const restarted = h.fresh()
      h.runtime.ensureSession.mockClear()
      h.published.length = 0
      expect(h.dispatch(restarted, 'session.open', { sessionId })).toMatchObject({
        payload: { session: { sessionId, status: 'error' }, threads: [h.created.thread] },
      })
      await restarted.resolveRuntimeSession(sessionId)
      expect(h.runtime.ensureSession).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionId: 'provider-persisted',
          threadId: h.created.thread.threadId,
        }),
      )
      expect(h.published.some((event) => event.name === 'session.created')).toBe(false)
      expect(
        h.dispatch(restarted, 'turn.send', { ...h.created.thread, text: 'Continue' }),
      ).toMatchObject({ type: 'response' })
      await vi.waitFor(() =>
        expect(h.runtime.prompt).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'provider-persisted' }),
        ),
      )
      expect(h.database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toMatchObject({
        count: 1,
      })
    } finally {
      h.close()
    }
  })

  it.each([false, true])(
    'deletes messages, parts and session event logs (SQLite-only: %s)',
    async (restart) => {
      const h = setup()
      try {
        const { sessionId } = h.created.session
        await h.service.resolveRuntimeSession(sessionId)
        h.dispatch(h.service, 'turn.send', { ...h.created.thread, text: 'Saved message' })
        await vi.waitFor(() => expect(h.runtime.prompt).toHaveBeenCalled())
        const count = (table: string) =>
          Number(
            (
              h.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
                count: number
              }
            ).count,
          )
        expect(count('messages')).toBeGreaterThan(0)
        expect(count('message_parts')).toBeGreaterThan(0)
        const before = count('event_log')
        expect(before).toBeGreaterThan(1)
        const scopedEventCount = () =>
          Number(
            (
              h.database
                .prepare(
                  "SELECT COUNT(*) AS count FROM event_log WHERE json_extract(event_json, '$.scope.sessionId') = ?",
                )
                .get(sessionId) as { count: number }
            ).count,
          )
        expect(scopedEventCount()).toBeGreaterThan(0)
        const service = restart ? h.fresh() : h.service
        expect(h.dispatch(service, 'session.delete', { sessionId })).toMatchObject({
          type: 'response',
          payload: null,
        })
        for (const table of ['sessions', 'threads', 'turns', 'messages', 'message_parts'])
          expect(count(table)).toBe(0)
        // Environment announcements survive for reconnect replay; scoped history cascades.
        expect(count('event_log')).toBeLessThan(before)
        expect(scopedEventCount()).toBe(0)
        expect(
          h.database
            .prepare('SELECT COUNT(*) AS count FROM event_streams WHERE session_id = ?')
            .get(sessionId),
        ).toMatchObject({ count: 0 })
        expect(h.published.at(-1)).toMatchObject({
          name: 'session.deleted',
          payload: { sessionId },
        })
        expect(h.dispatch(service, 'session.delete', { sessionId })).toMatchObject({
          error: { code: 'not_found' },
        })
      } finally {
        h.close()
      }
    },
  )

  it('cancels a running turn on delete and ignores its late completion', async () => {
    const h = setup()
    let finish!: () => void
    h.runtime.prompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    try {
      const { sessionId } = h.created.session
      await h.service.resolveRuntimeSession(sessionId)
      h.dispatch(h.service, 'turn.send', { ...h.created.thread, text: 'Running' })
      await vi.waitFor(() => expect(h.runtime.prompt).toHaveBeenCalled())
      expect(h.dispatch(h.service, 'session.delete', { sessionId })).toMatchObject({
        type: 'response',
      })
      await vi.waitFor(() =>
        expect(h.runtime.cancel).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'provider-persisted' }),
        ),
      )
      const eventCount = h.published.length
      finish()
      await Promise.resolve()
      await Promise.resolve()
      expect(h.published).toHaveLength(eventCount)
      expect(
        h.dispatch(h.service, 'turn.send', { ...h.created.thread, text: 'Late' }),
      ).toMatchObject({ error: { code: 'not_found' } })
    } finally {
      h.close()
    }
  })

  it('keeps a user title when a provider renames the session afterwards', async () => {
    const h = setup()
    try {
      const { sessionId } = h.created.session
      // Settle the provider session write before close, or it lands on a closed database.
      await h.service.resolveRuntimeSession(sessionId)
      h.dispatch(h.service, 'session.rename', { sessionId, title: 'My title' })
      const providerTitle = (title: string, titleSource?: 'provider') =>
        h.events.append(
          ProofEventSchemas['session.updated'].parse({
            type: 'event',
            name: 'session.updated',
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            scope: { type: 'environment', environmentId: 'environment-1' },
            payload: { sessionId, title, ...(titleSource ? { titleSource } : {}) },
          }),
        )
      const stored = () =>
        h.database
          .prepare('SELECT title, title_source FROM sessions WHERE session_id = ?')
          .get(sessionId)
      // A provider title carries no provenance, so it must not clobber the rename.
      providerTitle('Provider guess')
      h.events.flush()
      expect(stored()).toMatchObject({ title: 'My title', title_source: 'user' })
      // An explicit provider provenance is a deliberate downgrade and does apply.
      providerTitle('Provider wins', 'provider')
      h.events.flush()
      expect(stored()).toMatchObject({ title: 'Provider wins', title_source: 'provider' })
      // With the user claim gone, an unlabelled provider title applies again.
      providerTitle('Later guess')
      h.events.flush()
      expect(stored()).toMatchObject({ title: 'Later guess', title_source: 'provider' })
    } finally {
      h.close()
    }
  })

  it('restores and abandons every thread of a multi-thread session together', async () => {
    const h = setup()
    try {
      const { sessionId } = h.created.session
      const firstThreadId = h.created.thread.threadId
      await h.service.resolveRuntimeSession(sessionId)
      h.database
        .prepare(
          `INSERT INTO threads (thread_id, session_id, workspace_id, created_at, updated_at)
           VALUES (?, ?, '/workspace/project', 1, 1)`,
        )
        .run('thread-second', sessionId)

      const restarted = h.fresh()
      expect(h.dispatch(restarted, 'session.open', { sessionId })).toMatchObject({
        type: 'response',
      })
      await restarted.resolveRuntimeSession(sessionId)
      // Both threads are addressable, not just the one the session maps to.
      for (const threadId of [firstThreadId, 'thread-second'])
        expect(
          h.dispatch(restarted, 'turn.send', { sessionId, threadId, text: 'Hello' }),
        ).toMatchObject({ type: 'response' })
      // Let both turns finalize, so no write lands after the database closes.
      await vi.waitFor(() =>
        expect(
          h.database.prepare("SELECT COUNT(*) AS count FROM turns WHERE state = 'running'").get(),
        ).toMatchObject({ count: 0 }),
      )

      // A failed load abandons the whole session rather than leaving siblings behind.
      const failed = h.fresh()
      h.runtime.ensureSession.mockRejectedValueOnce(new Error('provider gone'))
      expect(h.dispatch(failed, 'session.open', { sessionId })).toMatchObject({
        type: 'response',
      })
      await vi.waitFor(() => {
        for (const threadId of [firstThreadId, 'thread-second'])
          expect(
            h.dispatch(failed, 'turn.send', { sessionId, threadId, text: 'Hello' }),
          ).toMatchObject({ error: { code: 'not_found' } })
      })
    } finally {
      h.close()
    }
  })

  it('rejects resume without a load capability or stored provider identity', async () => {
    const h = setup()
    try {
      const { sessionId } = h.created.session
      await h.service.resolveRuntimeSession(sessionId)
      h.database.prepare('UPDATE sessions SET provider_session_id = NULL').run()
      expect(h.dispatch(h.fresh(), 'session.open', { sessionId })).toMatchObject({
        error: { code: 'unavailable' },
      })
      h.database.prepare("UPDATE sessions SET provider_id = 'unsupported'").run()
      expect(h.dispatch(h.fresh(), 'session.open', { sessionId })).toMatchObject({
        error: { code: 'capability_missing' },
      })
    } finally {
      h.close()
    }
  })
})
