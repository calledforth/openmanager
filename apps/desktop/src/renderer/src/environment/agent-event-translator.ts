import { isRecoverableError, type AgentEvent } from '@agentpack/contract'
import type {
  ContentBlock,
  Interaction,
  InteractionResponse,
  ProofEvent,
  TurnFailureReason,
} from '@openmanager/protocol'

/**
 * TEMPORARY — deleted with the Convex adapter (see docs/compatibility-adapters.md).
 *
 * Folds the desktop's `AgentEvent` stream (what the main process pushes over
 * the `acp:event` and `stream:token` IPC channels) into protocol `ProofEvent`s
 * so the shared reducers in `@openmanager/environment-client` can consume it
 * unchanged. The environment server does the same translation on its side of
 * the wire; this is the in-process stand-in until the desktop talks to it.
 *
 * Identity mapping, chosen to line up with what the Convex projector persists
 * so a hydrated thread and its live tail agree:
 *
 * - session ID = the provider's session external ID
 * - thread ID  = the session ID (the desktop has exactly one thread per session)
 * - turn ID    = the assistant message ID the host stamps on every event of a
 *                turn (`event.messageId`), which is also the persisted
 *                assistant message's external ID
 * - user message ID = `prompt_started.data.userMessageId`
 * - interaction ID  = the provider request ID
 */
export interface AgentEventTranslator {
  translate(event: AgentEvent): ProofEvent[]
  /** The turn this translator believes is open on a session, if any. */
  activeTurnId(sessionId: string): string | null
  /**
   * Record a turn learned from hydration rather than from `prompt_started`,
   * so later events that carry no message ID still land on the right turn.
   */
  adoptTurn(sessionId: string, turnId: string): void
}

const INTERRUPTED_STOP = /cancel|abort|interrupt/i

/** What turn bookkeeping needs from an event: where it happened and the host's message ID. */
type Located = Pick<AgentEvent, 'id' | 'timestamp' | 'messageId'> & { sessionId: string }

