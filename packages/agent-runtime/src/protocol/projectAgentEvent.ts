import type {
  AgentEvent,
  ProviderNotice,
  ProviderProblem,
  ProviderProblemCode,
} from '@agentpack/contract'
import {
  ProofEventSchema,
  TimestampSchema,
  TURN_NOTICE_TEXT_MAX,
  type ProofEvent,
  type SubscriptionScope,
  type TurnFailureReason,
  type TurnRecoveryAction,
} from '@openmanager/protocol'

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
  const failed = (
    reason: TurnFailureReason = context.failureReason ?? 'provider_error',
    recovery: { action?: TurnRecoveryAction; resetsAt?: string } = {},
  ) =>
    emit('turn.failed', threadScope, {
      turnId: required('turnId'),
      reason,
      message: failureMessage(reason),
      ...recovery,
    })
  /** A failure the provider typed: its reason, and what can be done about it. */
  const failedWith = (problem: ProviderProblem) => {
    const action = problem.action ?? defaultAction(problem.code)
    const resetsAt = timestamp(problem.resetsAt)
    return failed(reasonOf(problem.code), {
      ...(action ? { action } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    })
  }
  const notice = (data: ProviderNotice) => {
    const resetsAt = timestamp(data.resetsAt)
    return emit(data.kind === 'compacting' ? 'turn.notice' : 'turn.notice.recorded', threadScope, {
      noticeId: context.eventId,
      turnId: required('turnId'),
      kind: data.kind,
      message: clip(data.message, TURN_NOTICE_TEXT_MAX),
      ...(data.detail ? { detail: clip(data.detail, TURN_NOTICE_TEXT_MAX) } : {}),
      ...(data.model
        ? {
            model: {
              ...(data.model.from ? { from: clip(data.model.from, 256) } : {}),
              to: clip(data.model.to, 256),
            },
          }
        : {}),
      ...(data.compaction ? { compaction: data.compaction } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    })
  }
  /** The provider is retrying; say so, and how far it has got. */
  const retrying = (problem: ProviderProblem | undefined) => {
    const retry = problem?.retry
    const cause = problem ? retryCause(problem.code) : undefined
    const delay = retry?.delayMs
    const due = delay === undefined ? Number.NaN : Date.parse(source.timestamp) + delay
    return emit('turn.notice', threadScope, {
      noticeId: context.eventId,
      turnId: required('turnId'),
      kind: 'retrying',
      message: retryMessage(problem),
      ...(retry && retry.attempt > 0
        ? {
            retry: {
              attempt: Math.floor(retry.attempt),
              ...(retry.maxAttempts && retry.maxAttempts > 0
                ? { maxAttempts: Math.floor(retry.maxAttempts) }
                : {}),
              ...(cause ? { cause } : {}),
              ...(Number.isFinite(due) ? { retryAt: new Date(due).toISOString() } : {}),
            },
          }
        : {}),
    })
  }

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
      // Provider diagnostics stay host-side: only the typed problem crosses.
      // A recoverable error must not end a turn.
      if (!context.turnId) return null
      if (source.data.recoverable) return retrying(source.data.problem)
      return source.data.problem && !context.failureReason
        ? failedWith(source.data.problem)
        : failed()
    case 'auth_required':
      if (!context.turnId) return null
      return failed('authentication_required', { action: 'sign_in' })
    case 'provider_notice':
      if (!context.turnId) return null
      return notice(source.data)
    case 'capability_missing':
      if (!context.turnId) return null
      return failed('capability_missing')
    case 'tool_call_content':
    case 'plan_update':
    case 'subtask_update':
    case 'current_model_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'usage_update':
    case 'available_commands_update':
    // Task ids are the provider's; the host announces the roster under its own.
    case 'background_tasks_update':
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
    case 'context_window_exceeded':
      return "The conversation is too long for the model's context window."
    case 'usage_limit':
      return "You've reached your usage limit."
    case 'rate_limited':
      return 'The provider is rate limiting requests.'
    case 'overloaded':
      return 'The provider is overloaded right now.'
    case 'refused':
      return 'The model declined this request.'
  }
}

function reasonOf(code: ProviderProblemCode): TurnFailureReason {
  switch (code) {
    case 'unauthorized':
      return 'authentication_required'
    case 'context_window_exceeded':
    case 'usage_limit':
    case 'rate_limited':
    case 'overloaded':
    case 'refused':
      return code
    case 'server_error':
    case 'network':
    case 'unknown':
      return 'provider_error'
  }
}

/** What helps, when the provider did not say: a passing condition is worth
 * another try, and a signed-out provider needs signing in. Compacting is the
 * provider's own call, since not every provider can. */
function defaultAction(code: ProviderProblemCode): TurnRecoveryAction | undefined {
  switch (code) {
    case 'unauthorized':
      return 'sign_in'
    case 'rate_limited':
    case 'overloaded':
    case 'server_error':
    case 'network':
      return 'retry'
    default:
      return undefined
  }
}

function retryCause(code: ProviderProblemCode): TurnFailureReason | undefined {
  switch (code) {
    case 'rate_limited':
    case 'overloaded':
      return code
    case 'server_error':
    case 'network':
      return 'provider_error'
    default:
      return undefined
  }
}

function retryMessage(problem: ProviderProblem | undefined): string {
  const retry = problem?.retry
  if (!problem || !retry) return 'The turn is recovering from a temporary error.'
  const why =
    problem.code === 'overloaded'
      ? 'the provider was overloaded'
      : problem.code === 'rate_limited'
        ? 'a rate limit'
        : problem.code === 'network'
          ? 'a connection error'
          : problem.code === 'server_error'
            ? 'a server error'
            : 'a temporary error'
  const of = retry.maxAttempts ? ` of ${retry.maxAttempts}` : ''
  return `Retrying after ${why} (attempt ${retry.attempt}${of})`
}

/** Provider prose is cut, never refused: a long line must not cost the event. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`
}

/** A provider's time, only if it is one the protocol accepts. */
function timestamp(value: string | undefined): string | undefined {
  return value !== undefined && TimestampSchema.safeParse(value).success ? value : undefined
}
