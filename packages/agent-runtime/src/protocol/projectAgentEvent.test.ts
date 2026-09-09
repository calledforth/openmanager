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
