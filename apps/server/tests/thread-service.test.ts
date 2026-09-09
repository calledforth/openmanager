import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@agentpack/runtime/node'
import { ProofResponseSchemas, type EventEnvelope } from '@openmanager/protocol/node'
import { createThreadService } from '../src/thread-service.js'

describe('thread command provider routing', () => {
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
    const service = createThreadService(runtime, { rejection: () => undefined }, (event) =>
      events.push(event),
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
    const service = createThreadService(runtime, { rejection: () => undefined }, (event) =>
      events.push(event),
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
    const service = createThreadService(runtime, { rejection: () => undefined }, (event) =>
      events.push(event),
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
    const service = createThreadService(runtime, { rejection: () => undefined }, (event) =>
      events.push(event),
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
