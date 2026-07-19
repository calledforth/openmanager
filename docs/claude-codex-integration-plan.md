# Claude Code (Agent SDK) + Codex (app-server) Integration Plan

Status: **research compiled — awaiting approval, no code changed.**

Research was performed by gpt-5.6-sol (high effort) discovery agents over this repo and the
reference implementation in `.tmp/t3code` (which ships production integrations of both
Claude Code via `@anthropic-ai/claude-agent-sdk` and Codex via `codex app-server`). All
load-bearing claims below were independently spot-verified against source, line by line.

---

## 1. Where openmanager stands today

The stack is already provider-neutral at the contract level, ACP-specific at the runtime level:

```
renderer (React)
  ⇅ Convex jobs (prompt/cancel/permission/model/mode)  +  IPC events (acp:event, stream:token)
main process: AgentHost → AgentRuntime → Backend (currently always AcpBackend)
                              ⇅ @agentpack/contract AgentEvent union
```

What a new provider plugs into:

- **`Backend` interface** (`packages/agent-runtime/src/backends/Backend.ts`) — clean and
  transport-agnostic: `start`, `ensureSession`, `prompt`, `cancel`, `respondPermission`,
  `setModel`, `setMode`, `setConfigOption`, `events`, `dispose`. Backends emit
  `BackendEvent` (an `AgentEvent` minus `id/seq/timestamp/providerId`, which
  `AgentRuntime.forward` adds).
- **`AgentEvent` contract** (`packages/agent-contract/src/events.ts`) — ACP-shaped:
  `agent_message_chunk` / `agent_thought_chunk`, `tool_call` / `tool_call_update`,
  `plan_update`, `permission_request` (option-based), `usage_update`, `prompt_started` /
  `prompt_completed`, error events.
- **Durable identity**: the provider-native session id is returned in
  `SessionResult.sessionId` and persisted as Convex `sessions.externalId`. Nothing else
  survives restart (`resumeCursor` is in-memory only). Both new providers have durable
  native ids (Claude session UUID, Codex thread id), so **no Convex schema change is
  needed**.

### Hard blockers (verified)

| # | Blocker | Location |
|---|---------|----------|
| 1 | `AgentRuntime` constructs `new AcpBackend(config, host)` for **every** registered provider | `packages/agent-runtime/src/core/AgentRuntime.ts:36` |
| 2 | `ProviderConfig` is ACP-only (spawn command, ACP auth hints, ACP extensions) | `packages/agent-runtime/src/providers/index.ts:6-14` |
| 3 | `PROVIDER_IDS = ['opencode', 'cursor']` is a closed compile-time union used everywhere | `packages/agent-contract/src/providers.ts:3` |

Secondary friction (all verified):

- Legacy settings migration hard-codes `['opencode', 'cursor']` (`apps/desktop/src/main/index.ts:337`).
- Various fallbacks default to OpenCode (`job-worker.ts`, `session-provider.ts`, `jobs.ts`, `store.ts`).
- Permission UI is boolean approve/deny only — `AgentHost` maps approve → first `allow_once`
  option, so `allow_always` options are currently unreachable from the UI.
- The contract has no standard subtask event (`supportsSubtasks` exists; only Cursor's
  `cursor/task` extension is folded into subagent rows).
- Provider processes are singletons per provider; first `start()` fixes the process cwd.
- IPC channel names (`acp:event`, `acp:load-session`) are ACP-branded but carry generic
  `AgentEvent` payloads — rename is cosmetic, not required.

The good news: provider pickers, settings rows, composer chrome, status tracking, and
Convex profiles are all **data-driven from the runtime registry** — once the runtime
returns Claude/Codex metadata, the UI lists them with no per-provider edits.

---

## 2. Reference: how t3code integrates Claude Code (Agent SDK)

Dependency: `@anthropic-ai/claude-agent-sdk@0.3.170` (peers: `@anthropic-ai/sdk` 0.93,
`@modelcontextprotocol/sdk` 1.29, zod 4). Core file: `apps/server/src/provider/Layers/ClaudeAdapter.ts`.

