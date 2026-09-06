import type { AgentEvent } from '@agentpack/contract'
import { ProofEventSchema, type ProofEvent, type SubscriptionScope } from '@openmanager/protocol'

/** Host identities: never copy provider session/thread/request IDs onto the wire. */
export interface ProtocolEventContext {
  eventId: string
  environmentId: string
  workspaceId: string
  sessionId: string
  threadId: string
  turnId?: string
  messageId?: string
  interactionId?: string
  toolCallId?: string
  sessionTitle?: string | null
  /** Host interpretation of completion; provider stopReason strings are not portable. */
  completionState?: 'completed' | 'interrupted' | 'failed'
}

/** Map the proof slice only. null explicitly means a host-only/future-family event. */
export function projectAgentEvent(
  source: AgentEvent,
  context: ProtocolEventContext,
): ProofEvent | null {
  const environmentScope = { type: 'environment', environmentId: context.environmentId } as const
  const threadScope = {
    type: 'thread',
    environmentId: context.environmentId,
    sessionId: context.sessionId,
    threadId: context.threadId,
  } as const
  const required = (
    key: 'turnId' | 'messageId' | 'interactionId' | 'toolCallId' | 'completionState',
  ): string => {
    const value = context[key]
    if (!value) throw new Error(`Protocol projection requires host ${key}`)
    return value
  }
  const emit = (name: ProofEvent['name'], scope: SubscriptionScope, payload: unknown): ProofEvent =>
    ProofEventSchema.parse({
      type: 'event',
      eventId: context.eventId,
      timestamp: source.timestamp,
      name,
      scope,
      payload,
    })
  const requested = (kind: 'permission' | 'question' | 'plan', fields: object) =>
    emit('interaction.requested', threadScope, {
      turnId: required('turnId'),
      interaction: { ...fields, kind, interactionId: required('interactionId') },
    })
  const resolved = (kind: 'permission' | 'question' | 'plan', outcome: unknown) =>
    emit('interaction.resolved', threadScope, {
      turnId: required('turnId'),
      response: { kind, interactionId: required('interactionId'), outcome },
    })

  switch (source.event) {
    case 'session_created':
      return emit('session.created', environmentScope, {
        session: {
          sessionId: context.sessionId,
          workspaceId: context.workspaceId,
          title: context.sessionTitle ?? null,
        },
      })
    case 'session_loaded':
      return emit('session.updated', environmentScope, { sessionId: context.sessionId })
    case 'session_deleted':
      return emit('session.deleted', environmentScope, { sessionId: context.sessionId })
    case 'session_info_update':
      return emit('session.updated', environmentScope, {
        sessionId: context.sessionId,
        title: source.data.title,
      })
    case 'prompt_started': {
      const turnId = required('turnId')
      return emit('turn.started', threadScope, {
        turn: { turnId, threadId: context.threadId, state: 'running' },
        userMessage: {
          messageId: required('messageId'),
          threadId: context.threadId,
          turnId,
          role: 'user',
          content: [{ type: 'text', text: source.data.prompt }],
        },
      })
    }
    case 'prompt_completed': {
      const state = required('completionState')
      return emit(
        state === 'failed'
          ? 'turn.failed'
          : state === 'interrupted'
            ? 'turn.interrupted'
            : 'turn.completed',
        threadScope,
        {
          turnId: required('turnId'),
          ...(state === 'failed' ? { message: 'The turn failed.' } : {}),
        },
      )
    }
    case 'user_message_chunk':
    case 'agent_message_chunk':
      return emit('message.delta', threadScope, {
        messageId: required('messageId'),
        turnId: required('turnId'),
        role: source.event === 'user_message_chunk' ? 'user' : 'assistant',
        content: source.data.content,
      })
    case 'agent_thought_chunk':
      return emit('message.reasoning', threadScope, {
        messageId: required('messageId'),
        turnId: required('turnId'),
        phase: source.data.phase,
        content: source.data.content,
        tokens: source.data.tokens,
      })
    case 'tool_call':
    case 'tool_call_update':
      return emit('tool.updated', threadScope, {
        toolCallId: required('toolCallId'),
        turnId: required('turnId'),
        title: source.data.title,
        kind: source.data.kind,
        status: source.data.status,
      })
    case 'permission_request':
      return requested('permission', {
        toolCall: {
          toolCallId: required('toolCallId'),
          title: source.data.toolCall.title,
          kind: source.data.toolCall.kind,
        },
        options: source.data.options,
        expiresAt: source.data.expiresAt,
      })
    case 'question_request':
      return requested('question', { title: source.data.title, questions: source.data.questions })
    case 'plan_review_request':
      return requested('plan', {
        name: source.data.name,
        overview: source.data.overview,
        markdown: source.data.markdown,
        todos: source.data.todos,
        phases: source.data.phases,
        continuation: source.data.continuation,
      })
    case 'permission_resolved':
      return resolved('permission', source.data.outcome)
    case 'question_resolved':
      return resolved('question', source.data.outcome)
    case 'plan_review_resolved':
      return resolved('plan', source.data.outcome)
    case 'rpc_error':
    case 'runtime_error':
      // Provider diagnostics stay host-side. A recoverable error must not end a turn.
      if (!context.turnId) return null
      return emit(source.data.recoverable ? 'turn.notice' : 'turn.failed', threadScope, {
        turnId: required('turnId'),
        message: source.data.recoverable
          ? 'The turn is recovering from a temporary error.'
          : 'The turn failed.',
      })
    default:
      return null
  }
}
