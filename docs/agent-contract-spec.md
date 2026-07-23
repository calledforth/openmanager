# `@agentpack/contract` specification

> Phase 0 output — drafted by gpt-5.6-sol (high) 2026-07-11 from Basis's ACP event contract,
> OpenManager's part taxonomy, and t3-code's canonical schema (reference only).
> Source prompt: agent-packages plan, Phase 0.

## Purpose

`@agentpack/contract` is a zero-dependency TypeScript package defining the normalized boundary between coding-agent providers, runtimes, persistence layers, and applications.

The package:

- Imports no provider SDK or ACP SDK.
- Uses ACP vocabulary such as session update, tool call, and permission request.
- Keeps provider-specific parsing inside provider adapters.
- Represents authentication and missing capabilities as typed variants.
- Uses capability flags for UI gating; applications must not branch on provider identity.
- Treats event objects as immutable transport records. Consumers may fold them into mutable presentation state.

Suggested package exports:

```json
{
  "name": "@agentpack/contract",
  "type": "module",
  "exports": {
    "./events": "./dist/events.js",
    "./parts": "./dist/parts.js",
    "./permissions": "./dist/permissions.js",
    "./capabilities": "./dist/capabilities.js",
    "./providers": "./dist/providers.js"
  }
}
```

## Global event invariants

1. `id` uniquely identifies an event for deduplication.
2. `threadId` identifies the application thread to which the event belongs.
3. `seq` is assigned by the runtime, is monotonically increasing within a thread, and is the primary ordering key.
4. `timestamp` is an ISO-8601 UTC timestamp and is informational; it is not the primary ordering key.
5. When two persisted records unexpectedly have the same `seq`, consumers may use `timestamp` and then `id` as deterministic tie-breakers.
6. Provider adapters must classify errors before emitting them. Applications must never infer `auth_required` or `capability_missing` by examining error-message text.
7. Collection updates such as plans, available commands, models, modes, and configuration options replace the previous collection unless their type explicitly says otherwise.

---

## `capabilities.ts`

```ts
/**
 * Stable names for provider features on which applications may gate UI.
 *
 * Every flag is required so that a missing property cannot be confused with
 * either `false` or an older provider implementation.
 */
export type ProviderCapabilities = {
  /** The session's model can be changed after session creation. */
  canSetModel: boolean;

  /** The session's operating mode can be changed after session creation. */
  canSetMode: boolean;

  /** Session configuration options can be changed. */
  canSetConfigOption: boolean;

  /** A persisted provider session can be deleted. */
  canDeleteSession: boolean;

  /** An existing provider session can be loaded or resumed. */
  canLoadSession: boolean;

  /** An in-flight prompt can be cancelled. */
  canCancelPrompt: boolean;

  /** The provider can publish ACP plan session updates. */
  supportsPlans: boolean;

  /** The provider can publish ACP available-commands session updates. */
  supportsAvailableCommands: boolean;

  /** The provider can publish context or token usage updates. */
  supportsUsage: boolean;

  /** The provider can issue ACP permission requests. */
  supportsPermissionRequests: boolean;

  /** The provider may require an explicit authentication flow. */
  supportsAuthentication: boolean;

  /** The provider can stream agent thought/reasoning chunks. */
  supportsThoughtStreaming: boolean;

  /** The provider can represent delegated or child-agent work. */
  supportsSubtasks: boolean;

  /** The provider can emit or receive provider-extension messages. */
  supportsExtensions: boolean;
};

/**
 * A capability name usable in typed `capability_missing` events.
 */
export type CapabilityKey =
  | "canSetModel"
  | "canSetMode"
  | "canSetConfigOption"
  | "canDeleteSession"
  | "canLoadSession"
  | "canCancelPrompt"
  | "supportsPlans"
  | "supportsAvailableCommands"
  | "supportsUsage"
  | "supportsPermissionRequests"
  | "supportsAuthentication"
  | "supportsThoughtStreaming"
  | "supportsSubtasks"
  | "supportsExtensions";
```

