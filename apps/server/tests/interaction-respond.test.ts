import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { AgentRuntime } from '@agentpack/runtime/node'
import {
  ProofResponseSchemas,
  type EventEnvelope,
  type Interaction,
  type InteractionResponse,
} from '@openmanager/protocol/node'
import { createThreadService, type WorkspaceRuntimeResolver } from '../src/thread-service.js'
import { createPersistentEventService } from '../src/event-service.js'
import { runMigrations } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'

const registered: WorkspaceRuntimeResolver = (workspaceId) =>
  workspaceId === '/workspace/project'
    ? { providerId: 'opencode', cwd: '/workspace/project' }
    : undefined

type RuntimeEvent = Parameters<ReturnType<typeof createThreadService>['onRuntimeEvent']>[0]

/**
 * A running turn with a runtime that settles the way the brokers do: the
 * first answer to a provider request emits its resolved event synchronously,
 * and a second one throws.
 */
function harness(database?: DatabaseSync) {
  const events: EventEnvelope[] = []
  const persistent =
    database &&
    createPersistentEventService(database, (record) => events.push(record.event), {
      sessionProviderId: () => 'opencode',
    })
  const settled = new Set<string>()
  /** Modes the host reported starting a turn in, as the composer would hear them. */
  const sessionModes: Array<{ sessionId: string; modeId: string }> = []
  const onSessionMode = (sessionId: string, modeId: string) =>
    sessionModes.push({ sessionId, modeId })
  let emit: (event: RuntimeEvent) => void = () => undefined
  let seq = 0
  let target = { sessionId: '', threadId: '' }
  let finishPrompt: () => void = () => undefined
  let failPrompt: () => void = () => undefined
  const runtimeEvent = (event: string, category: string, data: unknown) =>
    ({
      id: `event-${++seq}`,
      seq,
      timestamp: '2026-09-17T00:00:00Z',
      providerId: 'opencode',
      threadId: target.threadId,
      workspaceId: '/workspace/project',
      sessionId: 'provider-session',
      messageId: 'assistant-1',
      category,
      event,
      data,
    }) as RuntimeEvent
  const settle =
    (event: string, category: string, missing: string) =>
    (args: { requestId: string; outcome: unknown }) => {
      if (settled.has(args.requestId)) throw new Error(missing)
      settled.add(args.requestId)
      emit(runtimeEvent(event, category, { requestId: args.requestId, outcome: args.outcome }))
      return true
    }
  const runtime = {
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
    prompt: vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          finishPrompt = resolve
          failPrompt = () => reject(new Error('provider failed'))
        }),
    ),
    cancel: vi.fn().mockResolvedValue(undefined),
    respondPermission: vi.fn(
      settle(
        'permission_resolved',
        'permission',
        'Permission request not found or already resolved',
      ),
    ),
    respondQuestion: vi.fn(
      settle('question_resolved', 'session', 'Question not found or already resolved'),
    ),
    respondPlan: vi.fn(
      settle('plan_review_resolved', 'session', 'Plan review not found or already resolved'),
    ),
  }
  const service = createThreadService(
    runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
    { rejection: () => undefined },
    (event) => {
      if (persistent) persistent.append(event)
      else events.push(event)
    },
    undefined,
    registered,
    persistent
      ? {
          database,
          flush: persistent.flush,
          appendAtomic: persistent.appendAtomic,
          onSessionMode,
        }
      : { onSessionMode },
  )
  emit = (event) => service.onRuntimeEvent(event)
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
  target = { sessionId: created.session.sessionId, threadId: created.thread.threadId }
  const sent = ProofResponseSchemas['turn.send'].parse(
    service.dispatch({
      type: 'command',
      requestId: 'send',
      name: 'turn.send',
      payload: { ...target, text: 'Go' },
    }),
  ).payload
  emit(
    runtimeEvent('prompt_started', 'lifecycle', {
      prompt: 'Go',
      userMessageId: sent.userMessage.messageId,
    }),
  )

  /** Raise a provider request and return the interaction clients were shown. */
  const request = (event: string, category: string, data: object): Interaction => {
    emit(runtimeEvent(event, category, { sessionId: 'provider-session', ...data }))
    const requested = events.filter((item) => item.name === 'interaction.requested').at(-1)
    return (requested!.payload as { interaction: Interaction }).interaction
  }
  const respond = (
    response: object,
    commandId?: string,
    build?: { text: string; modeId?: string },
  ) =>
    service.dispatch({
      type: 'command',
      requestId: `respond-${++seq}`,
      name: 'interaction.respond',
      payload: {
        ...target,
        response: response as InteractionResponse,
        ...(commandId ? { commandId } : {}),
        ...(build ? { build } : {}),
      },
    })
  const resolved = () => events.filter((item) => item.name === 'interaction.resolved')
  return {
    service,
    runtime,
    events,
    sessionModes,
    target,
    emit,
    runtimeEvent,
    request,
    respond,
    resolved,
    finishPrompt: () => finishPrompt(),
    failPrompt: () => failPrompt(),
  }
}

