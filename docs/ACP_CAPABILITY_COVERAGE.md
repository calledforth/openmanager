# ACP Capability Coverage Registry

This file is the source of truth for ACP end-to-end coverage in OpenManager.

Status labels:
- `DONE` = implemented end-to-end in current app behavior
- `INGRESS_ONLY` = event/request is received in runtime (`acp:event`) but not projected to durable/UI state
- `PARTIAL` = partially projected; incomplete semantics/UI
- `TODO` = not implemented yet

Convex policy for this phase:
- No breaking query changes.
- Schema additions are allowed later, but optional for initial UI wiring if we keep runtime-only state first.

---

## 1) Transport + Session Lifecycle

| Area | ACP Primitive | Status | Current Handling | Convex Impact |
|---|---|---|---|---|
| Initialize | `initialize` | DONE | ACP init is sent and validated; capabilities negotiated | None |
| Auth required | RPC error / auth-required path | PARTIAL | Runtime emits `acp:event` + error status; retry UX basic | None |
| New session | `session/new` | DONE | Job create-session path works, session created and upserted | None |
| Load session | `session/load` | TODO | Not wired from app actions yet | Optional schema if persisting ACP metadata |
| List sessions | `session/list` | DONE | Runtime paginates provider sessions; desktop syncs Cursor titles for existing OpenManager sessions after connect and prompt completion | Optional `sessions.titleSource` records title precedence |
| Fork session | `session/fork` | TODO | Not wired | None required |
| Resume session | `session/resume` | TODO | Not wired | None required |
| Cancel | `session/cancel` | DONE | Abort job maps to ACP cancel | None |

---

## 2) Prompt/Streaming Update Kinds (`session/update`)

| Update Kind | Status | Current Projection | Convex Impact |
|---|---|---|---|
| `agent_message_chunk` | DONE | Mapped to synthetic `message.part.delta`, existing stream path used | None |
| `agent_thought_chunk` | PARTIAL | Mapped to reasoning part updates; UI rendering can be improved | None |
| `user_message_chunk` | INGRESS_ONLY | Received; currently ignored in projector (user write already handled by job path) | None |
| `tool_call` | DONE | Mapped to tool part pending state | None |
| `tool_call_update` | DONE | Mapped to tool part running/completed/error | None |
| `plan` | PARTIAL | Captured as synthetic part; no dedicated plan UI yet | None |
| `usage_update` | INGRESS_ONLY | Received via `acp:event`, not persisted/displayed | Optional schema if persisted |
| `available_commands_update` | INGRESS_ONLY | Received via `acp:event`, not projected into UI state | Optional schema if persisted |
| Any unknown `sessionUpdate` | PARTIAL | Captured as generic synthetic part + `acp:event` | None |

---

## 3) Permission Bridge

| Area | ACP Primitive | Status | Current Handling | Convex Impact |
|---|---|---|---|---|
| Permission request | `session/request_permission` | DONE | Upserts existing pending permission flow via synthetic `permission.asked` | None |
| Permission response | outcome reply | DONE | Uses existing resolve flow via synthetic `permission.replied` | None |
| Rich permission options | option kinds / always allow semantics | PARTIAL | Basic allow-once/reject mapping; richer option semantics not surfaced | Optional schema for policy persistence |

---

## 4) Client-Side Capability Methods (Agent -> Client)

| Capability | ACP Method(s) | Status | Current Handling | Convex Impact |
|---|---|---|---|---|
| FS read | `fs/read_text_file` | DONE | Reads file from local disk | None |
| FS write | `fs/write_text_file` | DONE | Writes file to local disk | None |
| Terminal create | `terminal/create` | PARTIAL | Spawned and tracked minimally | None |
| Terminal output | `terminal/read_output` / `terminal/get_output` | PARTIAL | Returns buffered output | None |
| Terminal wait | `terminal/wait_for_exit` | PARTIAL | Waits for exit and returns code | None |
| Terminal kill/release | `terminal/kill` / `terminal/release` | PARTIAL | Kills and cleans up | None |

---

## 5) Metadata Surfaces Needed for Full OpenCode-ACP UX

These are visible in ACP responses but not yet surfaced in OpenManager UI:
- Agent info/version from initialize result
- Auth methods and terminal-auth metadata
- Model catalog (`availableModels`)
- Current model (`currentModelId`)
- Mode catalog (`availableModes`)
- Current mode (`currentModeId`)
- Available commands (`available_commands_update`)
- Usage/cost updates (`usage_update`)

Current status: `INGRESS_ONLY` (runtime event visibility only).

---

## 6) Convex Strategy (No Query Breakage)

### What can be done immediately with zero query changes
- Keep metadata in main-process runtime store only.
- Emit metadata to renderer via IPC (`acp:event`) and wire UI controls locally.
- Continue existing Convex mutations for sessions/messages/permissions unchanged.

### What likely needs schema additions (optional, phase 2)
- Persist selected session-level metadata:
  - `providerId`
  - `modelId`
  - `modeId`
  - `agentName`
- Persist usage snapshots (per assistant turn):
  - `inputTokens`, `outputTokens`, `reasoningTokens`, `cost`
- Persist available options snapshots (optional caches):
  - model list
  - mode list
  - command list

Note: schema additions do **not** require breaking query changes. Existing queries can remain intact while new optional fields are added.

---

## 7) Execution Order (Recommended)

1. `Phase A` Runtime/UI wiring only (no Convex schema updates):
   - Surface model/mode/commands/agent info from `acp:event`.
   - Add model/mode switching controls (ACP calls).
2. `Phase B` Optional schema additions:
   - Persist selected metadata + usage.
3. `Phase C` Coverage hardening:
   - Explicit typed registry for every known `sessionUpdate`.
   - Test that unknown kinds trigger warning + capture, not silent drops.

---

## 8) Definition of “Full Capability” for This Project

OpenManager is “full ACP-capability ready” when:
- All known ACP update kinds are either projected to UI state or intentionally archived with explicit fallback behavior.
- Session capabilities used by OpenCode (load/list/fork/resume/set-model/set-mode) are callable from UI.
- Permission and tool lifecycle remain parity-safe with existing Convex mutation semantics.
- Unknown ACP updates are observable and non-breaking by design.