Rationale: required booleans make UI gating deterministic and prevent feature support from being inferred from provider identity or the presence of optional fields.

Rationale: `canSetConfigOption`, cancellation, permissions, thought streaming, commands, usage, subtasks, and extensions are included because the source integrations expose or consume those behaviors.

---

## `providers.ts`

```ts
import type { ProviderCapabilities } from "./capabilities.js";

/**
 * Providers built into this version of the package.
 *
 * A future package release extends this union when another adapter becomes
 * part of the public contract.
 */
export type ProviderId = "opencode" | "cursor";

/**
 * One model selectable within a provider.
 */
export type ModelOption = {
  /** Provider-defined stable identifier sent to the set-model operation. */
  id: string;

  /** Human-readable model-picker label. */
  displayName: string;

  /** Optional secondary text for the model picker. */
  description?: string;

  /** Context-window size when the provider reports it. */
  contextWindowTokens?: number;
};

/**
 * Current model state for a provider or session.
 */
export type ModelListing = {
  /**
   * Full known model collection.
   *
   * It may be absent on a current-model-only update.
   */
  availableModels?: ModelOption[];

  /** Currently selected provider model identifier. */
  currentModelId?: string;
};

/**
 * One operating mode selectable within a provider session.
 */
export type ModeOption = {
  /** Provider-defined stable identifier sent to the set-mode operation. */
  id: string;

  /** Human-readable mode-picker label. */
  displayName: string;

  /** Optional explanation of the mode's behavior. */
  description?: string;
};

/**
 * Current mode state for a provider or session.
 */
export type ModeListing = {
  /**
   * Full known mode collection.
   *
   * It may be absent on a current-mode-only update.
   */
  availableModes?: ModeOption[];

  /** Currently selected provider mode identifier. */
  currentModeId?: string;
};

/**
 * Provider metadata suitable for a provider-first model picker.
 */
export type ProviderMetadata = {
  id: ProviderId;
  displayName: string;
  description?: string;
  capabilities: ProviderCapabilities;

  /**
   * Provider-wide or most recently negotiated model state.
   *
   * Session events may subsequently replace it.
   */
  models?: ModelListing;

  /**
   * Provider-wide or most recently negotiated mode state.
   *
   * Session events may subsequently replace it.
   */
  modes?: ModeListing;
};

/**
 * Stable value returned by a provider-first model picker.
 */
export type ProviderModelSelection = {
  providerId: ProviderId;
  modelId: string;
};
```

Rationale: model and mode identifiers are scoped by `ProviderMetadata`, so duplicate model IDs across providers are harmless.

Rationale: `availableModels` and `availableModes` are optional because Basis sometimes emits only a newly selected ID after a set operation.

Rationale: `ProviderId` remains a closed union so exhaustive adapter switches fail at compile time when a future package release adds a provider.

---

## `permissions.ts`

```ts
/**
 * ACP-compatible semantic kinds for permission options.
 */
export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

/**
 * One provider-supplied choice in a permission request.
 */
export type PermissionOption = {
  /**
   * Opaque provider option ID.
   *
   * The selected value must be returned unchanged.
   */
  optionId: string;

  /** Human-readable button or menu label. */
  name: string;

  /** Stable semantic meaning used for ordering and presentation. */
  kind: PermissionOptionKind;
};

/**
 * Tool-call information included with a permission request.
 */
export type PermissionToolCall = {
  /** Correlates the request with `tool_call` and `tool_call_update` events. */
  toolCallId: string;

  /** Human-readable description of the proposed operation. */
  title: string;

  /** Provider or ACP tool category, when known. */
  kind?: string;

  /** Input which the user is being asked to approve. */
  rawInput?: unknown;
};

/**
 * A normalized ACP permission request.
 */
export type PermissionRequest = {
  /** Correlates an application response with this pending request. */
  requestId: string;

  /** Provider session in which the request was made. */
  sessionId: string;

  /** Tool-call correlation and presentation data. */
  toolCall: PermissionToolCall;

  /** Options in provider-supplied order. */
  options: PermissionOption[];

  /** Optional runtime timeout represented as an ISO-8601 UTC timestamp. */
  expiresAt?: string;

  /** Reserved provider metadata; applications must not require its contents. */
  metadata?: Record<string, unknown>;
};

/**
 * Why an unresolved permission request was cancelled.
 */
export type PermissionCancellationReason =
  "user" | "timeout" | "session_closed" | "tool_cancelled" | "runtime_disposed";

/**
 * Outcome returned to the runtime for a permission request.
 */
export type PermissionOutcome =
  | {
      outcome: "selected";

      /**
       * Opaque ID copied unchanged from one of the request's options.
       */
      optionId: string;
    }
  | {
      outcome: "cancelled";
      reason?: PermissionCancellationReason;
    };
```