export function createAgentEventTranslator(options: {
  environmentId: string
}): AgentEventTranslator {
  const { environmentId } = options
  const turns = new Map<string, string>()

  const envelope = (event: Pick<AgentEvent, 'id' | 'timestamp'>, suffix?: string) => ({
    type: 'event' as const,
    eventId: suffix ? `${event.id}:${suffix}` : event.id,
    timestamp: event.timestamp,
  })
  const environmentScope = { type: 'environment', environmentId } as const
  const sessionScope = (sessionId: string) =>
    ({ type: 'session', environmentId, sessionId }) as const
  const threadScope = (sessionId: string) =>
    ({ type: 'thread', environmentId, sessionId, threadId: sessionId }) as const

  /**
   * The turn an event belongs to. `prompt_started` establishes it; every
   * later event of the turn carries the same `messageId`, which doubles as a
   * fallback for a turn this renderer joined mid-flight.
   */
  const turnIdFor = (event: Located): string => {
    const known = turns.get(event.sessionId)
    if (known) return known
    const inferred = event.messageId ?? `${event.sessionId}:turn`
    turns.set(event.sessionId, inferred)
    return inferred
  }

  const failure = (event: Located, reason: TurnFailureReason, message: string): ProofEvent[] => {
    const turnId = turns.get(event.sessionId) ?? event.messageId
    if (!turnId) return []
    turns.delete(event.sessionId)
    return [
      {
        ...envelope(event),
        name: 'turn.failed',
        scope: threadScope(event.sessionId),
        payload: { turnId, reason, message },
      },
    ]
  }

  const requested = (event: Located, interaction: Interaction): ProofEvent[] => [
    {
      ...envelope(event),
      name: 'interaction.requested',
      scope: threadScope(event.sessionId),
      payload: { turnId: turnIdFor(event), interaction },
    },
  ]

  const resolved = (event: Located, response: InteractionResponse): ProofEvent[] => [
    {
      ...envelope(event),
      name: 'interaction.resolved',
      scope: threadScope(event.sessionId),
      payload: { turnId: turnIdFor(event), response },
    },
  ]

  const translate = (event: AgentEvent): ProofEvent[] => {
    switch (event.event) {
      case 'session_created': {
        const thread: ProofEvent = {
          ...envelope(event, 'thread'),
          name: 'thread.created',
          scope: sessionScope(event.sessionId),
          payload: { thread: { threadId: event.sessionId, sessionId: event.sessionId } },
        }
        if (!event.workspaceId) return [thread]
        return [
          {
            ...envelope(event),
            name: 'session.created',
            scope: environmentScope,
            payload: {
              session: { sessionId: event.sessionId, workspaceId: event.workspaceId, title: null },
            },
          },
          thread,
        ]
      }
      case 'session_loaded':
        return [
          {
            ...envelope(event),
            name: 'thread.created',
            scope: sessionScope(event.sessionId),
            payload: { thread: { threadId: event.sessionId, sessionId: event.sessionId } },
          },
        ]
      case 'session_deleted':
        turns.delete(event.sessionId)
        return [
          {
            ...envelope(event),
            name: 'session.deleted',
            scope: environmentScope,
            payload: { sessionId: event.sessionId },
          },
        ]
      case 'session_info_update':
        if (event.data.title === undefined) return []
        return [
          {
            ...envelope(event),
            name: 'session.updated',
            scope: environmentScope,
            payload: { sessionId: event.sessionId, title: event.data.title },
          },
        ]
      case 'prompt_started': {
        // Same fallback the Convex projector uses, so the persisted assistant
        // message and this turn share an ID even for hosts that omit it.
        const turnId = event.messageId ?? `agent_asst_${event.id}`
        turns.set(event.sessionId, turnId)
        const content: ContentBlock[] = event.data.prompt
          ? [{ type: 'text', text: event.data.prompt }]
          : []
        return [
          {
            ...envelope(event),
            name: 'turn.started',
            scope: threadScope(event.sessionId),
            payload: {
              turn: { turnId, threadId: event.sessionId, state: 'running' },
              userMessage: {
                messageId: event.data.userMessageId,
                threadId: event.sessionId,
                turnId,
                role: 'user',
                content,
              },
            },
          },
        ]
      }
      case 'prompt_completed': {
        const turnId = turnIdFor(event)
        turns.delete(event.sessionId)
        const interrupted = !!event.data.stopReason && INTERRUPTED_STOP.test(event.data.stopReason)
        return [
          {
            ...envelope(event),
            name: interrupted ? 'turn.interrupted' : 'turn.completed',
            scope: threadScope(event.sessionId),
            payload: { turnId },
          },
        ]
      }
      case 'agent_message_chunk': {
        const turnId = turnIdFor(event)
        return [
          {
            ...envelope(event),
            name: 'message.delta',
            scope: threadScope(event.sessionId),
            payload: {
              messageId: event.messageId ?? event.data.messageId ?? turnId,
              turnId,
              role: 'assistant',
              content: event.data.content,
            },
          },
        ]
      }
      case 'agent_thought_chunk': {
        const turnId = turnIdFor(event)
        return [
          {
            ...envelope(event),
            name: 'message.reasoning',
            scope: threadScope(event.sessionId),
            payload: {
              messageId: event.messageId ?? event.data.messageId ?? turnId,
              turnId,
              phase: event.data.phase,
              ...(event.data.content ? { content: event.data.content } : {}),
              ...(event.data.tokens !== undefined ? { tokens: event.data.tokens } : {}),
            },
          },
        ]
      }
      case 'tool_call':
      case 'tool_call_update':
        return [
          {
            ...envelope(event),
            name: 'tool.updated',
            scope: threadScope(event.sessionId),
            payload: {
              toolCallId: event.data.toolCallId,
              turnId: turnIdFor(event),
              ...(event.data.title !== undefined ? { title: event.data.title } : {}),
              ...(event.data.kind ? { kind: event.data.kind } : {}),
              ...(event.data.status ? { status: event.data.status } : {}),
            },
          },
        ]
      case 'permission_request':
        return requested(event, {
          kind: 'permission',
          interactionId: event.data.requestId,
          toolCall: {
            toolCallId: event.data.toolCall.toolCallId,
            title: event.data.toolCall.title,
            ...(event.data.toolCall.kind ? { kind: event.data.toolCall.kind } : {}),
          },
          options: event.data.options,
          ...(event.data.expiresAt ? { expiresAt: event.data.expiresAt } : {}),
        })
      case 'permission_resolved':
        return resolved(event, {
          kind: 'permission',
          interactionId: event.data.requestId,
          outcome: event.data.outcome,
        })
      case 'question_request':
        return requested(event, {
          kind: 'question',
          interactionId: event.data.requestId,
          ...(event.data.title !== undefined ? { title: event.data.title } : {}),
          questions: event.data.questions,
        })
      case 'question_resolved':
        return resolved(event, {
          kind: 'question',
          interactionId: event.data.requestId,
          outcome: event.data.outcome,
        })
      case 'plan_review_request':
        return requested(event, {
          kind: 'plan',
          interactionId: event.data.requestId,
          ...(event.data.name !== undefined ? { name: event.data.name } : {}),
          ...(event.data.overview !== undefined ? { overview: event.data.overview } : {}),
          markdown: event.data.markdown,
          todos: event.data.todos,
          ...(event.data.phases ? { phases: event.data.phases } : {}),
          continuation: event.data.continuation,
        })
      case 'plan_review_resolved':
        return resolved(event, {
          kind: 'plan',
          interactionId: event.data.requestId,
          outcome: event.data.outcome,
        })
      case 'rpc_error':
      case 'runtime_error':
        // A recoverable error means the turn is still running; see
        // `isRecoverableError` in @agentpack/contract.
        if (isRecoverableError(event) || !event.sessionId) return []
        return failure(
          { ...event, sessionId: event.sessionId },
          'provider_error',
          event.data.message,
        )
      case 'auth_required':
        if (!event.sessionId) return []
        return failure(
          { ...event, sessionId: event.sessionId },
          'authentication_required',
          event.data.message,
        )
      case 'capability_missing':
        if (!event.sessionId) return []
        return failure(
          { ...event, sessionId: event.sessionId },
          'capability_missing',
          event.data.message,
        )
      case 'process_exited': {
        if (!event.sessionId || event.data.expected) return []
        const crashed = event.data.exitCode !== 0 && event.data.exitCode !== null
        return failure(
          { ...event, sessionId: event.sessionId },
          crashed ? 'provider_process_crashed' : 'provider_process_exited',
          crashed
            ? `The provider process exited with code ${event.data.exitCode}.`
            : 'The provider process exited.',
        )
      }
      default:
        // Composer/runtime state (models, modes, config, usage, commands),
        // provider lifecycle, extensions, plan checklists and subtasks have no
        // protocol event yet; the legacy providers keep consuming them.
        return []
    }
  }

  return {
    translate,
    activeTurnId: (sessionId) => turns.get(sessionId) ?? null,
    adoptTurn: (sessionId, turnId) => {
      turns.set(sessionId, turnId)
    },
  }
}
