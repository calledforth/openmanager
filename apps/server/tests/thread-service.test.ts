import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@agentpack/runtime/node'
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
})