Rationale: permission semantics retain ACP's underscore spellings because these values cross the adapter boundary and should not require cosmetic translation.

Rationale: authorization is returned as a selected opaque `optionId`, rather than duplicating the option kind in the response, because providers may attach provider-specific meaning to individual options.

Rationale: both `requestId` and `toolCallId` are mandatory and serve different correlations: response-to-request and request-to-tool-call.

---

## `parts.ts`

```ts
import type { ToolCallContent, ToolCallLocation, ToolCallStatus, ToolKind } from "./events.js";

/**
 * Fields shared by every normalized message part.
 */
export type MessagePartBase = {
  /** Stable identity used for deduplication and streaming replacement. */
  id: string;

  /** Owning message when parts are stored outside their message envelope. */
  messageId?: string;

  /** Owning provider session when parts are stored independently. */
  sessionId?: string;
};

/**
 * Displayable user or agent text.
 */
export type TextPart = MessagePartBase & {
  type: "text";
  text: string;

  /** Generated presentation text which may be hidden by default. */
  synthetic?: boolean;

  /** Text retained for history but intentionally excluded from rendering. */
  ignored?: boolean;
};

/**
 * Folded presentation state for an ACP tool call.
 */
export type ToolPart = MessagePartBase & {
  type: "tool";

  /** Correlates the part with tool-call events and permission requests. */
  toolCallId: string;

  /** Stable or provider-defined tool name. */
  tool: string;

  /** Human-readable operation title. */
  title: string;

  /** ACP tool category when known. */
  kind?: ToolKind;

  state: {
    status: ToolCallStatus;
    input?: unknown;
    output?: unknown;
    error?: string;
    metadata?: Record<string, unknown>;
  };

  /** Latest complete tool content collection. */
  content?: ToolCallContent[];

  /** Latest complete set of affected locations. */
  locations?: ToolCallLocation[];

  /** URLs extracted by an adapter or presenter for convenient rendering. */
  resultLinks?: string[];
};

/**
 * Streamed or completed agent reasoning.
 */
export type ReasoningPart = MessagePartBase & {
  type: "reasoning";
  text: string;
  time?: {
    /** Unix time in milliseconds. */
    start: number;

    /** Absent while reasoning is still streaming. */
    end?: number;
  };
};

/**
 * A visible retry boundary.
 */
export type RetryPart = MessagePartBase & {
  type: "retry";
  attempt: number;
  error?: string;
  retryAt?: string;
};

/**
 * Delegated or child-agent work.
 */
export type SubtaskPart = MessagePartBase & {
  type: "subtask";
  title?: string;
  description?: string;
  prompt?: string;
  status?: "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown";
  statusSource?: "task_event" | "turn_result";
  statusReason?: string;
  targetSessionId?: string;
  modelId?: string;
  subagentType?: string;
  durationMs?: number;
  resultText?: string;
  /** Latest child activity, for providers that stream it (e.g. Claude Code). */
  currentActivity?: string;
  toolCallCount?: number;
};

/**
 * A session context-compaction marker.
 */
export type CompactionPart = MessagePartBase & {
  type: "compaction";
  summary?: string;
  automatic?: boolean;
};

/**
 * Beginning of a provider-defined execution step.
 */
export type StepStartPart = MessagePartBase & {
  type: "step-start";
  stepId: string;
  title?: string;
  startedAt?: string;
};

/**
 * Completion of a provider-defined execution step.
 */
export type StepFinishPart = MessagePartBase & {
  type: "step-finish";
  stepId: string;
  status: "completed" | "failed" | "cancelled";
  finishedAt?: string;
  error?: string;
};

/**
 * Opaque provider snapshot retained for replay or restoration.
 */
export type SnapshotPart = MessagePartBase & {
  type: "snapshot";
  snapshotId: string;
  data: unknown;
};

/**
 * Provider or agent metadata that belongs in the message-part stream but has
 * no dedicated visual representation.
 */
export type AgentPart = MessagePartBase & {
  type: "agent";
  name?: string;
  sessionUpdate?: string;
  payload?: unknown;
};

/**
 * Complete message-part taxonomy.
 */
export type MessagePart =
  | TextPart
  | ToolPart
  | ReasoningPart
  | RetryPart
  | SubtaskPart
  | CompactionPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | AgentPart;
```

