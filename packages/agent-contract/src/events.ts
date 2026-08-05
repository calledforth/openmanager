import type { CapabilityKey, ProviderCapabilities } from './capabilities.js'
import type {
  PermissionCancellationReason,
  PermissionOutcome,
  PermissionRequest,
} from './permissions.js'
import type { PlanDocument, PlanReviewOutcome } from './plans.js'
import type { QuestionOutcome, QuestionRequest } from './questions.js'
import type { ModeListing, ModelListing, ProviderId } from './providers.js'

export type AgentEventCategory =
  'lifecycle' | 'stream' | 'tool' | 'permission' | 'session' | 'extension' | 'error'

export type AgentEventName =
  | 'process_spawned'
  | 'process_exited'
  | 'initialized'
  | 'authenticated'
  | 'session_created'
  | 'session_loaded'
  | 'session_deleted'
  | 'prompt_started'
  | 'prompt_completed'
  | 'user_message_chunk'
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'tool_call_content'
  | 'plan_update'
  | 'subtask_update'
  | 'permission_request'
  | 'permission_resolved'
  | 'question_request'
  /** Emitted for every settlement of a question — answered, cancelled or timed
   * out — whatever transport carried it. Questions used to be cleared off
   * `extension_resolved`, which only exists for providers that drive them
   * through ACP's `_ext` methods; anything else (an SDK permission callback,
   * say) left the row pending forever in the host map, in Convex and on mobile. */
  | 'question_resolved'
  | 'plan_review_request'
  /** See `question_resolved`. Carries the semantic review outcome rather than a
   * provider-native wire response, so consumers persisting the result do not
   * have to sniff the shape of somebody else's payload. */
  | 'plan_review_resolved'
  | 'current_model_update'
  | 'current_mode_update'
  | 'config_option_update'
  | 'session_info_update'
  | 'usage_update'
  | 'available_commands_update'
  | 'extension_request'
  | 'extension_resolved'
  | 'extension_notification'
  | 'rpc_error'
  | 'runtime_error'
  | 'auth_required'
  | 'capability_missing'

export type AgentEventBase = {
  id: string
  threadId: string
  /** Stable host-owned message identity shared by live rendering and persistence. */
  messageId?: string
  seq: number
  timestamp: string
  providerId: ProviderId
  workspaceId?: string
  sessionId?: string
}

export type AgentInfo = {
  name: string
  version?: string
}

export type AuthMethod = {
  id: string
  displayName: string
  description?: string
}

/** How a UI-answerable extension request was settled. Cancellation reuses the
 * permission cancellation vocabulary (timeout, session_closed, ...). */
export type ExtensionOutcome =
  | { outcome: 'responded'; response: unknown }
  | { outcome: 'cancelled'; reason?: PermissionCancellationReason }

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'audio'; mimeType: string; data: string }
  | {
      type: 'resource_link'
      uri: string
      name?: string
      mimeType?: string
    }
  | {
      type: 'resource'
      uri?: string
      mimeType?: string
      text?: string
      data?: string
    }

export type PromptCapabilities = {
  image?: boolean
  audio?: boolean
  embeddedContext?: boolean
}

/** Metadata safe to persist and relay; attachment bytes are resolved only at the backend. */
export type PromptAttachment = {
  id: string
  name: string
  mimeType: string
  size: number
}

export type PromptInput = {
  text: string
  blocks: ContentBlock[]
  attachments?: PromptAttachment[]
}

export type StreamedMessageChunk = {
  messageId?: string
  content: ContentBlock
}

/** Reasoning is not always text.
 *
 * ACP providers (Cursor, OpenCode) stream thinking as ordinary text blocks, so
 * `content` carries everything there is to show. Claude Code does not: its
 * `thinking` content blocks are live-verified to carry an ALWAYS-EMPTY string
 * (on claude-opus-5 and claude-sonnet-5 alike — the payload is an encrypted
 * ~1.3 KB `signature`). The only observable signals it emits are the block's
 * start/stop timing and a running `estimated_tokens` count. A reasoning
 * representation built on text alone therefore renders those 3-8 second blocks
 * as a total freeze.
 *
 * Hence both fields are optional and `phase` is not:
 * - `content` is absent whenever the provider has no text to give.
 * - `tokens` is the provider's running estimate. It is MONOTONIC — a cumulative
 *   total, not an increment — so consumers must take `Math.max(previous, next)`
 *   and must test `tokens !== undefined` rather than truthiness, because
 *   `tokens: 0` is a real first reading.
 * - `phase` is required and load-bearing. Emitting nothing at block stop cannot
 *   close a UI part, so a run interrupted between blocks would shimmer forever;
 *   `stop` is the only thing that can settle a reasoning part whose text is
 *   empty. Providers that stream text and have no block framing send `delta`. */
export type ThoughtChunk = {
  messageId?: string
  phase: 'start' | 'delta' | 'stop'
  content?: ContentBlock
  tokens?: number
}

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type ToolCallLocation = {
  path: string
  line?: number
}

