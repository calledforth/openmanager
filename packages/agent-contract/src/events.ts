import type { CapabilityKey, ProviderCapabilities } from './capabilities.js'
import type {
  PermissionCancellationReason,
  PermissionOutcome,
  PermissionRequest,
} from './permissions.js'
import type { PlanDocument } from './plans.js'
import type { QuestionRequest } from './questions.js'
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
  | 'permission_request'
  | 'permission_resolved'
  | 'question_request'
  | 'plan_review_request'
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

export type RpcErrorData = {
  source: string
  message: string
  code?: number
  recoverable?: boolean
  details?: unknown
}

export type RuntimeErrorData = {
  kind: 'transport' | 'process' | 'protocol' | 'provider' | 'validation' | 'unknown'
  message: string
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
        data: StreamedMessageChunk
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
        event: 'question_request'
        sessionId: string
        data: QuestionRequest
      }
    | {
        category: 'session'
        event: 'plan_review_request'
        sessionId: string
        data: PlanDocument
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
