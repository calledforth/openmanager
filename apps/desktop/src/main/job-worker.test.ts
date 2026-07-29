import { cursor } from '@agentpack/runtime'
import { describe, expect, it, vi } from 'vitest'
import { deleteSession, type DeleteSessionHost } from './job-worker'

describe('deleteSession', () => {
  it('stops the registry runtime after projecting the deletion', async () => {
    const calls: string[] = []
    const closeThread = vi.fn(async () => {
      calls.push('closed')
    })
    const host = {
      runtime: {
        getProvider: () => cursor,
        closeThread,
      },
      projector: {
        waitForThread: vi.fn(async () => {
          calls.push('projected')
        }),
      },
      emitSessionDeleted: vi.fn(),
    } satisfies DeleteSessionHost

    await deleteSession(host, {
      providerId: 'cursor',
      sessionExternalId: 'session-1',
      workspacePath: 'C:/workspace',
    })

    expect(host.emitSessionDeleted).toHaveBeenCalledWith({
      providerId: 'cursor',
      threadId: 'session-1',
      workspacePath: 'C:/workspace',
      sessionId: 'session-1',
    })
    expect(closeThread).toHaveBeenCalledWith({
      providerId: 'cursor',
      threadId: 'session-1',
    })
    expect(calls).toEqual(['projected', 'closed'])
  })
})
