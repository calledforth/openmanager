import type { PlanContinuation, PlanDocument, PromptInput } from '@agentpack/contract'
import { cursor } from '@agentpack/runtime'
import { describe, expect, it, vi } from 'vitest'
import { buildPlan, deleteSession, type BuildPlanHost, type DeleteSessionHost } from './job-worker'

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

describe('buildPlan', () => {
  const ROUTE = {
    providerId: 'cursor',
    threadId: 'session-1',
    workspaceId: 'C:/workspace',
    cwd: 'C:/workspace',
  } as const

  function setup(continuation: PlanContinuation | undefined) {
    const calls: string[] = []
    const plan: PlanDocument | undefined = continuation
      ? {
          requestId: 'plan-1',
          sessionId: 'session-1',
          markdown: '# Plan',
          todos: [],
          continuation,
        }
      : undefined
    const host = {
      getPendingPlan: vi.fn(() => plan),
      respondPlan: vi.fn(() => calls.push('accepted')),
      runtime: {
        waitForPromptIdle: vi.fn(async () => {
          calls.push('waited')
        }),
        setMode: vi.fn(async () => {
          calls.push('mode')
        }),
        prompt: vi.fn(async () => {
          calls.push('prompted')
        }),
      },
    } as unknown as BuildPlanHost & { runtime: Record<string, ReturnType<typeof vi.fn>> }
    const promptInput = vi.fn(
      async (): Promise<PromptInput> => ({ text: 'Build the plan.', blocks: [] }),
    )
    return { host, calls, promptInput }
  }

  const args = (promptInput: () => Promise<PromptInput>) => ({
    route: ROUTE,
    sessionExternalId: 'session-1',
    requestId: 'plan-1',
    userMessageId: 'user-1',
    modeId: 'agent',
    promptInput,
  })

  it('follow_up_turn drains the proposing turn, switches mode and sends a new prompt', async () => {
    const { host, calls, promptInput } = setup('follow_up_turn')
    await buildPlan(host, args(promptInput))

    expect(calls).toEqual(['accepted', 'waited', 'mode', 'prompted'])
    expect(host.respondPlan).toHaveBeenCalledWith({
      providerId: 'cursor',
      requestId: 'plan-1',
      outcome: { outcome: 'accepted' },
    })
    expect(host.runtime.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        desiredConfig: { modeId: 'agent' },
        userMessageId: 'user-1',
      }),
    )
  })

  it('same_turn submits only the accept, so the plan is not executed twice', async () => {
    const { host, calls, promptInput } = setup('same_turn')
    await buildPlan(host, args(promptInput))

    expect(calls).toEqual(['accepted'])
    expect(host.runtime.waitForPromptIdle).not.toHaveBeenCalled()
    expect(host.runtime.setMode).not.toHaveBeenCalled()
    expect(host.runtime.prompt).not.toHaveBeenCalled()
    // Not even resolved: reading attachments off disk for a prompt that will
    // never be dispatched is pure waste.
    expect(promptInput).not.toHaveBeenCalled()
  })

  it('falls back to follow_up_turn when the request is no longer pending', async () => {
    const { host, calls, promptInput } = setup(undefined)
    await buildPlan(host, args(promptInput))

    expect(calls).toEqual(['accepted', 'waited', 'mode', 'prompted'])
  })
})