Rationale: the union has exactly the ten discriminants handled by the desktop and mobile OpenManager taxonomy; structural parts remain typed even when a renderer intentionally hides them.

Rationale: the contract uses `toolCallId`, matching ACP and Basis, rather than OpenManager's legacy `callID`; an OpenManager adapter can rename the field at its rendering boundary.

Rationale: tool updates are folded into a single `ToolPart`, while raw event history remains available through `AgentEvent` if an application needs an audit trail.

Rationale: `SnapshotPart.data` and `AgentPart.payload` remain `unknown` because their contents are provider-extension data; consumers must narrow them before use.

---

## `events.ts`

```ts
import type { CapabilityKey, ProviderCapabilities } from "./capabilities.js";
import type { PermissionRequest } from "./permissions.js";
import type { ModeListing, ModelListing, ProviderId } from "./providers.js";

/**
 * High-level event categories retained for activity filtering.
 */
export type AgentEventCategory =
  "lifecycle" | "stream" | "tool" | "permission" | "session" | "extension" | "error";

/**
 * Every event discriminant in this contract version.
 */
export type AgentEventName =
  | "process_spawned"
  | "process_exited"
  | "initialized"
  | "authenticated"
  | "session_created"
  | "session_loaded"
  | "session_deleted"
  | "prompt_started"
  | "prompt_completed"
  | "user_message_chunk"
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "tool_call"
  | "tool_call_update"
  | "tool_call_content"
  | "plan_update"
  | "subtask_update"
  | "permission_request"
  | "current_model_update"
  | "current_mode_update"
  | "config_option_update"
  | "session_info_update"
  | "usage_update"
  | "available_commands_update"
  | "extension_request"
  | "extension_notification"
  | "rpc_error"
  | "runtime_error"
  | "auth_required"
  | "capability_missing";

/**
 * Fields carried by every event.
 */
export type AgentEventBase = {
  /** Globally unique event ID used for deduplication. */
  id: string;

  /** Application thread receiving the event. */
  threadId: string;

  /**
   * Runtime-assigned monotonic sequence within `threadId`.
   *
   * This is the primary ordering key.
   */
  seq: number;

  /** ISO-8601 UTC event timestamp. */
  timestamp: string;

  /** Provider adapter which produced the normalized event. */
  providerId: ProviderId;

  /** Optional workspace/space routing key. */
  workspaceId?: string;

  /** Present for events associated with an established ACP session. */
  sessionId?: string;
};

/**
 * Agent implementation information returned during initialization.
 */
export type AgentInfo = {
  name: string;
  version?: string;
};

/**
 * One authentication method advertised by a provider.
 */
export type AuthMethod = {
  id: string;
  displayName: string;
  description?: string;
};

/**
 * Displayable content carried by streamed chunks or tool results.
 */
export type ContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      mimeType: string;
      /** Base64-encoded image bytes. */
      data: string;
    }
  | {
      type: "audio";
      mimeType: string;
      /** Base64-encoded audio bytes. */
      data: string;
    }
  | {
      type: "resource_link";
      uri: string;
      name?: string;
      mimeType?: string;
    }
  | {
      type: "resource";
      uri?: string;
      mimeType?: string;
      text?: string;
      /** Base64-encoded bytes for a non-text resource. */
      data?: string;
    };

/**
 * One streamed ACP message or thought chunk.
 */
export type StreamedMessageChunk = {
  /** Groups successive chunks belonging to the same logical message. */
  messageId?: string;
  content: ContentBlock;
};

/**
 * ACP tool categories used for presentation.
 */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

/**
 * ACP tool-call lifecycle.
 */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * A location accessed or modified by a tool.
 */
export type ToolCallLocation = {
  path: string;
  line?: number;
};

/**
 * One item produced by a tool call.
 */
export type ToolCallContent =
  | {
      type: "content";
      content: ContentBlock;
    }
  | {
      type: "diff";
      path: string;
      oldText?: string | null;
      newText: string;
    }
  | {
      type: "terminal";
      terminalId: string;
    };

/**
 * Initial normalized ACP tool call.
 */
export type ToolCall = {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  metadata?: Record<string, unknown>;
};

/**
 * Partial update to an existing ACP tool call.
 *
 * When `content` or `locations` is supplied, it replaces that complete
 * collection rather than appending to it.
 */
export type ToolCallUpdate = {
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  metadata?: Record<string, unknown>;
};

/**
 * ACP plan-entry priority.
 */
export type PlanEntryPriority = "high" | "medium" | "low";

/**
 * ACP plan-entry lifecycle.
 */
export type PlanEntryStatus = "pending" | "in_progress" | "completed";

/**
 * One entry in an execution plan.
 */
export type PlanEntry = {
  content: string;
  priority: PlanEntryPriority;
  status: PlanEntryStatus;
};

/**
 * Complete replacement state for the current plan.
 */
export type PlanUpdate = {
  entries: PlanEntry[];
  explanation?: string | null;
};

export type SubtaskStatus =
  "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown";

export type SubtaskStatusSource = "task_event" | "turn_result";

/**
 * Incremental update for one delegated child-agent task. Updates sharing a
 * taskId merge onto the same subtask part; undefined fields keep their prior
 * value. Providers normalize their native shapes into this event: Cursor's
 * `Task` tool call + `cursor/task` request, OpenCode's `task` tool call,
 * Claude Code's `Task` tool + parent_tool_use_id stream, Codex's sub-agent
 * items.
 */
export type SubtaskUpdate = {
  /** Provider-stable task identity (the delegating tool call's id). */
  taskId: string;
  status?: SubtaskStatus;
  /** Provider event used to establish the status, retained for diagnostics. */
  statusSource?: SubtaskStatusSource;
  /** Provider-supplied status detail such as a turn stop reason or tool error. */
  statusReason?: string;
  title?: string;
  description?: string;
  prompt?: string;
  subagentType?: string;
  modelId?: string;
  /** Set only when the provider exposes the child as a loadable session. */
  childSessionId?: string;
  durationMs?: number;
  resultText?: string;
  /** Latest child activity, for providers that stream it (e.g. Claude Code). */
  currentActivity?: string;
  toolCallCount?: number;
};

/**
 * Input shape for a slash command.
 */
export type AvailableCommandInput = {
  type: "unstructured";
  placeholder?: string;
};

/**
 * One command advertised by the current session.
 */
export type AvailableCommand = {
  name: string;
  description: string;
  input?: AvailableCommandInput;
};

/**
 * Known semantic categories for session configuration.
 *
 * The open string arm preserves future ACP and provider-extension categories.
 */
export type SessionConfigCategory = "mode" | "model" | "thought_level" | (string & {});

/**
 * One selectable value for a session configuration option.
 */
export type SessionConfigSelectValue = {
  value: string;
  name: string;
  description?: string;
};

/**
 * A normalized session configuration option.
 */
export type SessionConfigOption =
  | {
      type: "select";
      id: string;
      name: string;
      description?: string;
      category?: SessionConfigCategory;
      currentValue: string;
      options: SessionConfigSelectValue[];
    }
  | {
      type: "boolean";
      id: string;
      name: string;
      description?: string;
      category?: SessionConfigCategory;
      currentValue: boolean;
    };

/**
 * Token usage returned for a completed prompt when the provider supplies it.
 */
export type TokenUsage = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
};

/**
 * Cumulative cost reported for a session.
 */
export type SessionCost = {
  amount: number;
  currency: string;
};

/**
 * Context-window usage published by an ACP usage session update.
 */
export type SessionUsage = {
  used: number;
  size: number;
  cost?: SessionCost;
};

/**
 * Typed JSON-RPC failure.
 */
export type RpcErrorData = {
  source: string;
  message: string;
  code?: number;
  recoverable?: boolean;
  details?: unknown;
};

/**
 * Typed non-RPC runtime failure.
 */
export type RuntimeErrorData = {
  kind: "transport" | "process" | "protocol" | "provider" | "validation" | "unknown";
  message: string;
  recoverable?: boolean;
  details?: unknown;
};

/**
 * Complete normalized event stream.
 */
export type AgentEvent = AgentEventBase &
  (
    | {
        category: "lifecycle";
        event: "process_spawned";
        data: {
          cwd?: string;
          command?: string;
          args?: string[];
          processId?: number;
        };
      }
    | {
        category: "lifecycle";
        event: "process_exited";
        data: {
          exitCode: number | null;
          signal?: string;
          expected: boolean;
        };
      }
    | {
        category: "lifecycle";
        event: "initialized";
        data: {
          protocolVersion?: string;
          agentInfo?: AgentInfo;
          capabilities: ProviderCapabilities;
          authMethods: AuthMethod[];
        };
      }
    | {
        category: "lifecycle";
        event: "authenticated";
        data: {
          methodId?: string;
        };
      }
    | {
        category: "lifecycle";
        event: "session_created";
        sessionId: string;
        data: {
          models?: ModelListing;
          modes?: ModeListing;
          configOptions?: SessionConfigOption[];
        };
      }
    | {
        category: "lifecycle";
        event: "session_loaded";
        sessionId: string;
        data: {
          models?: ModelListing;
          modes?: ModeListing;
          configOptions?: SessionConfigOption[];
        };
      }
    | {
        category: "lifecycle";
        event: "session_deleted";
        sessionId: string;
        data: {};
      }
    | {
        category: "lifecycle";
        event: "prompt_started";
        sessionId: string;
        data: {
          prompt: string;
        };
      }
    | {
        category: "lifecycle";
        event: "prompt_completed";
        sessionId: string;
        data: {
          stopReason?: string;
          usage?: TokenUsage;
        };
      }
    | {
        category: "stream";
        event: "user_message_chunk";
        sessionId: string;
        data: StreamedMessageChunk;
      }
    | {
        category: "stream";
        event: "agent_message_chunk";
        sessionId: string;
        data: StreamedMessageChunk;
      }
    | {
        category: "stream";
        event: "agent_thought_chunk";
        sessionId: string;
        data: StreamedMessageChunk;
      }
    | {
        category: "tool";
        event: "tool_call";
        sessionId: string;
        data: ToolCall;
      }
    | {
        category: "tool";
        event: "tool_call_update";
        sessionId: string;
        data: ToolCallUpdate;
      }
    | {
        category: "tool";
        event: "tool_call_content";
        sessionId: string;
        data: {
          toolCallId: string;
          item: ToolCallContent;
        };
      }
    | {
        category: "session";
        event: "plan_update";
        sessionId: string;
        data: PlanUpdate;
      }
    | {
        category: "session";
        event: "subtask_update";
        sessionId: string;
        data: SubtaskUpdate;
      }
    | {
        category: "permission";
        event: "permission_request";
        sessionId: string;
        data: PermissionRequest;
      }
    | {
        category: "session";
        event: "current_model_update";
        sessionId: string;
        data: ModelListing;
      }
    | {
        category: "session";
        event: "current_mode_update";
        sessionId: string;
        data: ModeListing;
      }
    | {
        category: "session";
        event: "config_option_update";
        sessionId: string;
        data: {
          configOptions: SessionConfigOption[];
        };
      }
    | {
        category: "session";
        event: "session_info_update";
        sessionId: string;
        data: {
          title?: string | null;
          updatedAt?: string | null;
        };
      }
    | {
        category: "session";
        event: "usage_update";
        sessionId: string;
        data: SessionUsage;
      }
    | {
        category: "session";
        event: "available_commands_update";
        sessionId: string;
        data: {
          availableCommands: AvailableCommand[];
        };
      }
    | {
        category: "extension";
        event: "extension_request";
        sessionId: string;
        data: {
          requestId: string;
          method: string;
          params: unknown;
        };
      }
    | {
        category: "extension";
        event: "extension_notification";
        sessionId: string;
        data: {
          method: string;
          params: unknown;
        };
      }
    | {
        category: "error";
        event: "rpc_error";
        data: RpcErrorData;
      }
    | {
        category: "error";
        event: "runtime_error";
        data: RuntimeErrorData;
      }
    | {
        category: "error";
        event: "auth_required";
        data: {
          message: string;
          authMethods?: AuthMethod[];
          loginHint?: string;
        };
      }
    | {
        category: "error";
        event: "capability_missing";
        data: {
          capability: CapabilityKey;
          operation: string;
          message: string;
        };
      }
  );
```

