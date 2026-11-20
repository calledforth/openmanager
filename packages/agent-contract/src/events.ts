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
  /** A turn the provider began by itself, with no user prompt behind it: a
   * background task finished and the agent woke to act on the result. It ends
   * with the same `prompt_completed` (or terminal error) a prompted turn does. */
  | 'background_turn_started'
  /** A message sent into a running turn (`steer`) was taken by the provider:
   * the agent reads it at its next step, inside that same turn. */
  | 'steer_delivered'
  /** The turn a steered message was sent into ended before the provider took
   * it, so the provider began a turn of its own for it. It ends with the same
   * `prompt_completed` (or terminal error) a prompted turn does. */
  | 'steer_turn_started'
  /** The provider gave a steered message back unread: the turn was stopped, or
   * the process went away. It will not run unless it is sent again. */
  | 'steer_withdrawn'
  /** The provider named its own id for the turn in flight (Codex's turn id),
   * as soon as it knows it. Optional: a provider without turn ids never sends
   * it. The host keeps the id beside its own turn, never on the wire, so
   * revert, fork and reconciliation can find the provider's turn again. */
  | 'turn_identified'
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
  | 'background_tasks_update'
  /** Something the provider said about the turn that the user should see:
   * the conversation was compacted, the model was switched or declined, a
   * usage limit is near, or a plain informational or warning line. See
   * `ProviderNotice`. Retries are not notices: they stay a recoverable
   * `rpc_error`, whose contract the terminal-cleanup sites depend on. */
  | 'provider_notice'
  /** A live session's word on one usage-limit window (Claude's
   * `rate_limit_event`, Codex's `account/rateLimits/updated`). Sparse; see
   * `UsageLimitObservation`. Provider-wide, not a turn's: consumers fold it
   * into the provider's limits. */
  | 'usage_limits_update'
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
  /**
   * Set when this event is the work of a subagent, not of the session's own
   * agent: the `taskId` of the `subtask_update` that names that subagent. The
   * host files the event in the subagent's child session instead of the
   * parent's transcript. Stream, tool, permission and question events can
   * carry it; a provider that cannot tell a subagent's work apart sends none.
   * See docs/decisions/subagents.md.
   */
  subtaskId?: string
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

/**
 * What an assistant message is, when its provider says: narration while the
 * agent works (`commentary`), or answer text (`partial_answer` for a piece of
 * it, `final_answer` for the answer the turn ends with). Codex marks every
 * assistant message so; providers that do not leave it out, and a client
 * guesses the answer from the turn's last run of text. A provider value
 * outside these is the adapter's to map or drop: the set is closed here.
 */
export type MessagePhase = 'commentary' | 'partial_answer' | 'final_answer'

