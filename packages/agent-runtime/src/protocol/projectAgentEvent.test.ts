import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentpack/contract'
import { ProofEventSchema } from '@openmanager/protocol'
import { projectAgentEvent, type ProtocolEventContext } from './projectAgentEvent.js'

const base = {
  id: 'provider-event',
  threadId: 'provider-thread',
  sessionId: 'provider-session',
  workspaceId: 'provider-workspace',
  providerId: 'claude',
  seq: 900,
  timestamp: '2026-09-06T05:00:00Z',
} as const
const context: ProtocolEventContext = {
  eventId: 'host-event',
  environmentId: 'host-env',
  workspaceId: 'host-workspace',
  sessionId: 'host-session',
  threadId: 'host-thread',
  turnId: 'host-turn',
  messageId: 'host-message',
  interactionId: 'host-interaction',
  toolCallId: 'host-tool',
  completionState: 'completed',
}
const fixtures: AgentEvent[] = [
  { ...base, category: 'lifecycle', event: 'session_created', data: {} },
  { ...base, category: 'lifecycle', event: 'session_loaded', data: {} },
  { ...base, category: 'lifecycle', event: 'session_deleted', data: {} },
  { ...base, category: 'session', event: 'session_info_update', data: { title: 'New title' } },
  {
    ...base,
    category: 'lifecycle',
    event: 'prompt_started',
    data: { prompt: 'Hello', userMessageId: 'provider-message' },
  },
  {
    ...base,
    category: 'lifecycle',
    event: 'prompt_completed',
    data: { stopReason: 'provider-reason' },
  },
  {
    ...base,
    category: 'stream',
    event: 'user_message_chunk',
    data: { messageId: 'provider-message', content: { type: 'text', text: 'Hello' } },
  },
  {
    ...base,
    category: 'stream',
    event: 'agent_message_chunk',
    data: { content: { type: 'text', text: 'Reply' } },
  },
  { ...base, category: 'stream', event: 'agent_thought_chunk', data: { phase: 'stop', tokens: 0 } },
  {
    ...base,
    category: 'tool',
    event: 'tool_call',
    data: {
      toolCallId: 'provider-tool',
      title: 'Read',
      rawInput: { secret: 'hidden' },
      metadata: { secret: 'hidden' },
    },
  },
  {
    ...base,
    category: 'tool',
    event: 'tool_call_update',
    data: { toolCallId: 'provider-tool', status: 'completed', rawOutput: { secret: 'hidden' } },
  },
  {
    ...base,
    category: 'permission',
    event: 'permission_request',
    data: {
      requestId: 'provider-request',
      sessionId: 'provider-session',
      toolCall: { toolCallId: 'provider-tool', title: 'Execute', rawInput: { secret: 'hidden' } },
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
      metadata: { secret: 'hidden' },
    },
  },
  {
    ...base,
    category: 'permission',
    event: 'permission_resolved',
    data: { requestId: 'provider-request', outcome: { outcome: 'selected', optionId: 'allow' } },
  },
  {
    ...base,
    category: 'session',
    event: 'question_request',
    data: {
      requestId: 'provider-request',
      sessionId: 'provider-session',
      questions: [{ questionId: 'q', prompt: 'Continue?', options: [], allowFreeText: true }],
    },
  },
  {
    ...base,
    category: 'session',
    event: 'question_resolved',
    data: {
      requestId: 'provider-request',
      outcome: { outcome: 'answered', answers: [{ questionId: 'q', text: 'Yes' }] },
    },
  },
  {
    ...base,
    category: 'session',
    event: 'plan_review_request',
    data: {
      requestId: 'provider-request',
      sessionId: 'provider-session',
      markdown: 'Plan',
      todos: [],
      continuation: 'same_turn',
    },
  },
  {
    ...base,
    category: 'session',
    event: 'plan_review_resolved',
    data: { requestId: 'provider-request', outcome: { outcome: 'accepted' } },
  },
]