Rationale: `AgentEventBase & (...)` guarantees that every variant carries `threadId`, `seq`, `timestamp`, `id`, and `providerId` without repeating those fields in every branch.

Rationale: snake-case event names remain close to the existing Basis event stream, reducing adapter and migration work.

Rationale: `tool_call_content` is retained even though `tool_call_update.content` already exists because Basis emits one such event per content item and consumers use it for incremental folding.

Rationale: collection-bearing events contain normalized direct payloads instead of accepting both direct and nested provider envelopes.

Rationale: `auth_required` and `capability_missing` are top-level event discriminants, so application logic can exhaustively switch on them without inspecting messages or RPC codes.

Rationale: general extension events retain typed method and correlation fields while leaving provider-owned parameters as `unknown`.

---

## Consumer rules

A consumer should process events in this order:

```ts
const ordered = [...events].sort(
  (a, b) => a.seq - b.seq || a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
);
```

Tool calls should be folded by `toolCallId`:

- `tool_call` creates or replaces the initial row.
- `tool_call_update` merges supplied scalar fields.
- Supplied `content` and `locations` replace their respective collections.
- `tool_call_content` may be appended for incremental presentation.
- `permission_request.data.toolCall.toolCallId` attaches the request to that same row.

Session collection updates are complete snapshots:

