import type {
  AgentEvent,
  ProviderNotice,
  ProviderProblem,
  ProviderProblemCode,
} from '@agentpack/contract'
import {
  TURN_FAILURE_MESSAGES,
  ProofEventSchema,
  TimestampSchema,
  isSettledToolStatus,
  type ProofEvent,
  type SubscriptionScope,
  type ToolCallUpdate,
  type TurnFailureReason,
  type TurnRecoveryAction,
} from '@openmanager/protocol'

import {
  contentText,
  isPathOnly,
  ToolCallTracker,
  toolFields,
  toolOutputText,
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
   * The turn's state once a resolved request is settled: `waiting` while
   * another request of the turn is still open. The host knows its open
   * requests; a request always leaves its turn `waiting`.
   */
  turnState?: 'running' | 'waiting'
  /**
   * The turn's tool calls so far: running text streams as deltas, a declined
   * permission reads as such, and the text a call settles with is left here
   * for the host to store. Without one, the text of a settled call is lost.
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
      turnState: 'waiting',
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
        turnState: requiredTurnState(),
      },
    )
  const requiredTurnState = () => {
    if (!context.turnState) throw new Error('Protocol projection requires host turnState')
    return context.turnState
  }
  const failed = (
    reason: TurnFailureReason = context.failureReason ?? 'provider_error',
    recovery: { action?: TurnRecoveryAction; resetsAt?: string; detail?: string } = {},
  ) =>
    emit('turn.failed', threadScope, {
      turnId: required('turnId'),
      reason,
      message: failureMessage(reason),
      ...exitRecovery(reason),
      ...recovery,
    })
  /** A failure the provider typed: its reason, and what can be done about it. */
  const failedWith = (problem: ProviderProblem) => {
    const action = problem.action ?? defaultAction(problem.code)
    const resetsAt = timestamp(problem.resetsAt)
    const detail = problem.detail?.trim()
    return failed(reasonOf(problem.code), {
      ...(action ? { action } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      ...(detail ? { detail } : {}),
    })
  }
  const notice = (data: ProviderNotice) => {
    const { resetsAt: reset, ...fields } = data
    const resetsAt = timestamp(reset)
    return emit(data.kind === 'compacting' ? 'turn.notice' : 'turn.notice.recorded', threadScope, {
      noticeId: context.eventId,
      turnId: required('turnId'),
      ...fields,
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
        return emit('turn.interrupted', threadScope, { turnId: required('turnId'), reason: 'user' })
      }
      return failed(context.failureReason ?? 'provider_process_exited')
    case 'session_created':
      // The whole row, in the canonical form a listing reads back (§4.7.2).
      return emit('session.created', environmentScope, {
        session: {
          sessionId: context.sessionId,
          workspaceId: context.workspaceId,
          title: context.sessionTitle ?? null,
          status: 'idle',
          providerId: source.providerId,
          updatedAt: new Date(Date.parse(source.timestamp)).toISOString(),
          settledAt: null,
          doneAt: null,
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
        turn: { turnId, threadId: context.threadId, state: 'running', startedAt: source.timestamp },
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
          startedAt: source.timestamp,
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
          // An interrupt a provider reports is the user's: a restart never reaches here.
          ...(state === 'interrupted' ? { reason: 'user' } : {}),
          ...(state === 'failed'
            ? {
                reason: context.failureReason ?? 'provider_error',
                message: failureMessage(context.failureReason ?? 'provider_error'),
                ...exitRecovery(context.failureReason ?? 'provider_error'),
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
      const tracker = context.toolCalls ?? new ToolCallTracker()
      const held = tracker.known(toolCallId)
      const kind = source.data.kind ?? held.kind
      const fields = toolFields(source.data, {
        kind,
        toolName: held.toolName,
        // The first event of a call opens it, whichever kind of event it is.
        opens: source.event === 'tool_call' || !tracker.has(toolCallId),
        timestamp: source.timestamp,
      })
      if (fields.status === 'failed') {
        if (tracker.isDeclined(toolCallId)) fields.status = 'declined'
        else if (context.interruptRequested) fields.status = 'cancelled'
      }
      const settled = isSettledToolStatus(fields.status)
      const text = toolOutputText(source.data, {
        pathOnly: isPathOnly(kind, fields.toolName ?? held.toolName, held.title ?? fields.title),
        failed: fields.status === 'failed' || fields.status === 'declined',
      })
      let output: Pick<ToolCallUpdate, 'output' | 'outputDelta'> = {}
      if (text !== undefined) {
        if (settled) tracker.settleWith(toolCallId, text)
        else output = tracker.replace(toolCallId, text)
      }
      // A resend repeats everything it said before. Text alone is a bare delta.
      const news = output.outputDelta === undefined ? fields : tracker.changed(toolCallId, fields)
      tracker.observe(toolCallId, fields)
      const outputBytes = settled ? tracker.outputBytes(toolCallId) : 0
      return emit('tool.updated', threadScope, {
        toolCallId,
        turnId: required('turnId'),
        ...news,
        ...output,
        ...(outputBytes > 0 ? { outputBytes } : {}),
      })
    }
    case 'tool_call_content': {
      // Appended text. Anything else (an image, a diff, a terminal handle) has
      // no place in a tool's output.
      const text = contentText(source.data.item)
      if (!text) return null
      const toolCallId = required('toolCallId')
      const tracker = context.toolCalls ?? new ToolCallTracker()
      const held = tracker.known(toolCallId)
      // A file's content is never output.
      if (isPathOnly(held.kind, held.toolName, held.title)) return null
      const output = tracker.append(toolCallId, text)
      if (output.outputDelta === undefined) return null
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
    case 'plan_update':
    case 'subtask_update':
    case 'current_model_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'usage_update':
    // Provider-wide: the server folds it into the provider's limits.
    case 'usage_limits_update':
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
  return TURN_FAILURE_MESSAGES[reason]
}

/** A provider process that went away comes back for the next prompt. */
function exitRecovery(reason: TurnFailureReason): { action?: TurnRecoveryAction } {
  return reason === 'provider_process_crashed' || reason === 'provider_process_exited'
    ? { action: 'retry' }
    : {}
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

/** A provider's time, only if it is one the protocol accepts. */
function timestamp(value: string | undefined): string | undefined {
  return value !== undefined && TimestampSchema.safeParse(value).success ? value : undefined
}