export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }

export type ToolCall = {
  toolCallId: string
  title: string
  kind?: ToolKind
  status?: ToolCallStatus
  rawInput?: unknown
  rawOutput?: unknown
  content?: ToolCallContent[]
  locations?: ToolCallLocation[]
  metadata?: Record<string, unknown>
}

export type ToolCallUpdate = {
  toolCallId: string
  title?: string
  kind?: ToolKind
  status?: ToolCallStatus
  rawInput?: unknown
  rawOutput?: unknown
  content?: ToolCallContent[]
  locations?: ToolCallLocation[]
  metadata?: Record<string, unknown>
}

export type PlanEntryPriority = 'high' | 'medium' | 'low'
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed'

export type PlanEntry = {
  content: string
  priority: PlanEntryPriority
  status: PlanEntryStatus
}

export type PlanUpdate = {
  entries: PlanEntry[]
  explanation?: string | null
}

export type SubtaskStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'

export type SubtaskStatusSource = 'task_event' | 'turn_result'

/** Incremental update for one delegated child-agent task. Updates sharing a
 * taskId merge onto the same subtask; undefined fields keep their prior value. */
export type SubtaskUpdate = {
  /** Provider-stable task identity (the delegating tool call's id). */
  taskId: string
  status?: SubtaskStatus
  /** Provider event used to establish the status, retained for diagnostics. */
  statusSource?: SubtaskStatusSource
  /** Provider-supplied status detail such as a turn stop reason or tool error. */
  statusReason?: string
  title?: string
  description?: string
  prompt?: string
  subagentType?: string
  modelId?: string
  /** Set only when the provider exposes the child as a loadable session. */
  childSessionId?: string
  durationMs?: number
  resultText?: string
  /** Latest child activity, for providers that stream it (e.g. Claude Code). */
  currentActivity?: string
  toolCallCount?: number
}

export type AvailableCommandInput = {
  type: 'unstructured'
  placeholder?: string
}

export type AvailableCommand = {
  name: string
  description: string
  input?: AvailableCommandInput
}

export type SessionConfigCategory = 'mode' | 'model' | 'thought_level' | (string & {})

export type SessionConfigSelectValue = {
  value: string
  name: string
  description?: string
}

export type SessionConfigOption =
  | {
      type: 'select'
      id: string
      name: string
      description?: string
      category?: SessionConfigCategory
      currentValue: string
      options: SessionConfigSelectValue[]
    }
  | {
      type: 'boolean'
      id: string
      name: string
      description?: string
      category?: SessionConfigCategory
      currentValue: boolean
    }

export type TokenUsage = {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  thoughtTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
}

export type SessionCost = {
  amount: number
  currency: string
}

export type SessionUsage = {
  used: number
  size: number
  cost?: SessionCost
}

/** `recoverable: true` is a statement about the TURN, not about the process.
 *
 * It means: the operation that failed is being retried and the turn this error
 * belongs to is still running, so more of its output is still coming. Every
 * consumer that performs terminal cleanup on an error — closing the assistant
 * message, finalizing the persisted turn, marking running tool rows failed,
 * dropping the composer out of its running state — MUST skip that cleanup when
 * this flag is set, because the turn will still emit its own `prompt_completed`
 * (or a real terminal error) afterwards. Treating a retry as terminal
 * permanently truncates the answer: every later event in the turn arrives with
 * the message id already released and is dropped.
 *
 * An error that ends the turn must NOT set it, even when the *runtime* could be
 * respawned afterwards — "we can start another process" is not the same claim. */
export type RpcErrorData = {
  source: string
  message: string
  code?: number
  /** See the note above `RpcErrorData`: the turn survives this error. */
  recoverable?: boolean
  details?: unknown
}

export type RuntimeErrorData = {
  kind: 'transport' | 'process' | 'protocol' | 'provider' | 'validation' | 'unknown'
  message: string
  /** See the note above `RpcErrorData`: the turn survives this error. */
  recoverable?: boolean
  details?: unknown
}