describe('agent to environment protocol projection', () => {
  it.each(fixtures)('projects $event into a validated provider-neutral event', (source) => {
    const result = projectAgentEvent(source, context)
    expect(result).not.toBeNull()
    expect(ProofEventSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(
      JSON.parse(JSON.stringify(result)),
    )
    expect(result?.eventId).toBe('host-event')
    const json = JSON.stringify(result)
    expect(json).not.toContain('provider-')
    expect(json).not.toContain('hidden')
    expect(json).not.toContain('providerId')
    expect(json).not.toContain('rawInput')
    expect(json).not.toContain('rawOutput')
    expect(json).not.toContain('metadata')
    expect(json).not.toContain('900')
  })
  it('preserves nontext reasoning phase and a zero token reading', () => {
    const source = fixtures.find((f) => f.event === 'agent_thought_chunk')!
    expect(projectAgentEvent(source, context)).toMatchObject({
      name: 'message.reasoning',
      payload: { phase: 'stop', tokens: 0 },
    })
  })
  it('marks a provider title with its provenance', () => {
    const source = fixtures.find((f) => f.event === 'session_info_update')!
    expect(projectAgentEvent(source, context)).toMatchObject({
      name: 'session.updated',
      payload: { title: 'New title', titleSource: 'provider' },
    })
  })
  it.each([true, false])(
    'keeps recoverable=%s errors distinct from terminal failures',
    (recoverable) => {
      const source: AgentEvent = {
        ...base,
        category: 'error',
        event: 'rpc_error',
        data: {
          source: 'provider',
          message: 'secret trace',
          recoverable,
          details: { secret: true },
        },
      }
      const result = projectAgentEvent(source, context)
      expect(result?.name).toBe(recoverable ? 'turn.notice' : 'turn.failed')
      if (!recoverable) {
        expect(result?.payload).toMatchObject({ reason: 'provider_error' })
      }
      expect(JSON.stringify(result)).not.toContain('secret')
      expect(projectAgentEvent(source, { ...context, turnId: undefined })).toBeNull()
    },
  )
  it.each(['completed', 'interrupted', 'failed'] as const)(
    'uses the host completion state %s',
    (completionState) => {
      const source = fixtures.find((f) => f.event === 'prompt_completed')!
      expect(projectAgentEvent(source, { ...context, completionState })?.name).toBe(
        `turn.${completionState}`,
      )
      expect(() => projectAgentEvent(source, { ...context, completionState: undefined })).toThrow(
        'completionState',
      )
    },
  )
  it('requires host message and turn identities instead of falling back to provider IDs', () => {
    const source = fixtures.find((f) => f.event === 'user_message_chunk')!
    expect(() => projectAgentEvent(source, { ...context, messageId: undefined })).toThrow(
      'messageId',
    )
    expect(() => projectAgentEvent(source, { ...context, turnId: undefined })).toThrow('turnId')
  })
  it('keeps opaque extension requests and idle process details host-side', () => {
    const extension: AgentEvent = {
      ...base,
      category: 'extension',
      event: 'extension_request',
      data: {
        requestId: 'provider-request',
        method: 'private/method',
        params: { secret: 'hidden' },
      },
    }
    const processSpawned: AgentEvent = {
      ...base,
      category: 'lifecycle',
      event: 'process_spawned',
      data: { args: ['secret'] },
    }
    const processExited: AgentEvent = {
      ...base,
      category: 'lifecycle',
      event: 'process_exited',
      data: { exitCode: 7, signal: 'secret-signal', expected: false },
    }
    expect(projectAgentEvent(extension, context)).toBeNull()
    expect(projectAgentEvent(processSpawned, context)).toBeNull()
    expect(projectAgentEvent(processExited, { ...context, turnId: undefined })).toBeNull()
    expect(projectAgentEvent(processExited, context)).toMatchObject({
      name: 'turn.failed',
      payload: {
        turnId: 'host-turn',
        reason: 'provider_process_exited',
        message: 'The provider process exited before the turn completed.',
      },
    })
    expect(JSON.stringify(projectAgentEvent(processExited, context))).not.toContain('secret')
  })
  it.each([
    [
      'auth_required',
      { message: 'provider secret', loginHint: 'private account' },
      'authentication_required',
    ],
    [
      'capability_missing',
      { capability: 'canCancelPrompt', operation: 'private operation', message: 'provider secret' },
      'capability_missing',
    ],
  ] as const)('normalizes %s as a generic terminal failure', (event, data, reason) => {
    const source = {
      ...base,
      category: 'error',
      event,
      data,
    } as AgentEvent
    const result = projectAgentEvent(source, context)
    expect(result).toMatchObject({ name: 'turn.failed', payload: { reason } })
    expect(JSON.stringify(result)).not.toContain('provider secret')
    expect(JSON.stringify(result)).not.toContain('private')
  })
  it('preserves plan continuation so approval does not repeat a same-turn operation', () => {
    const source = fixtures.find((f) => f.event === 'plan_review_request')!
    expect(projectAgentEvent(source, context)).toMatchObject({
      payload: { interaction: { continuation: 'same_turn' } },
    })
  })
})

describe('typed problems and notices', () => {
  const error = (
    data: Record<string, unknown>,
    event: 'rpc_error' | 'runtime_error' = 'runtime_error',
  ) =>
    ({
      ...base,
      category: 'error',
      event,
      data: { kind: 'provider', source: 'claude/api', message: 'provider secret', ...data },
    }) as AgentEvent
  const notice = (data: Record<string, unknown>) =>
    ({ ...base, category: 'session', event: 'provider_notice', data }) as AgentEvent

  it.each([
    [{ code: 'context_window_exceeded', action: 'compact' }, 'context_window_exceeded', 'compact'],
    [{ code: 'usage_limit' }, 'usage_limit', undefined],
    [{ code: 'rate_limited' }, 'rate_limited', 'retry'],
    [{ code: 'overloaded' }, 'overloaded', 'retry'],
    [{ code: 'server_error' }, 'provider_error', 'retry'],
    [{ code: 'network' }, 'provider_error', 'retry'],
    [{ code: 'unauthorized' }, 'authentication_required', 'sign_in'],
    [{ code: 'refused' }, 'refused', undefined],
    [{ code: 'unknown' }, 'provider_error', undefined],
  ])('fails a turn on %j as %s with action %s', (problem, reason, action) => {
    const result = projectAgentEvent(error({ problem }), context)
    expect(result).toMatchObject({ name: 'turn.failed', payload: { reason } })
    expect(result?.payload).not.toHaveProperty('resetsAt')
    if (action) expect(result?.payload).toMatchObject({ action })
    else expect(result?.payload).not.toHaveProperty('action')
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('carries when a usage limit resets, and drops a time the protocol cannot read', () => {
    expect(
      projectAgentEvent(
        error({ problem: { code: 'usage_limit', resetsAt: '2026-10-09T15:00:00.000Z' } }),
        context,
      )?.payload,
    ).toMatchObject({ reason: 'usage_limit', resetsAt: '2026-10-09T15:00:00.000Z' })
    expect(
      projectAgentEvent(error({ problem: { code: 'usage_limit', resetsAt: 'tomorrow' } }), context)
        ?.payload,
    ).not.toHaveProperty('resetsAt')
  })

  it('lets the host classification of an exit outrank a provider problem', () => {
    expect(
      projectAgentEvent(error({ problem: { code: 'overloaded' } }), {
        ...context,
        failureReason: 'provider_process_crashed',
      })?.payload,
    ).toMatchObject({ reason: 'provider_process_crashed' })
  })

  it('offers sign-in for a provider that needs it', () => {
    const source = {
      ...base,
      category: 'error',
      event: 'auth_required',
      data: { message: 'provider secret' },
    } as AgentEvent
    expect(projectAgentEvent(source, context)?.payload).toMatchObject({
      reason: 'authentication_required',
      action: 'sign_in',
    })
  })

  it('turns a provider retry into a transient notice with its progress', () => {
    const result = projectAgentEvent(
      error(
        {
          recoverable: true,
          problem: { code: 'overloaded', retry: { attempt: 2, maxAttempts: 10, delayMs: 5000 } },
        },
        'rpc_error',
      ),
      context,
    )
    expect(result).toEqual(
      expect.objectContaining({
        name: 'turn.notice',
        payload: {
          noticeId: 'host-event',
          turnId: 'host-turn',
          kind: 'retrying',
          message: 'Retrying after the provider was overloaded (attempt 2 of 10)',
          retry: {
            attempt: 2,
            maxAttempts: 10,
            cause: 'overloaded',
            retryAt: '2026-09-06T05:00:05.000Z',
          },
        },
      }),
    )
  })

  it('keeps an untyped recoverable error a generic retrying notice', () => {
    expect(projectAgentEvent(error({ recoverable: true }, 'rpc_error'), context)?.payload).toEqual({
      noticeId: 'host-event',
      turnId: 'host-turn',
      kind: 'retrying',
      message: 'The turn is recovering from a temporary error.',
    })
  })

  it('records durable notices and keeps compacting transient', () => {
    expect(
      projectAgentEvent(
        notice({
          kind: 'compacted',
          message: 'Conversation compacted',
          compaction: { trigger: 'auto', tokensBefore: 100, tokensAfter: 10 },
        }),
        context,
      ),
    ).toMatchObject({
      name: 'turn.notice.recorded',
      payload: { kind: 'compacted', compaction: { trigger: 'auto', tokensBefore: 100 } },
    })
    expect(
      projectAgentEvent(notice({ kind: 'compacting', message: 'Compacting' }), context)?.name,
    ).toBe('turn.notice')
    expect(
      projectAgentEvent(notice({ kind: 'info', message: 'Hi' }), { ...context, turnId: undefined }),
    ).toBeNull()
  })

  it('cuts provider prose to the protocol limit instead of refusing it', () => {
    const result = projectAgentEvent(
      notice({ kind: 'warning', message: 'x'.repeat(5000), detail: 'y'.repeat(5000) }),
      context,
    )
    expect(ProofEventSchema.safeParse(result).success).toBe(true)
    const payload = result?.payload as { message: string; detail: string }
    expect(payload.message).toHaveLength(2000)
    expect(payload.message.endsWith('…')).toBe(true)
    expect(payload.detail).toHaveLength(2000)
  })
})