- `plan_update.data.entries`
- `available_commands_update.data.availableCommands`
- `config_option_update.data.configOptions`
- `current_model_update.data.availableModels`, when present
- `current_mode_update.data.availableModes`, when present

Applications should gate controls as follows:

```ts
if (provider.capabilities.canSetModel) {
  // Show the model picker.
}

if (provider.capabilities.canSetMode) {
  // Show the mode picker.
}

if (provider.capabilities.canDeleteSession) {
  // Show the delete-session action.
}

if (provider.capabilities.supportsPlans) {
  // Render or expose plan-specific UI.
}
```

The following is forbidden:

```ts
// Do not gate features by provider identity.
if (provider.id === "cursor") {
  // ...
}
```

Error handling should be exhaustive:

```ts
function handleEvent(event: AgentEvent): void {
  switch (event.event) {
    case "auth_required":
      showAuthenticationUi(event.data);
      return;

    case "capability_missing":
      disableUnsupportedOperation(event.data.capability);
      return;

    case "rpc_error":
    case "runtime_error":
      showError(event.data.message);
      return;

    default:
      return;
  }
}
```

---

## Source ambiguities and decisions

1. **`at` versus `timestamp`:** Basis uses `at`, while OpenManager uses `timestamp`. This contract uses the clearer `timestamp` name and requires an ISO-8601 UTC string.

