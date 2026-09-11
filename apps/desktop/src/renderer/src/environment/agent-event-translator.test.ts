import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentpack/contract'
import { ProofEventSchema, type ProofEvent } from '@openmanager/protocol'
import { createAgentEventTranslator } from './agent-event-translator'

let sequence = 0
const agentEvent = (partial: Record<string, unknown>): AgentEvent =>
  ({
    id: `evt-${++sequence}`,
    threadId: 'session-1',
    seq: sequence,
    timestamp: '2026-09-11T00:00:00.000Z',
    providerId: 'opencode',
    workspaceId: 'C:/repo',
    sessionId: 'session-1',
    ...partial,
  }) as AgentEvent

/** Every translated event must be something the wire would accept. */
const valid = (events: ProofEvent[]) => events.map((event) => ProofEventSchema.parse(event))

const promptStarted = (messageId = 'asst-1', userMessageId = 'usr-1') =>
  agentEvent({
    category: 'lifecycle',
    event: 'prompt_started',
    messageId,
    data: { prompt: 'hello', userMessageId },
  })

describe('createAgentEventTranslator', () => {
  const translator = () => createAgentEventTranslator({ environmentId: 'env' })

  it('turns a new session into session.created and thread.created', () => {
    const events = valid(
      translator().translate(
        agentEvent({ category: 'lifecycle', event: 'session_created', data: {} }),
      ),
    )
    expect(events.map((event) => event.name)).toEqual(['session.created', 'thread.created'])
    expect(events[0]).toMatchObject({
      scope: { type: 'environment', environmentId: 'env' },
      payload: { session: { sessionId: 'session-1', workspaceId: 'C:/repo', title: null } },
    })
    expect(events[1]).toMatchObject({
      scope: { type: 'session', sessionId: 'session-1' },
      payload: { thread: { threadId: 'session-1', sessionId: 'session-1' } },
    })
  })

  it('only announces the thread for a loaded session or one without a workspace', () => {
    const t = translator()
    expect(
      t
        .translate(agentEvent({ category: 'lifecycle', event: 'session_loaded', data: {} }))
        .map((event) => event.name),
    ).toEqual(['thread.created'])
    expect(
      t
        .translate(
          agentEvent({
            category: 'lifecycle',
            event: 'session_created',
            workspaceId: undefined,
            data: {},
          }),
        )
        .map((event) => event.name),
    ).toEqual(['thread.created'])
  })

  it('starts a turn keyed by the assistant message id with the prompt as the user message', () => {
    const t = translator()
    const [started] = valid(t.translate(promptStarted()))
    expect(started).toMatchObject({
      name: 'turn.started',
      scope: { type: 'thread', sessionId: 'session-1', threadId: 'session-1' },
      payload: {
        turn: { turnId: 'asst-1', threadId: 'session-1', state: 'running' },
        userMessage: {
          messageId: 'usr-1',
          turnId: 'asst-1',
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    })
    expect(t.activeTurnId('session-1')).toBe('asst-1')
  })

  it('falls back to the projector naming when the host stamps no message id', () => {
    const [started] = translator().translate(
      agentEvent({
        category: 'lifecycle',
        event: 'prompt_started',
        messageId: undefined,
        data: { prompt: 'hello', userMessageId: 'usr-1' },
      }),
    )
    expect((started as Extract<ProofEvent, { name: 'turn.started' }>).payload.turn.turnId).toMatch(
      /^agent_asst_evt-\d+$/,
    )
  })

  it('streams assistant text, reasoning and tool updates onto the open turn', () => {
    const t = translator()
    t.translate(promptStarted())
    const events = valid([
      ...t.translate(
        agentEvent({
          category: 'stream',
          event: 'agent_message_chunk',
          messageId: 'asst-1',
          data: { content: { type: 'text', text: 'Hi' } },
        }),
      ),
      ...t.translate(
        agentEvent({
          category: 'stream',
          event: 'agent_thought_chunk',
          messageId: 'asst-1',
          data: { phase: 'delta', tokens: 12 },
        }),
      ),
      ...t.translate(
        agentEvent({
          category: 'tool',
          event: 'tool_call_update',
          messageId: 'asst-1',
          data: { toolCallId: 'tool-1', status: 'completed', kind: 'read' },
        }),
      ),
    ])
    expect(events).toMatchObject([
      {
        name: 'message.delta',
        payload: { messageId: 'asst-1', turnId: 'asst-1', role: 'assistant' },
      },
      { name: 'message.reasoning', payload: { messageId: 'asst-1', phase: 'delta', tokens: 12 } },
      {
        name: 'tool.updated',
        payload: { toolCallId: 'tool-1', turnId: 'asst-1', status: 'completed' },
      },
    ])
  })

  it('infers the turn from the message id when it joins a turn mid-flight', () => {
    const t = translator()
    const [delta] = t.translate(
      agentEvent({
        category: 'stream',
        event: 'agent_message_chunk',
        messageId: 'asst-9',
        data: { content: { type: 'text', text: 'late' } },
      }),
    )
    expect(delta).toMatchObject({ payload: { turnId: 'asst-9' } })
    expect(t.activeTurnId('session-1')).toBe('asst-9')
  })

  it('uses an adopted turn for events without a message id', () => {
    const t = translator()
    t.adoptTurn('session-1', 'hydrated-turn')
    const [requested] = t.translate(
      agentEvent({
        category: 'permission',
        event: 'permission_request',
        data: {
          requestId: 'perm-1',
          sessionId: 'session-1',
          toolCall: { toolCallId: 'tool-1', title: 'Run tests' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      }),
    )
    expect(requested).toMatchObject({ payload: { turnId: 'hydrated-turn' } })
  })

  it('completes, interrupts, or fails the turn and forgets it', () => {
    const t = translator()
    t.translate(promptStarted())
    expect(
      valid(
        t.translate(agentEvent({ category: 'lifecycle', event: 'prompt_completed', data: {} })),
      )[0],
    ).toMatchObject({ name: 'turn.completed', payload: { turnId: 'asst-1' } })
    expect(t.activeTurnId('session-1')).toBeNull()

    t.translate(promptStarted('asst-2'))
    expect(
      t.translate(
        agentEvent({
          category: 'lifecycle',
          event: 'prompt_completed',
          data: { stopReason: 'cancelled' },
        }),
      )[0],
    ).toMatchObject({ name: 'turn.interrupted', payload: { turnId: 'asst-2' } })

    t.translate(promptStarted('asst-3'))
    expect(
      valid(
        t.translate(
          agentEvent({
            category: 'error',
            event: 'runtime_error',
            data: { kind: 'provider', message: 'boom' },
          }),
        ),
      )[0],
    ).toMatchObject({
      name: 'turn.failed',
      payload: { turnId: 'asst-3', reason: 'provider_error', message: 'boom' },
    })
    expect(t.activeTurnId('session-1')).toBeNull()
  })

  it('ignores recoverable errors, expected exits, and errors outside a turn', () => {
    const t = translator()
    t.translate(promptStarted())
    expect(
      t.translate(
        agentEvent({
          category: 'error',
          event: 'rpc_error',
          data: { source: 'acp', message: 'retrying', recoverable: true },
        }),
      ),
    ).toEqual([])
    expect(
      t.translate(
        agentEvent({
          category: 'lifecycle',
          event: 'process_exited',
          data: { exitCode: 0, expected: true },
        }),
      ),
    ).toEqual([])
    expect(t.activeTurnId('session-1')).toBe('asst-1')
    expect(
      translator().translate(
        agentEvent({
          category: 'error',
          event: 'runtime_error',
          sessionId: 'session-2',
          data: { kind: 'provider', message: 'no turn here' },
        }),
      ),
    ).toEqual([])
  })

  it('reports an unexpected crash against the open turn', () => {
    const t = translator()
    t.translate(promptStarted())
    expect(
      t.translate(
        agentEvent({
          category: 'lifecycle',
          event: 'process_exited',
          data: { exitCode: 137, expected: false },
        }),
      )[0],
    ).toMatchObject({ payload: { reason: 'provider_process_crashed' } })
  })

  it('maps permission, question and plan requests and their settlements', () => {
    const t = translator()
    t.translate(promptStarted())
    const events = valid([
      ...t.translate(
        agentEvent({
          category: 'permission',
          event: 'permission_request',
          data: {
            requestId: 'perm-1',
            sessionId: 'session-1',
            toolCall: { toolCallId: 'tool-1', title: 'Run tests', kind: 'execute', rawInput: {} },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          },
        }),
      ),
      ...t.translate(
        agentEvent({
          category: 'permission',
          event: 'permission_resolved',
          data: { requestId: 'perm-1', outcome: { outcome: 'selected', optionId: 'allow' } },
        }),
      ),
      ...t.translate(
        agentEvent({
          category: 'session',
          event: 'question_request',
          data: {
            requestId: 'q-1',
            sessionId: 'session-1',
            questions: [{ questionId: 'a', prompt: 'Which?', options: [] }],
          },
        }),
      ),
      ...t.translate(
        agentEvent({
          category: 'session',
          event: 'question_resolved',
          data: { requestId: 'q-1', outcome: { outcome: 'cancelled', reason: 'timeout' } },
        }),
      ),
      ...t.translate(
        agentEvent({
          category: 'session',
          event: 'plan_review_request',
          data: {
            requestId: 'plan-1',
            sessionId: 'session-1',
            markdown: '# Plan',
            todos: [{ id: 't1', content: 'Do it', status: 'pending' }],
            continuation: 'same_turn',
          },
        }),
      ),
      ...t.translate(
        agentEvent({
          category: 'session',
          event: 'plan_review_resolved',
          data: { requestId: 'plan-1', outcome: { outcome: 'accepted' } },
        }),
      ),
    ])
    expect(events.map((event) => event.name)).toEqual([
      'interaction.requested',
      'interaction.resolved',
      'interaction.requested',
      'interaction.resolved',
      'interaction.requested',
      'interaction.resolved',
    ])
    expect(events[0]).toMatchObject({
      payload: {
        turnId: 'asst-1',
        interaction: {
          kind: 'permission',
          interactionId: 'perm-1',
          toolCall: { toolCallId: 'tool-1', title: 'Run tests', kind: 'execute' },
        },
      },
    })
    expect(
      (events[0] as { payload: { interaction: object } }).payload.interaction,
    ).not.toHaveProperty('rawInput')
    expect(events[1]).toMatchObject({
      payload: { response: { kind: 'permission', interactionId: 'perm-1' } },
    })
    expect(events[4]).toMatchObject({
      payload: { interaction: { kind: 'plan', continuation: 'same_turn' } },
    })
  })

  it('updates titles, deletes sessions, and drops composer-only events', () => {
    const t = translator()
    expect(
      valid(
        t.translate(
          agentEvent({
            category: 'session',
            event: 'session_info_update',
            data: { title: 'Renamed' },
          }),
        ),
      )[0],
    ).toMatchObject({
      name: 'session.updated',
      payload: { sessionId: 'session-1', title: 'Renamed' },
    })
    expect(
      t.translate(
        agentEvent({
          category: 'session',
          event: 'session_info_update',
          data: { updatedAt: null },
        }),
      ),
    ).toEqual([])
    expect(
      t.translate(agentEvent({ category: 'lifecycle', event: 'session_deleted', data: {} }))[0],
    ).toMatchObject({ name: 'session.deleted' })
    expect(
      t.translate(
        agentEvent({
          category: 'session',
          event: 'current_model_update',
          data: { availableModels: [], currentModelId: 'x' },
        }),
      ),
    ).toEqual([])
    expect(
      t.translate(
        agentEvent({ category: 'stream', event: 'user_message_chunk', data: { content: {} } }),
      ),
    ).toEqual([])
  })
})