export type AgentEvent = AgentEventBase &
  (
    | {
        category: 'lifecycle'
        event: 'process_spawned'
        data: {
          cwd?: string
          command?: string
          args?: string[]
          processId?: number
        }
      }
    | {
        category: 'lifecycle'
        event: 'process_exited'
        data: { exitCode: number | null; signal?: string; expected: boolean }
      }
    | {
        category: 'lifecycle'
        event: 'initialized'
        data: {
          protocolVersion?: string
          agentInfo?: AgentInfo
          capabilities: ProviderCapabilities
          promptCapabilities?: PromptCapabilities
          authMethods: AuthMethod[]
        }
      }
    | {
        category: 'lifecycle'
        event: 'authenticated'
        data: { methodId?: string }
      }
    | {
        category: 'lifecycle'
        event: 'session_created'
        sessionId: string
        data: {
          models?: ModelListing
          modes?: ModeListing
          configOptions?: SessionConfigOption[]
        }
      }
    | {
        category: 'lifecycle'
        event: 'session_loaded'
        sessionId: string
        data: {
          models?: ModelListing
          modes?: ModeListing
          configOptions?: SessionConfigOption[]
        }
      }
    | {
        category: 'lifecycle'
        event: 'session_deleted'
        sessionId: string
        data: Record<string, never>
      }
    | {
        category: 'lifecycle'
        event: 'prompt_started'
        sessionId: string
        data: { prompt: string; userMessageId: string; attachments?: PromptAttachment[] }
      }
    | {
        category: 'lifecycle'
        event: 'prompt_completed'
        sessionId: string
        data: { stopReason?: string; usage?: TokenUsage }
      }
    | {
        category: 'stream'
        event: 'user_message_chunk'
        sessionId: string
        data: StreamedMessageChunk
      }
    | {
        category: 'stream'
        event: 'agent_message_chunk'
        sessionId: string
        data: StreamedMessageChunk
      }
    | {
        category: 'stream'
        event: 'agent_thought_chunk'
        sessionId: string
        data: ThoughtChunk
      }
    | {
        category: 'tool'
        event: 'tool_call'
        sessionId: string
        data: ToolCall
      }
    | {
        category: 'tool'
        event: 'tool_call_update'
        sessionId: string
        data: ToolCallUpdate
      }
    | {
        category: 'tool'
        event: 'tool_call_content'
        sessionId: string
        data: { toolCallId: string; item: ToolCallContent }
      }
    | {
        category: 'session'
        event: 'plan_update'
        sessionId: string
        data: PlanUpdate
      }
    | {
        category: 'session'
        event: 'subtask_update'
        sessionId: string
        data: SubtaskUpdate
      }
    | {
        category: 'permission'
        event: 'permission_request'
        sessionId: string
        data: PermissionRequest
      }
    | {
        category: 'permission'
        event: 'permission_resolved'
        sessionId: string
        data: { requestId: string; outcome: PermissionOutcome }
      }
    | {
        category: 'session'
        event: 'question_request'
        sessionId: string
        data: QuestionRequest
      }
    | {
        category: 'session'
        event: 'question_resolved'
        sessionId: string
        data: { requestId: string; outcome: QuestionOutcome }
      }
    | {
        category: 'session'
        event: 'plan_review_request'
        sessionId: string
        data: PlanDocument
      }
    | {
        category: 'session'
        event: 'plan_review_resolved'
        sessionId: string
        data: { requestId: string; outcome: PlanReviewOutcome }
      }
    | {
        category: 'session'
        event: 'current_model_update'
        sessionId: string
        data: ModelListing
      }
    | {
        category: 'session'
        event: 'current_mode_update'
        sessionId: string
        data: ModeListing
      }
    | {
        category: 'session'
        event: 'config_option_update'
        sessionId: string
        data: { configOptions: SessionConfigOption[] }
      }
    | {
        category: 'session'
        event: 'session_info_update'
        sessionId: string
        data: { title?: string | null; updatedAt?: string | null }
      }
    | {
        category: 'session'
        event: 'usage_update'
        sessionId: string
        data: SessionUsage
      }
    | {
        category: 'session'
        event: 'available_commands_update'
        sessionId: string
        data: { availableCommands: AvailableCommand[] }
      }
    | {
        category: 'extension'
        event: 'extension_request'
        sessionId: string
        data: { requestId: string; method: string; params: unknown }
      }
    | {
        category: 'extension'
        event: 'extension_resolved'
        sessionId: string
        data: { requestId: string; method: string; outcome: ExtensionOutcome }
      }
    | {
        category: 'extension'
        event: 'extension_notification'
        sessionId: string
        data: { method: string; params: unknown }
      }
    | { category: 'error'; event: 'rpc_error'; data: RpcErrorData }
    | { category: 'error'; event: 'runtime_error'; data: RuntimeErrorData }
    | {
        category: 'error'
        event: 'auth_required'
        data: {
          message: string
          authMethods?: AuthMethod[]
          loginHint?: string
        }
      }
    | {
        category: 'error'
        event: 'capability_missing'
        data: {
          capability: CapabilityKey
          operation: string
          message: string
        }
      }
  )

/** Is this error one the turn survives?
 *
 * The single predicate every terminal-cleanup site shares, so the four
 * consumers that close a turn on an error — `AgentRuntime.forward`, the Convex
 * projector, the live renderer and the composer's status tracking — cannot
 * drift apart. Anything that is not an error event is not recoverable: the
 * question only has meaning for the two error shapes that carry the flag.
 *
 * Takes the loose `BackendEvent`-shaped object rather than a narrowed
 * `AgentEvent` so it can be called before an event is stamped, where the union
 * has been collapsed and `data` cannot be narrowed by `event`. */
export function isRecoverableError(event: {
  event: AgentEventName
  data?: unknown
}): boolean {
  if (event.event !== 'rpc_error' && event.event !== 'runtime_error') return false
  return (event.data as { recoverable?: unknown } | undefined)?.recoverable === true
}
