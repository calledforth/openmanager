import type { AgentEvent } from '@agentpack/contract'
import {
  ProofEventSchema,
  type ProofEvent,
  type SubscriptionScope,
  type TurnFailureReason,
} from '@openmanager/protocol'
import {
  contentText,
  isEdit,
  statelessDelta,
  statelessOutput,
  toolFields,
  toolOutputText,
  type ToolCallTracker,
} from './toolCallProjection.js'

export { ToolCallTracker } from './toolCallProjection.js'

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
  resolvedByClientId?: string
  toolCallId?: string
  sessionTitle?: string | null
  /** Host interpretation of completion; provider stopReason strings are not portable. */
  completionState?: 'completed' | 'interrupted' | 'failed'
  /** Host classification of a terminal failure; provider diagnostics never cross this boundary. */
  failureReason?: TurnFailureReason
  /**
   * The turn's tool calls so far, so output streams as deltas and a declined
   * permission reads as such. Without it every update replaces the output.
   */
  toolCalls?: ToolCallTracker
  /** The user asked to stop the turn: a tool failing from here on was cancelled. */
  interruptRequested?: boolean
}

/** Map provider events into the provider-neutral proof protocol. */
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
      interaction: {
        ...fields,
        kind,
        interactionId: required('interactionId'),
        lifecycle: {
          state: 'pending',
          createdAt: source.timestamp,
          resolvedAt: null,
          resolvedByClientId: null,
        },
      },
    })
  const resolved = (
    kind: 'permission' | 'question' | 'plan',
    outcome: { outcome: string; reason?: string },
  ) =>
    emit(
      outcome.outcome === 'cancelled' && outcome.reason === 'timeout'
        ? 'interaction.expired'
        : 'interaction.resolved',
      threadScope,
      {
        turnId: required('turnId'),
        response: { kind, interactionId: required('interactionId'), outcome },
        resolvedByClientId: context.resolvedByClientId ?? null,
      },
    )
  const failed = (reason: TurnFailureReason = context.failureReason ?? 'provider_error') =>
    emit('turn.failed', threadScope, {
      turnId: required('turnId'),
      reason,
      message: failureMessage(reason),
    })

  switch (source.event) {
    case 'process_spawned':
    case 'initialized':
    case 'authenticated':
      return null
    case 'process_exited':
      if (!context.turnId) return null
      if (context.completionState === 'interrupted') {
        return emit('turn.interrupted', threadScope, { turnId: required('turnId') })
      }
      return failed(context.failureReason ?? 'provider_process_exited')
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
        titleSource: 'provider',
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
    case 'background_turn_started':
      // No user message: nobody prompted this turn.
      return emit('turn.started', threadScope, {
        turn: {
          turnId: required('turnId'),
          threadId: context.threadId,
          state: 'running',
          origin: 'background',
        },
      })
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
          ...(state === 'failed'
            ? {
                reason: context.failureReason ?? 'provider_error',
                message: failureMessage(context.failureReason ?? 'provider_error'),
              }
            : {}),
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
    case 'tool_call_update': {
      const toolCallId = required('toolCallId')
      const tracker = context.toolCalls
      const known = tracker?.has(toolCallId) ?? false
      const kind = source.data.kind ?? tracker?.kindOf(toolCallId)
      const fields = toolFields(source.data, {
        kind,
        // The first event of a call opens it, whichever kind of event it is.
        opens: source.event === 'tool_call' || (tracker !== undefined && !known),
        timestamp: source.timestamp,
      })
      if (fields.status === 'failed') {
        if (tracker?.isDeclined(toolCallId)) fields.status = 'declined'
        else if (context.interruptRequested) fields.status = 'cancelled'
      }
      const text = toolOutputText(source.data, isEdit(kind, fields.toolName))
      const output =
        text === undefined
          ? {}
          : tracker
            ? tracker.replace(toolCallId, text)
            : statelessOutput(text)
      tracker?.observe(toolCallId, { kind: fields.kind, status: fields.status })
      return emit('tool.updated', threadScope, {
        toolCallId,
        turnId: required('turnId'),
        ...fields,
        ...output,
      })
    }
    case 'tool_call_content': {
      // Appended output. Anything that is not text (an image, a diff, a
      // terminal handle) has no place in a tool's output.
      const text = contentText(source.data.item)
      if (!text) return null
      const toolCallId = required('toolCallId')
      const tracker = context.toolCalls
      const output = tracker ? tracker.append(toolCallId, text) : statelessDelta(text)
      tracker?.observe(toolCallId, {})
      return emit('tool.updated', threadScope, {
        toolCallId,
        turnId: required('turnId'),
        ...output,
      })
    }
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
      return source.data.recoverable
        ? emit('turn.notice', threadScope, {
            turnId: required('turnId'),
            message: 'The turn is recovering from a temporary error.',
          })
        : failed()
    case 'auth_required':
      if (!context.turnId) return null
      return failed('authentication_required')
    case 'capability_missing':
      if (!context.turnId) return null
      return failed('capability_missing')
    case 'plan_update':
    case 'subtask_update':
    case 'current_model_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'usage_update':
    case 'available_commands_update':
    case 'background_tasks_update': // Task ids are the provider's; the host announces its own.
    case 'extension_request':
    case 'extension_resolved':
    case 'extension_notification':
      return null
  }
}

function failureMessage(reason: TurnFailureReason): string {
  switch (reason) {
    case 'provider_process_exited':
      return 'The provider process exited before the turn completed.'
    case 'provider_process_crashed':
      return 'The provider process crashed before the turn completed.'
    case 'authentication_required':
      return 'The provider requires authentication.'
    case 'capability_missing':
      return 'The provider does not support this operation.'
    case 'provider_error':
      return 'The provider failed to complete the turn.'
  }
}