2. **Event identity:** Basis includes an event `id`, while the request only mandates thread, sequence, and timestamp. The contract retains `id` because the consumers deduplicate events and use it as an ordering tie-breaker.

3. **Workspace routing:** Basis includes `spaceSlug`, while the broader runtime schema primarily routes by `threadId`. The contract provides optional `workspaceId` and leaves workspace naming and tenancy outside the core event model.

4. **Process events for shared runtimes:** A provider process may serve more than one thread, but every event is required to carry `threadId`. The runtime therefore emits or duplicates process lifecycle records into each affected thread stream.

5. **Missing lifecycle variants:** Basis only declares `process_spawned` and maps exits into `rpc_error`. The contract adds `process_exited` so process lifecycle is explicit and non-error exits are representable.

6. **Session deletion:** Basis exposes creation and loading but not a typed deletion event, while the required capabilities include `canDeleteSession`. The contract adds `session_deleted` to complete that lifecycle.

7. **Model and mode envelopes:** Basis consumers accept both direct fields and nested `models`/`modes` fields. The contract chooses direct `ModelListing` and `ModeListing` payloads; adapters normalize legacy envelopes.

8. **Current-only model and mode updates:** Basis may emit only a newly selected ID after a set operation. Consequently, `availableModels` and `availableModes` are optional rather than forcing the runtime to repeat an unchanged catalog.