**Architecture**: one long-lived `query()` per active thread in **streaming-input mode** —
the prompt argument is an `AsyncIterable<SDKUserMessage>` fed from a queue, so multiple
user turns (and mid-turn steering) ride one SDK session. `includePartialMessages: true`
gives token-level `stream_event` deltas.

**Key `query()` options** (verified at `ClaudeAdapter.ts:3443-3481`):

```ts
{
  cwd, model,                       // model may be `${model}[1m]` for 1M context
  pathToClaudeCodeExecutable,       // configured binary, default "claude"
  systemPrompt: { type: 'preset', preset: 'claude_code' },
  settingSources: ['user', 'project', 'local'],
  permissionMode,                   // omitted | 'acceptEdits' | 'bypassPermissions'
  includePartialMessages: true,
  canUseTool,                       // permission callback
  resume: <persisted session uuid>  // OR sessionId: <fresh uuid> — never both
  env, additionalDirectories, mcpServers?, settings?, effort?
}
```

**Session lifecycle**: fresh sessions **pre-generate a UUID** passed as `sessionId` and
persist it immediately (crash-safe — no waiting for init). Resume passes `resume`.
Every SDK message's `session_id` is captured as the durable resume id, **except**
`system` messages with subtype `hook_started|hook_progress|hook_response` (resume hooks
carry transient ids that must not clobber the durable one — `ClaudeAdapter.ts:233`).
Live query controls used: `interrupt()`, `setModel()`, `setPermissionMode()`,
`getContextUsage()`, `close()`.