export type StreamedMessageChunk = {
  /**
   * The provider's own id for the message (Codex: the agentMessage item id),
   * when it has one. Host-side only: the host keeps it beside the message it
   * files the chunk under, and never puts it on the wire.
   */
  messageId?: string
  content: ContentBlock
  /**
   * The phase of the assistant message this chunk belongs to. One message
   * has one phase: the host starts a new message where it changes. Only
   * `agent_message_chunk` carries it; a user chunk's is ignored.
   */
  phase?: MessagePhase
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
  /** The provider's own id for the reasoning block, as on `StreamedMessageChunk`. */
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

/** Why a call that did not complete ended, when the provider says. `status`
 * stays `failed` alongside it, so a consumer that predates the field still
 * reads the call as ended. */
export type ToolCallOutcome = 'declined' | 'cancelled'

/** Lines an edit added and removed, exactly as the provider reported them.
 * Never computed by diffing anything ourselves. */
export type ToolLineChanges = {
  added: number
  removed: number
}

/** What the provider says about a tool call beyond ACP's fields. All optional:
 * a provider that cannot say leaves them out. */
type ToolCallExtras = {
  /** The provider's own name for the tool (`Bash`, `mcp__github__search`),
   * separate from `title`, which may be prose. */
  toolName?: string
  outcome?: ToolCallOutcome
  lineChanges?: ToolLineChanges
}

export type ToolCall = ToolCallExtras & {
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

export type ToolCallUpdate = ToolCallExtras & {
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
  /** Provider-stable task identity, unique within the session. The runtime
   * picks it and keeps it for the subagent's whole life, revivals included:
   * Claude Code uses the spawning `Agent` tool call's id, which every frame of
   * the subagent carries as `parent_tool_use_id` even after a `SendMessage`
   * revives it. Events of the subagent's own work carry it as `subtaskId`. */
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
  /** The parent's tool call that started it; the card takes that call's place.
   * Defaults to `taskId` when the provider keys subagents by tool call. */
  toolCallId?: string
  /** The `taskId` of the subagent that started this one, for a nested one. */
  parentTaskId?: string
  /** 1 under the session's own agent, 2 under a subagent, and so on. */
  depth?: number
  /** True when it runs on after the turn that started it ended. */
  background?: boolean
  /** Running token total. */
  tokens?: number
  /** The provider's own id for the subagent, when it differs from `taskId`
   * (Claude Code's `agentId`). Diagnostics and history lookup only. */
  providerTaskId?: string
  /** Whether `stopSubtask` can stop it. */
  stoppable?: boolean
  /** Whether a person can prompt its child: true only when `childSessionId`
   * names a session the provider can load and prompt (OpenCode). */
  promptable?: boolean
}

/** What a background task is, in terms a client can label. Provider task types
 * drift between releases, so each provider maps its own onto these. */
export type BackgroundTaskKind = 'agent' | 'shell' | 'monitor' | 'workflow' | 'other'

/** Work the provider keeps running after the turn that started it has ended:
 * a backgrounded shell command, a subagent, a watch loop. */
export type BackgroundTask = {
  /** Provider-stable identity, and what a stop request names. */
  taskId: string
  kind: BackgroundTaskKind
  description: string
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

/** What kind of trouble a provider request ran into, when the provider says.
 *
 * Typed so a host can tell the user what happened and what to do about it
 * without parsing provider prose. `network` is a request that never got an
 * answer; `unknown` is a failure the provider did not classify. */
export type ProviderProblemCode =
  | 'unauthorized'
  | 'context_window_exceeded'
  | 'usage_limit'
  | 'rate_limited'
  | 'overloaded'
  | 'server_error'
  | 'network'
  | 'refused'
  | 'unknown'

/** What the user can do about a problem in the app: send the prompt again,
 * compact the conversation, or sign the provider in. */
export type ProviderRecoveryAction = 'retry' | 'compact' | 'sign_in'

export type ProviderProblem = {
  code: ProviderProblemCode
  /** Only the provider knows whether, say, compacting is something it can
   * do. Absent means the host's default for the code. */
  action?: ProviderRecoveryAction
  /** When a usage or rate limit lifts (ISO 8601), if the provider said. */
  resetsAt?: string
  /** On a recoverable error: how far through its retries the provider is. */
  retry?: { attempt: number; maxAttempts?: number; delayMs?: number }
  /** The provider's own explanation, for the user to read under the host's
   * message. Often actionable ("pick a different model"). */
  detail?: string
}

export type ProviderNoticeKind =
  /** Transient: the conversation is being compacted right now. */
  'compacting' | 'compacted' | 'model_fallback' | 'refusal' | 'usage_warning' | 'info' | 'warning'

/** A `provider_notice`. `message` is complete on its own; the structured
 * fields let a client say it better. Only `info`, `warning` and a refusal's
 * `detail` carry the provider's own prose. */
export type ProviderNotice = {
  kind: ProviderNoticeKind
  message: string
  detail?: string
  model?: { from?: string; to: string }
  compaction?: { trigger: 'manual' | 'auto'; tokensBefore?: number; tokensAfter?: number }
  /** On an `info` notice: the marker of a review turn (`TurnOperation`)
   * entering review mode, with what it reviews as the provider put it, or
   * leaving it, after which the turn's answer is the review's findings. */
  review?: { phase: 'started' | 'finished'; target?: string }
  /** When the limit a `usage_warning` is about resets (ISO 8601). */
  resetsAt?: string
}

/** One usage-limit window of a provider's plan, as a full read reports it. */
export type UsageLimitWindow = {
  /** Stable for the provider: `five_hour`, `seven_day`, `model:<name>`. */
  id: string
  label: string
  group: 'session' | 'weekly' | 'other'
  /** Percent used, 0–100; null when the provider gave no number. */
  usedPercent: number | null
  /** ISO 8601. */
  resetsAt: string | null
  status: 'ok' | 'warning' | 'limited' | null
}

/** Everything a provider said about its plan limits in one read. */
export type UsageLimitsReading = {
  windows: UsageLimitWindow[]
  extraUsage: { enabled: boolean; usedPercent: number | null } | null
  /** The plan, as display text ("Plus"). Absent when the provider did not say. */
  plan?: string
  /** Prepaid credits (Codex). Absent for a provider without them. */
  credits?: { hasCredits: boolean; unlimited: boolean; balance: string | null }
}

/** What reading a provider's limits came to. `unavailable`: the account has
 * no plan limits (an API key, say); `unsupported`: this provider or CLI has no
 * way to report them. */
export type UsageLimitsResult =
  | { outcome: 'ok'; reading: UsageLimitsReading }
  | { outcome: 'unavailable' }
  | { outcome: 'unsupported' }

/** A `usage_limits_update`: what a live session said about one window. Sparse
 * on purpose: a field the provider did not state is absent, never guessed. */
export type UsageLimitObservation = {
  windowId: string
  label: string
  group: UsageLimitWindow['group']
  status?: 'ok' | 'warning' | 'limited'
  /** ISO 8601. */
  resetsAt?: string
  /** A lower bound on the percent used: the threshold the provider says was crossed. */
  usedPercentAtLeast?: number
  /** The percent used, exactly, when the provider states it (Codex's
   * `account/rateLimits/updated`). Replaces what was known. */
  usedPercent?: number
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
  /** What went wrong, typed, when the provider says. */
  problem?: ProviderProblem
  details?: unknown
}

export type RuntimeErrorData = {
  kind: 'transport' | 'process' | 'protocol' | 'provider' | 'validation' | 'unknown'
  message: string
  /** See the note above `RpcErrorData`: the turn survives this error. */
  recoverable?: boolean
  /** What went wrong, typed, when the provider says. */
  problem?: ProviderProblem
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
        event: 'background_turn_started'
        sessionId: string
        data: Record<string, never>
      }
    | {
        category: 'lifecycle'
        event: 'steer_delivered' | 'steer_turn_started' | 'steer_withdrawn'
        sessionId: string
        /** The id the caller gave the message when it steered it. */
        data: { steerId: string }
      }
    | {
        category: 'lifecycle'
        event: 'turn_identified'
        sessionId: string
        /** The provider's id for the turn, unique within its own thread. */
        data: { providerTurnId: string }
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
        /** Every live background task, whenever the set changes. REPLACE
         * semantics: an empty list means nothing is running any more. */
        category: 'session'
        event: 'background_tasks_update'
        sessionId: string
        data: { tasks: BackgroundTask[] }
      }
    | {
        category: 'session'
        event: 'provider_notice'
        sessionId: string
        data: ProviderNotice
      }
    | {
        category: 'session'
        event: 'usage_limits_update'
        sessionId: string
        data: UsageLimitObservation
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
export function isRecoverableError(event: { event: AgentEventName; data?: unknown }): boolean {
  if (event.event !== 'rpc_error' && event.event !== 'runtime_error') return false
  return (event.data as { recoverable?: unknown } | undefined)?.recoverable === true
}