9. **Configuration categories:** ACP categories can evolve or be provider-defined. Known categories receive literals for editor support, while the open-string arm preserves forward compatibility.

10. **Plan semantics:** ACP plans are complete replacement snapshots, while some providers use plan-shaped updates for todo synchronization. The contract defines replacement semantics; adapters decide whether a provider todo update is truly a plan before emission.

11. **Tool content:** Basis exposes content both inside `tool_call_update` and as individual `tool_call_content` events. Both are retained so consumers can either replace the full collection or incrementally append presentation items.

12. **Tool status names:** OpenManager presentation state uses values such as `running` and `error`, while ACP uses `in_progress` and `failed`. The contract uses ACP status names; presentation adapters perform the final mapping.

13. **`callID` versus `toolCallId`:** OpenManager uses `callID`, whereas ACP and Basis use `toolCallId`. The contract standardizes on `toolCallId`.

14. **Permission outcomes:** The sources return `{ outcome: "selected", optionId }` rather than returning `allow_once` or similar directly. The contract preserves this behavior and types the semantic option kind on the request option.

15. **Permission cancellation:** Basis auto-cancels after five minutes but its public outcome does not expose why. The contract adds an optional typed cancellation reason without requiring providers to understand it.

16. **Authentication classification:** Existing integrations sometimes recognize authentication failures by message matching or a provider-specific RPC code. This contract requires adapters to translate those signals into `auth_required` before applications receive them.

17. **Unsupported operations:** Existing integrations sometimes throw text such as "model switching is not supported." This contract translates that condition into `capability_missing`, carrying the exact `CapabilityKey`.

18. **Message-part metadata:** OpenManager's switch statements define the discriminants but many structural part fields are not consumed visually. The contract supplies minimal stable fields for those variants and keeps provider-owned snapshot or agent payloads as `unknown`.

19. **Extension events:** Basis includes Cursor extension requests and notifications. The reusable contract retains generic extension variants but does not encode Cursor method names into the core union; provider adapters may narrow `method` locally.

20. **Provider extensibility:** TypeScript cannot provide both a truly open string union and exhaustive built-in provider switching. The contract chooses a closed `ProviderId` union and extends it through versioned package releases.