**Message handling** (the mapping we'll adapt):

| SDK message | t3code handling |
|---|---|
| `stream_event` → `content_block_delta.text_delta` | assistant text delta |
| `stream_event` → `content_block_delta.thinking_delta` | reasoning delta |
| `stream_event` → `content_block_start` (`tool_use`/`server_tool_use`/`mcp_tool_use`) | tool item started |
| `stream_event` → `content_block_delta.input_json_delta` | accumulate partial JSON → tool input update; `TodoWrite` input also → plan update |
| `user` message `tool_result` blocks | tool completed/failed (matched by `tool_use_id`) |
| `assistant` snapshot | backfills text if partial deltas were missing; captures `uuid`; `ExitPlanMode` blocks → plan captured |
| `result` | turn complete (`success` → completed; interrupt patterns → interrupted; else failed) + usage |
| `system/init` | session configured |
| `system/compact_boundary` | token usage + compaction marker |
| `system/status`, hooks, tasks, `tool_progress`, `auth_status`, `rate_limit_event` | telemetry/state events |

**Permissions** (`canUseTool`): full-access mode auto-allows; otherwise emits a request
event, blocks on a deferred until the UI answers, then returns
`{behavior:'allow', updatedInput}` or `{behavior:'deny', message}`. `acceptForSession`
additionally returns SDK `updatedPermissions` from the callback's suggestions.

**Auth**: entirely CLI-owned (`claude` login state / `ANTHROPIC_API_KEY` / HOME
isolation). Status is probed with a never-yielding `query()` + `initializationResult()`
(8s timeout) that reveals account email/plan and slash commands without sending a prompt.

**Quirks worth inheriting** (all verified in source):

1. `AskUserQuestion` answers must be keyed by the **full question text** (SDK ≥ 2.1.121
   looks answers up by text — `ClaudeAdapter.ts:3133`).
2. `ExitPlanMode` is always denied; the plan is captured client-side and the model is told
   to stop (their product choice — ours may differ, see §6).
3. Hook-carried session ids are transient — filter before persisting.
4. Assistant snapshots are the fallback when partial deltas never arrive.
5. `resumeSessionAt` is persisted but deliberately **not** passed (avoids pinning a stale
   checkpoint).
6. Idle reaper closes SDK sessions after 30 min inactivity; resume state makes this cheap.

---

## 3. Reference: how t3code integrates Codex (app-server)

No OpenAI SDK. A private package (`packages/effect-codex-app-server`) speaks the
**`codex app-server` protocol**: newline-delimited JSON, JSON-RPC-shaped envelopes
**without** the `"jsonrpc":"2.0"` member, over child-process stdio. Protocol types are
generated from a pinned `openai/codex` commit (`generate.ts:20`,
ref `b39f943a634a6e7ba86c3d6e8cf6d5f35e612566`) — schemas fetched from
`codex-rs/app-server-protocol/schema/typescript/`.

**Process model**: t3code spawns **one `codex app-server` process per active thread**
(they need per-instance env/CODEX_HOME isolation). The protocol itself multiplexes many
threads over one process. Spawn: `<binaryPath> app-server` (default `codex`), cwd = workspace,
optional `-c mcp_servers...` args, force-kill 2s after scope close. Windows `.cmd`
launchers handled via PATHEXT + `shell: true`.

**Handshake**: `initialize {clientInfo, capabilities:{experimentalApi:true}}` →
`initialized` notification. Codex version parsed from `initializeResponse.userAgent`.
No version gate — incompatibility surfaces as method-not-found at runtime.

**Client → server methods actually used** (modern surface only — no legacy
`sendUserTurn`/`newConversation`):

| Method | Purpose |
|---|---|
| `thread/start` / `thread/resume` | open thread; `{cwd, approvalPolicy, sandbox, model?, serviceTier?}` (+`threadId` on resume). Resume errors matching "not found / no such thread / does not exist" → logged, fall back to fresh `thread/start`, same client-side thread |
| `turn/start` | `{threadId, input:[{type:'text',text} \| {type:'image',url:dataUrl}], approvalPolicy, sandboxPolicy, model?, effort?, collaborationMode?}` — response is the turn id; completion arrives as a notification |
| `turn/interrupt` | `{threadId, turnId}` |
| `thread/read` | `{threadId, includeTurns:true}` — history load (lossy upstream) |
| `thread/rollback` | history-only rollback (does NOT revert files) |
| `config/mcpServer/reload` | refresh MCP catalog before turns (failure nonfatal) |
| `account/read`, `model/list`, `skills/list` | probe process only |

**Server → client requests** (blocking JSON-RPC — the response IS the decision). t3code
implements exactly three (`CodexSessionRuntime.ts:952/1008/1066`); everything else gets
`-32601`:

- `item/commandExecution/requestApproval` → decision `accept | acceptForSession | decline | cancel`
- `item/fileChange/requestApproval` → same decision vocabulary
- `item/tool/requestUserInput` → `{answers: {[questionId]: {answers: string[]}}}`

**Notifications consumed semantically** (the rest are decoded and kept raw):

| Notification | Meaning |
|---|---|
| `thread/started` | capture/refresh durable Codex thread id |
| `turn/started` / `turn/completed` | turn lifecycle (+usage flush) |
| `item/agentMessage/delta` | assistant text delta |
| `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta` | reasoning deltas |
| `item/started` / `item/completed` | tool/item lifecycle — item union covers command execution, file change, MCP call, web search, plan, reasoning, sub-agent, review, compaction |
| `item/commandExecution/outputDelta` | live command output |
| `turn/plan/updated` | structured plan `{step, status: pending\|inProgress\|completed}` |
| `turn/diff/updated` | unified diff of the turn |
| `thread/tokenUsage/updated` | token usage (incl. model context window as max) |
| `account/rateLimits/updated`, `account/updated` | account telemetry |
| `error` | `willRetry` distinguishes transient vs fatal |
| `thread/compacted` | compaction marker |

**Approval policy mapping** (their three runtime modes — `CodexSessionRuntime.ts:265`):

| Mode | `approvalPolicy` | `sandbox` (thread) / `sandboxPolicy` (turn) |
|---|---|---|
| approval-required | `untrusted` | `read-only` |
| auto-accept-edits | `on-request` | `workspace-write` |
| full-access | `never` | `danger-full-access` |

Both are re-sent on **every** `turn/start`, so mode switches take effect immediately.

**Auth**: external `codex login`; probe via `account/read` → account union
`apiKey | chatgpt{email,planType} | amazonBedrock` + `requiresOpenaiAuth` flag.

**Quirks worth inheriting**: resume-fallback-to-fresh matcher; graceful decode-failure
handling (drop malformed notifications, never kill the connection); stderr is logging, not
protocol (two known benign `state db` errors suppressed); `turn/start` response returns
early — completion is notification-driven; generated `V2TurnStartParams` omits
`collaborationMode` (t3code patches the schema locally); pending approvals settled as
`cancel` on session close so the JSON-RPC handler never hangs.

---

## 4. Proposed design for openmanager

### Phase 0 — runtime refactor (prerequisite, no behavior change)

Split "provider registration" from "ACP config":

```ts
// packages/agent-runtime/src/providers/index.ts
export type ProviderRegistration = {
  id: ProviderId
  displayName: string
  capabilities: ProviderCapabilities
  createBackend: (host: HostDeps) => Backend
}
```

- `cursor.ts` / `opencode.ts` keep their `ProviderConfig` internally and export a
  `ProviderRegistration` whose `createBackend` returns `new AcpBackend(config, host)`.
- `AgentRuntime` constructor: `registration.createBackend(host)` replaces the hard-coded
  `new AcpBackend(...)`. `getProvider()` consumers (AgentHost's provider listing) read
  `id/displayName/capabilities` — all present on the registration.
- `HostLogEntry.scope` widens: `'agent-runtime' | 'acp' | 'claude' | 'codex'`.
- Everything typechecks with zero behavior change; existing AcpBackend tests stay green.

### Phase 1 — `ClaudeCodeBackend` (Claude Agent SDK)

New: `packages/agent-runtime/src/backends/claude/ClaudeCodeBackend.ts` +
`providers/claude.ts`. Dependency: `@anthropic-ai/claude-agent-sdk` added to
`packages/agent-runtime/package.json` (Electron main bundles `@agentpack/runtime`, so it
rides the existing electron-vite config).

**Session model**: `Map<sessionId, ClaudeSession>` inside the singleton backend. Each
session = one streaming-input `query()` (t3code pattern):

- `ensureSession` without `sessionId` → pre-generate UUID, pass as `sessionId` option,
  emit `session_created`, return it (becomes Convex `externalId`).
- `ensureSession` with `sessionId` → construct query with `resume`, emit `session_loaded`.
- `prompt()` → push `SDKUserMessage` into the session's input queue; resolve when that
  turn's `result` message arrives (matches ACP semantics: promise = end of turn).
- `cancel()` → `query.interrupt()`. `dispose()` → `query.close()` per session.
- Binary: SDK-bundled CLI by default, `CLAUDE_CODE_BIN` env override →
  `pathToClaudeCodeExecutable` (consistent with the existing `ACP_*_BIN` pattern).
- Options as in §2: `claude_code` preset system prompt, `settingSources
  ['user','project','local']`, `includePartialMessages: true`, `cwd`, `canUseTool`.

**Event mapping** (SDK → `BackendEvent`):

| SDK | AgentEvent |
|---|---|
| query start | `process_spawned` (first session), `initialized` (static caps + `supportedModels()` if available) |
| `content_block_delta.text_delta` | `agent_message_chunk` `{content:{type:'text',text}}` |
| `content_block_delta.thinking_delta` | `agent_thought_chunk` |
| `content_block_start` tool_use | `tool_call` `{toolCallId: block.id, title, kind: classified, status:'pending', rawInput}` |
| `input_json_delta` (accumulated, parseable) | `tool_call_update` `{rawInput}`; `TodoWrite` input additionally → `plan_update` |
| `user` msg `tool_result` | `tool_call_update` `{status: completed\|failed, rawOutput, content}` — Edit/Write/MultiEdit inputs mapped to `{type:'diff', path, oldText, newText}` content so the desktop diff renderer works |
| `assistant` snapshot | backfill `agent_message_chunk` if no deltas arrived (t3code quirk #4); filter hook session ids (quirk #3) |
| `result` | `prompt_completed` `{stopReason, usage}`; error subtypes → `runtime_error` first |
| `system/compact_boundary` | `usage_update` (pre/post tokens) |
| `message_delta` usage / `getContextUsage()` | `usage_update` `{used, size}` |
| auth-shaped failures | `auth_required` `{message: 'Run `claude` and sign in, or set ANTHROPIC_API_KEY.', ...}` |

Tool `kind` classification (drives icons/grouping): Read/Glob/Grep → `read`/`search`,
Bash → `execute`, Edit/Write/MultiEdit/NotebookEdit → `edit`, WebFetch/WebSearch →
`fetch`, Task → `other` (subtask event TBD), TodoWrite → `think`, else `other`.

**Permissions** (`canUseTool` → contract):

- Emit `permission_request` with options `allow_once`, `allow_always`, `reject_once`
  (requestId = UUID; toolCall from callback args). Block on a deferred.
- `respondPermission`: `selected(allow_once)` → `{behavior:'allow', updatedInput}`;
  `selected(allow_always)` → allow + SDK `updatedPermissions` from suggestions;
  `selected(reject_*)` / `cancelled` → `{behavior:'deny', message}`.
- On `cancel()`/`dispose()` settle pending callbacks as deny (mirrors both references).
- Note: `AgentHost` already reduces UI approve/deny to `allow_once`/`reject_once` — works
  as-is; `allow_always` becomes reachable if/when the UI grows that button.

**Modes** (`canSetMode: true`): expose SDK permission modes as contract modes —
`default`, `acceptEdits`, `plan`, `bypassPermissions` → `query.setPermissionMode()`.
`setModel` → `query.setModel()`. `setConfigOption` → capability off (v1).

**Capabilities**: `canSetModel ✓, canSetMode ✓, canSetConfigOption ✗, canDeleteSession ✗,
canLoadSession ✓, canCancelPrompt ✓, supportsPlans ✓ (TodoWrite), supportsAvailableCommands ✗ (v1),
supportsUsage ✓, supportsPermissionRequests ✓, supportsAuthentication ✗ (CLI-owned; we emit
auth_required with instructions), supportsThoughtStreaming ✓, supportsSubtasks ✗ (v1),
supportsExtensions ✗`.

### Phase 2 — `CodexAppServerBackend` (codex app-server)

New: `packages/agent-runtime/src/backends/codex/` — `CodexAppServerClient.ts` (transport)
+ `CodexAppServerBackend.ts` + `providers/codex.ts`. **No new dependency**: the client is
~300 lines (JSON-lines framing, numeric ids, pending-response map, notification/server-request
dispatch). Types: hand-written for the used subset, cross-checked against t3code's
generated schemas (`.tmp/t3code/packages/effect-codex-app-server/src/_generated/`); we can
adopt their generator later if drift becomes a problem.

**Process model**: **one `codex app-server` process per backend**, threads multiplexed
over it (protocol supports this; t3code's per-thread processes exist only for multi-account
CODEX_HOME isolation we don't need). Binary: `codex` with `CODEX_APP_SERVER_BIN` override;
Windows `.cmd` handling via the existing `shell: win32` spawn pattern AcpBackend uses.

**Lifecycle mapping**:

- `start()` → spawn + `initialize {clientInfo:{name:'openmanager',version}, capabilities:{experimentalApi:true}}`
  + `initialized` → emit `process_spawned`, `initialized` (models from `model/list`),
  and `account/read` probe → `auth_required` if unauthenticated ("Run `codex login`.").
- `ensureSession` without id → `thread/start {cwd, approvalPolicy, sandbox, model?}` →
  `session_created`, sessionId = Codex thread id (durable, = Convex `externalId`).
- `ensureSession` with id → `thread/resume`; on "thread not found"-class errors, fall back
  to `thread/start` (t3code matcher) and emit `session_created` with the new id.
- `prompt()` → optional `config/mcpServer/reload` (skipped v1), then
  `turn/start {threadId, input:[text|image dataUrl], approvalPolicy, sandboxPolicy, model?}`;
  emit `prompt_started` first (AcpBackend convention); resolve on that turn's
  `turn/completed` (or `error` without `willRetry`).
- `cancel()` → `turn/interrupt {threadId, turnId}` (track current turn id per session).
- `dispose()` → settle pending approvals as `cancel` decisions, kill the child (2s force-kill).

**Notification mapping**:

| Codex notification | AgentEvent |
|---|---|
| `item/agentMessage/delta` | `agent_message_chunk` |
| `item/reasoning/textDelta`, `.../summaryTextDelta` | `agent_thought_chunk` |
| `item/started` (commandExecution) | `tool_call` `{kind:'execute', title: command, rawInput}` |
| `item/commandExecution/outputDelta` | `tool_call_update` (append rawOutput) or `tool_call_content` |
| `item/started` (fileChange) | `tool_call` `{kind:'edit'}` + `{type:'diff'}` content from the change set |
| `item/started` (mcpToolCall / webSearch / other) | `tool_call` `{kind:'other'/'search'}` |
| `item/completed` | `tool_call_update` `{status: completed\|failed, rawOutput}` |
| `turn/plan/updated` | `plan_update` (`inProgress` → `in_progress`; priority defaults `medium`) |
| `thread/tokenUsage/updated` | `usage_update` `{used: lastTurnTotal, size: contextWindow}` |
| `turn/completed` | `prompt_completed` `{usage}` |
| `error` | `willRetry` → `rpc_error {recoverable:true}`; else `runtime_error` + fail turn |
| `thread/compacted` | log v1 (no contract event) |
| stderr lines | host log (suppress the two known benign `state db` messages); `failed to connect to websocket` → `runtime_error` |
| everything else | host log at debug — never crash on unknown/malformed notifications |

**Approvals** (server requests → contract): `item/commandExecution/requestApproval` and
`item/fileChange/requestApproval` → `permission_request` with options
`allow_once → accept`, `allow_always → acceptForSession`, `reject_once → decline`;
`cancelled` outcome → `cancel`. The pending JSON-RPC response is the deferred.
`item/tool/requestUserInput` → v1: respond with empty answers + emit a visible
`runtime_error`-level warning (see open question Q3). All other server-request methods →
`-32601` (t3code-verified safe).

**Modes** (`canSetMode: true`): three contract modes mirroring t3code exactly —
`approval-required` (untrusted / read-only), `auto-accept-edits` (on-request /
workspace-write), `full-access` (never / danger-full-access) — re-sent on every
`turn/start`. Default: `approval-required`.

**Capabilities**: `canSetModel ✓ (per-turn param), canSetMode ✓, canSetConfigOption ✗,
canDeleteSession ✗, canLoadSession ✓, canCancelPrompt ✓, supportsPlans ✓,
supportsAvailableCommands ✗, supportsUsage ✓, supportsPermissionRequests ✓,
supportsAuthentication ✗ (external `codex login`), supportsThoughtStreaming ✓,
supportsSubtasks ✗ (v1), supportsExtensions ✗`.

### File-by-file change list

| File | Change | Phase |
|---|---|---|
| `packages/agent-contract/src/providers.ts` | `PROVIDER_IDS` += `'claude'`, `'codex'` | 1 / 2 |
| `packages/agent-runtime/src/providers/index.ts` | `ProviderRegistration` type; registry keyed by it | 0 |
| `packages/agent-runtime/src/core/AgentRuntime.ts` | `createBackend(host)` instead of `new AcpBackend` | 0 |
| `packages/agent-runtime/src/providers/{cursor,opencode}.ts` | wrap existing config in registration | 0 |
| `packages/agent-runtime/src/host.ts` | widen log scope union | 0 |
| `packages/agent-runtime/src/backends/claude/ClaudeCodeBackend.ts` | new | 1 |
| `packages/agent-runtime/src/providers/claude.ts` | new | 1 |
| `packages/agent-runtime/src/backends/codex/CodexAppServerClient.ts` | new (transport) | 2 |
| `packages/agent-runtime/src/backends/codex/CodexAppServerBackend.ts` | new | 2 |
| `packages/agent-runtime/src/providers/codex.ts` | new | 2 |
| `packages/agent-runtime/src/index.ts` | export new registrations | 1 / 2 |
| `packages/agent-runtime/package.json` (+lockfile) | add `@anthropic-ai/claude-agent-sdk` | 1 |
| `apps/desktop/src/main/index.ts` | legacy migration list → `PROVIDER_IDS`; guard OpenCode-only image probe | 1 |
| tests | see §7 | all |

Not required (verified data-driven): provider pickers, settings sidebar, composer chrome,
preload/IPC surface, Convex schema, `AgentHost`, `JobWorker` generic job paths.
Optional cleanup later: rename `acp:*` channels / `loadAcpSession` naming; OpenCode
fallback defaults; branded provider icons (no icon system exists today — text pills).

---

## 5. Why these choices (vs alternatives)

- **Agent SDK, not ACP adapter, for Claude** — your requirement; also gives partial
  streaming, permission callback, plan/thinking events that the community ACP adapter
  abstracts away.
- **Hand-rolled Codex client, not t3code's generator** — the used surface is ~12 methods +
  ~15 notifications; a generator + pinned-commit pipeline is heavy for v1 and t3code's own
  generated output needed local patching (`collaborationMode`). Their generated types
  remain in-tree as reference. Upgrade path documented.
- **One app-server process per provider, not per thread** — matches openmanager's existing
  singleton-backend architecture; per-thread processes only buy multi-account isolation
  (a t3code feature openmanager doesn't have).
- **Long-lived Claude query per session, not query-per-prompt** — query-per-prompt would
  respawn the CLI on every turn (slow) and forfeit steering; t3code validated the
  streaming-input pattern in production.
- **No Convex/schema changes** — both native ids are durable and fit `externalId`
  exactly like OpenCode/Cursor session ids do.

## 6. Open questions (decide before/while approving)

1. **Provider ids**: proposal `'claude'` + `'codex'` (display "Claude Code" / "Codex").
   Fine, or prefer `'claude-code'`?
2. **ExitPlanMode policy (Claude)**: t3code always denies + captures plan. openmanager has
   plan rendering; proposal: surface it as a normal `permission_request` (approve →
   Claude exits plan mode and proceeds). Alternative: adopt t3code's deny-and-wait UX.
3. **Interactive questions** (Claude `AskUserQuestion`, Codex `item/tool/requestUserInput`):
   openmanager has no structured Q&A UI. v1 proposal: auto-decline with a message telling
   the model to ask in plain text (Claude) / empty answers (Codex). Proper support needs a
   new UI surface — defer?
4. **Claude binary**: SDK-bundled CLI (zero-install, version-locked to the SDK) vs system
   `claude` (user's login/settings already there). Proposal: system `claude` first with
   bundled CLI as fallback — matches how users already authenticate.
5. **Phasing/PRs**: one PR per phase (0/1/2) as laid out, or land 0+1 together?

## 7. Risks & testing

**Risks**: SDK message-shape drift across `@anthropic-ai/claude-agent-sdk` versions
(mitigate: pin exact version; tolerate unknown message types as warnings, never throw);
Codex protocol drift (mitigate: same tolerance rule — t3code drops malformed notifications
silently and it works); Windows spawn of `codex.cmd`/`claude.cmd` (reuse AcpBackend's
`shell: win32` approach; verify both on this machine); permission timeout path leaving
stale Convex `pending_permissions` (pre-existing issue, applies to new backends equally —
noted, not fixed here); Claude turn steering while a prompt is queued (AgentRuntime
serializes prompts per thread, so v1 is strictly turn-by-turn — acceptable).

**Tests** (mirroring `AcpBackend.test.ts` patterns, fake SDK/fake app-server):
backend lifecycle + session create/resume/reuse; event normalization from recorded
message streams; permission round-trip incl. cancel-on-dispose; interrupt; Claude
hook-session-id filtering; Codex resume-fallback-to-fresh; `AgentRuntime` constructing
distinct backend classes per registration. Manual verification: real `claude` and `codex`
binaries on this machine, one full session each (prompt → tool approval → edit diff →
interrupt → resume after app restart).

---

## Appendix: verification notes

Every quoted line number was independently checked in this session:
openmanager — `Backend.ts` (full read), `providers.ts:3`, `AgentRuntime.ts:36`,
`cursor.ts`/`index.ts` provider configs, `events.ts`/`parts.ts`/`permissions.ts`/`capabilities.ts`
(full reads), `apps/desktop/src/main/index.ts:221,337`, `job-worker.ts:273,342`.
t3code — `ClaudeAdapter.ts:233,3133,3432,3446-3463`, `CodexSessionRuntime.ts:80,265,952,1008,1066`,
`generate.ts:20`, `apps/server/package.json` (SDK version). The three underlying research
reports contain deeper per-file walkthroughs; ask if you want them saved alongside this doc.