const permissionRequest = {
  requestId: 'provider-permission',
  toolCall: { toolCallId: 'tool-1', title: 'Run tests', kind: 'execute' },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
}
const questionRequest = {
  requestId: 'provider-question',
  questions: [
    {
      questionId: 'q1',
      prompt: 'Which one?',
      options: [
        { optionId: 'a', label: 'A' },
        { optionId: 'b', label: 'B' },
      ],
    },
  ],
}
const planRequest = {
  requestId: 'provider-plan',
  markdown: '# Plan',
  todos: [],
  continuation: 'same_turn',
}
const ok = { type: 'response', payload: null }

describe('interaction.respond', () => {
  it('retains cancelled lifecycle metadata when a turn ends with an open plan', () => {
    const h = harness()
    const plan = h.request('plan_review_request', 'session', planRequest)
    const terminal = h.runtimeEvent('prompt_completed', 'lifecycle', { stopReason: 'end_turn' })
    h.emit(terminal)
    const response = h.service.dispatch({
      type: 'command',
      requestId: 'history',
      name: 'session.history',
      payload: h.target,
    })
    expect(response).toMatchObject({
      payload: {
        interactions: [],
        plans: [
          {
            state: 'cancelled',
            plan: {
              interactionId: plan.interactionId,
              lifecycle: {
                state: 'cancelled',
                createdAt: plan.lifecycle?.createdAt,
                resolvedAt: terminal.timestamp,
                resolvedByClientId: null,
              },
            },
          },
        ],
      },
    })
    // The original broadcast remains the immutable pending request.
    expect(plan.lifecycle?.state).toBe('pending')
  })

  it('forwards an approval under the provider request id and broadcasts the outcome', () => {
    const h = harness()
    const interaction = h.request('permission_request', 'permission', permissionRequest)
    expect(interaction.interactionId).not.toBe('provider-permission')
    const outcome = { outcome: 'selected', optionId: 'allow' }

    expect(
      h.respond({ kind: 'permission', interactionId: interaction.interactionId, outcome }),
    ).toMatchObject(ok)

    expect(h.runtime.respondPermission).toHaveBeenCalledExactlyOnceWith({
      providerId: 'opencode',
      requestId: 'provider-permission',
      outcome,
    })
    expect(h.resolved()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          response: { kind: 'permission', interactionId: interaction.interactionId, outcome },
        }),
      }),
    ])
  })

  it('forwards a denial, a question answer and a plan verdict to their own resolvers', () => {
    const h = harness()
    const permission = h.request('permission_request', 'permission', permissionRequest)
    const question = h.request('question_request', 'session', questionRequest)
    const plan = h.request('plan_review_request', 'session', planRequest)
    const denied = { outcome: 'selected', optionId: 'deny' }
    const answered = {
      outcome: 'answered',
      answers: [{ questionId: 'q1', selectedOptionIds: ['b'] }],
    }
    const rejected = { outcome: 'rejected', reason: 'needs tests' }

    expect(
      h.respond({ kind: 'permission', interactionId: permission.interactionId, outcome: denied }),
    ).toMatchObject(ok)
    expect(
      h.respond({ kind: 'question', interactionId: question.interactionId, outcome: answered }),
    ).toMatchObject(ok)
    expect(
      h.respond({ kind: 'plan', interactionId: plan.interactionId, outcome: rejected }),
    ).toMatchObject(ok)

    expect(h.runtime.respondPermission).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'provider-permission', outcome: denied }),
    )
    expect(h.runtime.respondQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'provider-question', outcome: answered }),
    )
    expect(h.runtime.respondPlan).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'provider-plan', outcome: rejected }),
    )
    expect(h.resolved()).toHaveLength(3)
  })

  it('answers a retry of the winning command as success without forwarding twice', () => {
    const h = harness()
    const plan = h.request('plan_review_request', 'session', planRequest)
    const response = {
      kind: 'plan',
      interactionId: plan.interactionId,
      outcome: { outcome: 'accepted' },
    }

    expect(h.respond(response, 'command-1')).toMatchObject(ok)
    expect(h.respond(response, 'command-1')).toMatchObject(ok)
    // A client that predates command ids is recognised by its answer instead.
    expect(h.respond(response)).toMatchObject(ok)

    expect(h.runtime.respondPlan).toHaveBeenCalledTimes(1)
    expect(h.resolved()).toHaveLength(1)
  })

  it('refuses a second answer as a conflict, even an identical one from another command', () => {
    const h = harness()
    const permission = h.request('permission_request', 'permission', permissionRequest)
    const allow = {
      kind: 'permission',
      interactionId: permission.interactionId,
      outcome: { outcome: 'selected', optionId: 'allow' },
    }

    expect(h.respond(allow, 'command-1')).toMatchObject(ok)
    for (const loser of [
      h.respond(allow, 'command-2'),
      h.respond({ ...allow, outcome: { outcome: 'selected', optionId: 'deny' } }, 'command-3'),
    ]) {
      expect(loser).toMatchObject({
        type: 'error',
        error: { code: 'conflict', details: { interactionId: permission.interactionId } },
      })
    }
    expect(h.runtime.respondPermission).toHaveBeenCalledTimes(1)
  })

  it('refuses an answer to an interaction the provider settled on its own', () => {
    const h = harness()
    const question = h.request('question_request', 'session', questionRequest)
    h.emit(
      h.runtimeEvent('question_resolved', 'session', {
        requestId: 'provider-question',
        outcome: { outcome: 'cancelled', reason: 'timeout' },
      }),
    )

    expect(
      h.respond({
        kind: 'question',
        interactionId: question.interactionId,
        outcome: { outcome: 'cancelled', reason: 'user' },
      }),
    ).toMatchObject({ type: 'error', error: { code: 'conflict' } })
    expect(h.runtime.respondQuestion).not.toHaveBeenCalled()
  })

  it('refuses an answer once the turn that asked has ended', () => {
    const h = harness()
    const permission = h.request('permission_request', 'permission', permissionRequest)
    h.emit(h.runtimeEvent('prompt_completed', 'lifecycle', { stopReason: 'end_turn' }))

    expect(
      h.respond({
        kind: 'permission',
        interactionId: permission.interactionId,
        outcome: { outcome: 'selected', optionId: 'allow' },
      }),
    ).toMatchObject({ type: 'error', error: { code: 'conflict' } })
    expect(h.runtime.respondPermission).not.toHaveBeenCalled()
  })

  it('keeps an interaction answerable when forwarding fails for another reason', () => {
    const h = harness()
    const plan = h.request('plan_review_request', 'session', planRequest)
    const response = {
      kind: 'plan',
      interactionId: plan.interactionId,
      outcome: { outcome: 'accepted' },
    }
    h.runtime.respondPlan.mockImplementationOnce(() => {
      throw new Error('adapter exploded')
    })

    expect(h.respond(response, 'command-1')).toMatchObject({
      type: 'error',
      error: { code: 'internal' },
    })
    expect(h.respond(response, 'command-2')).toMatchObject(ok)
  })

  it('validates the answer against the request before the provider hears it', () => {
    const h = harness()
    const permission = h.request('permission_request', 'permission', permissionRequest)
    const question = h.request('question_request', 'session', questionRequest)
    const answer = (answers: object[]) =>
      h.respond({
        kind: 'question',
        interactionId: question.interactionId,
        outcome: { outcome: 'answered', answers },
      })

    for (const invalid of [
      h.respond({
        kind: 'permission',
        interactionId: permission.interactionId,
        outcome: { outcome: 'selected', optionId: 'unknown' },
      }),
      h.respond({
        kind: 'plan',
        interactionId: permission.interactionId,
        outcome: { outcome: 'accepted' },
      }),
      answer([{ questionId: 'unknown' }]),
      answer([{ questionId: 'q1', selectedOptionIds: ['unknown'] }]),
      answer([{ questionId: 'q1', selectedOptionIds: ['a', 'b'] }]),
      answer([{ questionId: 'q1' }, { questionId: 'q1' }]),
    ]) {
      expect(invalid).toMatchObject({ type: 'error', error: { code: 'validation' } })
    }
    expect(h.runtime.respondPermission).not.toHaveBeenCalled()
    expect(h.runtime.respondQuestion).not.toHaveBeenCalled()
    expect(h.resolved()).toHaveLength(0)
  })

  it('answers not_found for an unknown interaction or a thread outside the session', () => {
    const h = harness()
    const permission = h.request('permission_request', 'permission', permissionRequest)
    const response = {
      kind: 'permission',
      interactionId: permission.interactionId,
      outcome: { outcome: 'selected', optionId: 'allow' },
    }

    expect(h.respond({ ...response, interactionId: 'unknown' })).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
    expect(
      h.service.dispatch({
        type: 'command',
        requestId: 'foreign',
        name: 'interaction.respond',
        payload: {
          ...h.target,
          sessionId: 'another-session',
          response: response as InteractionResponse,
        },
      }),
    ).toMatchObject({ type: 'error', error: { code: 'not_found' } })
    expect(h.runtime.respondPermission).not.toHaveBeenCalled()
  })
})

