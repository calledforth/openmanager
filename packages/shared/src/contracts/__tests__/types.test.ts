import { describe, it, expect } from 'vitest'
import type {
  ProviderHealth,
  SidecarHandshake,
  Workspace,
  Session,
  Message,
  PendingJob,
  EventEnvelope,
  MessagePartEvent,
} from '../index'

describe('contract types', () => {
  it('SidecarHandshake has required shape', () => {
    const handshake: SidecarHandshake = {
      ready: true,
    }
    expect(handshake.ready).toBe(true)
  })

  it('ProviderHealth models install, auth, runtime and probe independently', () => {
    // The shape `SidecarStatus` could not express: the CLI is installed and
    // signed in, and no session happens to be running.
    const health: ProviderHealth = {
      install: { state: 'installed', version: '2026.07.23' },
      auth: { state: 'authenticated' },
      runtime: { state: 'never_started', liveProcesses: 0, activeTurns: 0 },
      models: { models: [], refreshedAt: null },
      lastProbe: { outcome: 'ok', at: new Date().toISOString(), durationMs: 12 },
      update: { state: 'unknown' },
    }
    expect(health.install.state).toBe('installed')
    expect(health.runtime.state).toBe('never_started')
  })

  it('Workspace domain type is structurally correct', () => {
    const ws: Workspace = {
      id: 'ws-1',
      name: 'My Project',
      path: '/home/user/project',
      machineId: 'machine-abc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(ws.id).toBe('ws-1')
  })

  it('Session status transitions are valid strings', () => {
    const session: Session = {
      id: 's-1',
      workspaceId: 'ws-1',
      externalId: 'oc-session-123',
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(['idle', 'running', 'waiting', 'done', 'error']).toContain(session.status)
  })

  it('Message sequenceNum enables ordering', () => {
    const msgs: Message[] = [
      {
        id: 'm-1',
        sessionId: 's-1',
        externalId: 'evt-1',
        role: 'user',
        content: 'Hello',
        createdAt: Date.now(),
        sequenceNum: 0,
      },
      {
        id: 'm-2',
        sessionId: 's-1',
        externalId: 'evt-2',
        role: 'assistant',
        content: 'Hi there',
        createdAt: Date.now(),
        sequenceNum: 1,
      },
    ]
    const sorted = [...msgs].sort((a, b) => a.sequenceNum - b.sequenceNum)
    expect(sorted[0].role).toBe('user')
    expect(sorted[1].role).toBe('assistant')
  })

  it('PendingJob lifecycle states are defined', () => {
    const job: PendingJob = {
      id: 'j-1',
      workspaceId: 'ws-1',
      type: 'send_message',
      payload: '{}',
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(['pending', 'running', 'done', 'failed']).toContain(job.status)
  })

  it('EventEnvelope wraps typed payloads', () => {
    const event: EventEnvelope<MessagePartEvent> = {
      id: 'e-1',
      type: 'message.part.updated',
      sessionId: 's-1',
      timestamp: Date.now(),
      data: {
        messageId: 'm-1',
        content: 'token chunk',
        role: 'assistant',
        isFinal: false,
      },
    }
    expect(event.type).toBe('message.part.updated')
    expect(event.data.isFinal).toBe(false)
  })
})