describe('plan continuation and history', () => {
  const build = { text: 'Implement the approved plan', modeId: 'agent' }
  const accept = (plan: Interaction) => ({
    kind: 'plan',
    interactionId: plan.interactionId,
    outcome: { outcome: 'accepted' },
  })
  const history = (h: ReturnType<typeof harness>) =>
    ProofResponseSchemas['session.history'].parse(
      h.service.dispatch({
        type: 'command',
        requestId: 'history',
        name: 'session.history',
        payload: h.target,
      }),
    ).payload

  it('waits for Cursor-style prompt drainage and builds once, even across retries and competing sends', async () => {
    const h = harness()
    await vi.waitFor(() => expect(h.runtime.prompt).toHaveBeenCalledTimes(1))
    const plan = h.request('plan_review_request', 'session', {
      ...planRequest,
      continuation: 'follow_up_turn',
    })
    const first = h.respond(accept(plan), 'build-1', build)
    const retry = h.respond(accept(plan), 'build-1', build)
    expect(h.respond(accept(plan), 'build-2', build)).toMatchObject({
      type: 'error',
      error: { code: 'conflict' },
    })
    expect(h.respond(accept(plan), 'build-1')).toMatchObject({
      type: 'error',
      error: { code: 'conflict' },
    })
    h.emit(h.runtimeEvent('prompt_completed', 'lifecycle', { stopReason: 'end_turn' }))
    expect(
      h.service.dispatch({
        type: 'command',
        requestId: 'race',
        name: 'turn.send',
        payload: { ...h.target, text: 'unrelated prompt' },
      }),
    ).toMatchObject({ type: 'error', error: { code: 'conflict' } })
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1)
    h.finishPrompt()
    expect(await first).toMatchObject(ok)
    expect(await retry).toMatchObject(ok)
    expect(((await retry) as { requestId: string }).requestId).not.toBe(
      ((await first) as { requestId: string }).requestId,
    )
    await vi.waitFor(() => expect(h.runtime.prompt).toHaveBeenCalledTimes(2))
    expect(h.runtime.respondPlan).toHaveBeenCalledTimes(1)
    expect(h.runtime.prompt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        desiredConfig: { modeId: 'agent' },
        prompt: { text: build.text, blocks: [{ type: 'text', text: build.text }] },
      }),
    )
    expect(history(h).turns).toHaveLength(2)
    expect(history(h).plans).toEqual([
      expect.objectContaining({
        plan: {
          ...plan,
          lifecycle: { ...plan.lifecycle, state: 'resolved', resolvedAt: expect.any(String) },
        },
        state: 'resolved',
        outcome: { outcome: 'accepted' },
      }),
    ])
    expect(history(h).interactions).toEqual([])

    // The build's mode reaches composers only once the provider has started
    // the prompt; a launch that failed first would leave them where they were.
    expect(h.sessionModes).toEqual([])
    const userMessage = history(h)
      .messages.filter((message) => message.role === 'user')
      .at(-1)!
    h.emit(
      h.runtimeEvent('prompt_started', 'lifecycle', {
        prompt: build.text,
        userMessageId: userMessage.messageId,
      }),
    )
    expect(h.sessionModes).toEqual([{ sessionId: h.target.sessionId, modeId: 'agent' }])
  })

  it('retries a failed durable turn start without repeating acceptance or building twice', async () => {
    const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true })
    runMigrations(database, MIGRATIONS)
    database.exec(
      "INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at) VALUES ('/workspace/project', 'Project', '/workspace/project', 1, 1)",
    )
    try {
      const h = harness(database)
      await vi.waitFor(() => expect(h.runtime.prompt).toHaveBeenCalledTimes(1))
      const plan = h.request('plan_review_request', 'session', {
        ...planRequest,
        continuation: 'follow_up_turn',
      })
      database.exec(`CREATE TRIGGER reject_build BEFORE INSERT ON turns
        BEGIN SELECT RAISE(ABORT, 'temporary persistence failure'); END`)
      const first = h.respond(accept(plan), 'build-1', build)
      h.finishPrompt()
      expect(await first).toMatchObject({ type: 'error', error: { code: 'unavailable' } })
      expect(h.runtime.prompt).toHaveBeenCalledTimes(1)
      expect(history(h).turns).toHaveLength(1)
      expect(history(h).plans?.[0]?.outcome).toEqual({ outcome: 'accepted' })
      expect(h.respond(accept(plan), 'rival', build)).toMatchObject({
        type: 'error',
        error: { code: 'conflict' },
      })
      database.exec('DROP TRIGGER reject_build')
      const retry = h.respond(accept(plan), 'build-1', build)
      const concurrentRetry = h.respond(accept(plan), 'build-1', build)
      expect(await retry).toMatchObject(ok)
      expect(await concurrentRetry).toMatchObject(ok)
      await vi.waitFor(() => expect(h.runtime.prompt).toHaveBeenCalledTimes(2))
      expect(h.runtime.respondPlan).toHaveBeenCalledTimes(1)
      expect(history(h).turns).toHaveLength(2)
      expect(await h.respond(accept(plan), 'build-1', build)).toMatchObject(ok)
      expect(h.runtime.prompt).toHaveBeenCalledTimes(2)
      h.finishPrompt()
      await vi.waitFor(() =>
        expect(history(h).turns.every((turn) => turn.state === 'completed')).toBe(true),
      )
    } finally {
      database.close()
    }
  })

  it('Claude-style build releases the same turn without changing mode or sending again', async () => {
    const h = harness()
    await vi.waitFor(() => expect(h.runtime.prompt).toHaveBeenCalledTimes(1))
    const plan = h.request('plan_review_request', 'session', planRequest)
    expect(h.respond(accept(plan), 'build-1', build)).toMatchObject(ok)
    h.finishPrompt()
    await vi.waitFor(() => expect(history(h).turns[0]?.state).toBe('completed'))
    expect(h.runtime.prompt).toHaveBeenCalledTimes(1)
    expect(h.runtime.prompt).not.toHaveBeenCalledWith(
      expect.objectContaining({ desiredConfig: expect.anything() }),
    )
  })

  it.each(['same_turn', 'follow_up_turn'])(
    'ordinary accept/reject only forwards the verdict for %s',
    async (continuation) => {
      for (const outcome of [
        { outcome: 'accepted' },
        { outcome: 'rejected', reason: 'add tests' },
      ]) {
        const h = harness()
        await vi.waitFor(() => expect(h.runtime.prompt).toHaveBeenCalledTimes(1))
        const plan = h.request('plan_review_request', 'session', { ...planRequest, continuation })
        expect(history(h).plans?.[0]?.state).toBe('pending')
        expect(h.respond({ ...accept(plan), outcome })).toMatchObject(ok)
        h.finishPrompt()
        await vi.waitFor(() => expect(history(h).turns[0]?.state).toBe('completed'))
        expect(h.runtime.prompt).toHaveBeenCalledTimes(1)
        expect(history(h).plans?.[0]?.outcome).toEqual(outcome)
      }
    },
  )

  it.each(['failure', 'late failure', 'interrupt', 'delete'])(
    'does not build after proposing turn %s',
    async (ending) => {
      const h = harness()
      await vi.waitFor(() => expect(h.runtime.prompt).toHaveBeenCalledTimes(1))
      const plan = h.request('plan_review_request', 'session', {
        ...planRequest,
        continuation: 'follow_up_turn',
      })
      const result = h.respond(accept(plan), 'build-1', build)
      if (ending === 'late failure') {
        h.emit(h.runtimeEvent('prompt_completed', 'lifecycle', { stopReason: 'end_turn' }))
        h.failPrompt()
      } else if (ending === 'failure') h.failPrompt()
      else {
        h.service.dispatch({
          type: 'command',
          requestId: 'stop',
          name: ending === 'delete' ? 'session.delete' : 'turn.interrupt',
          payload: { ...h.target, turnId: history(h).turns[0]!.turnId },
        })
        h.finishPrompt()
      }
      expect(await result).toMatchObject({ type: 'error', error: { code: 'conflict' } })
      expect(h.runtime.prompt).toHaveBeenCalledTimes(1)
    },
  )

  it('refuses build on rejection or a non-plan interaction before forwarding', () => {
    const h = harness()
    const permission = h.request('permission_request', 'permission', permissionRequest)
    expect(
      h.respond(
        {
          kind: 'permission',
          interactionId: permission.interactionId,
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
        'bad-permission-build',
        build,
      ),
    ).toMatchObject({ type: 'error', error: { code: 'validation' } })
    expect(h.runtime.respondPermission).not.toHaveBeenCalled()
    const plan = h.request('plan_review_request', 'session', planRequest)
    expect(
      h.respond({ ...accept(plan), outcome: { outcome: 'rejected' } }, 'bad-build', build),
    ).toMatchObject({ type: 'error', error: { code: 'validation' } })
    expect(h.runtime.respondPlan).not.toHaveBeenCalled()
    expect(h.respond(accept(plan), 'good-build', build)).toMatchObject(ok)
  })
})
