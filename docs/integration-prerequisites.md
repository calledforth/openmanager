# Prerequisites before Claude Code / Codex integration

Goal: finish and harden what Cursor + OpenCode already expose so the app's core surfaces
(permissions, questions, plans/modes, subtasks) are provider-neutral and complete. Then the
Claude/Codex backends from `claude-codex-integration-plan.md` plug into finished surfaces
instead of inheriting today's stubs.

Research: gpt-5.6-sol (high effort) gap analyses over the current main, spot-verified.
All file:line refs checked against main @ `3854697`.

---

## P0 — Consolidate in-flight work (hygiene, do first)

- **Land or rebase `worktree-toolcall-ui`** (3 commits: tool-call UI scaffolding + Read
  renderer + `docs/cursor-tool-calls.md`). The wire inventory doc only exists on that
  branch and is needed by P4/P6 below. Branched off an older main — rebase needed.
- **Prune stale branches**: `cursor-provider`, `codex/fix-session-provider-persistence`,
  and the old release worktrees are all _behind_ main (their content was merged via other
  PRs). Delete to remove confusion about where truth lives.

## P1 — Option-based permissions end-to-end

Today the UI is boolean Approve/Deny; `AgentHost` reduces it to an option
(`agent-host.ts:57-80`), Convex discards the `options` array
(`convex-projector.ts:414-438`), so `allow_always` is unreachable and the
first-option fallback can even pick the wrong polarity.

- Persist `options` in `pending_permissions` (schema + `upsertPending` + query).
- Renderer renders one control per option (label + kind); response carries `optionId`,
  not a boolean, through `resolve_permission` job → `JobWorker` → `AgentHost` →
  `AgentRuntime.respondPermission`. Remove the first-option fallback.
- **Fix stale pending permissions** (pre-existing, noted in the plan's risks):
  `PermissionBroker` timeout/cancel settles ACP but never tells `AgentHost` or Convex
  (`PermissionBroker.ts:13-36`, `agent-host.ts:107-113`). Add a settlement callback so
  every outcome (selected / timeout / cancel / process exit / dispose) clears the host map
  and resolves the Convex row; persist `expiresAt`.

Why first: Claude's `canUseTool` (allow_always → `updatedPermissions`), Codex's
`acceptForSession`, and plan-mode approval all need real option-based responses.

## P2 — Generic extension-response plumbing (async server-request answering)

Cursor's `cursor/ask_question`, `cursor/create_plan`, and `cursor/update_todos` arrive as
**blocking ACP requests**, but `Backend` only has `respondPermission`
(`Backend.ts:17-43`); the `ExtensionRegistry` answers immediately with stubs
("skipped"/"cancelled", `extensions.ts:7-14`, `cursor.ts:33-41`) and the emitted
`extension_request.requestId` is observational only (`AcpBackend.ts:881-896`).

- Mirror the permission pipeline: pending-resolver map in `AcpBackend`,
  `Backend.respondExtension(requestId, response)`, `AgentRuntime.respondExtension`,
  `AgentHost` pending map + `resolve_extension` job, timeout with method-specific default,
  settle-on-dispose.

Why: this is the single mechanism behind Q&A (P3), plan-mode UX (P5), and later
Claude `AskUserQuestion` / Codex `item/tool/requestUserInput`.

## P3 — Structured Q&A UI (no auto-decline)

Nothing exists at any layer today: no typed contract event, no Convex persistence, no
renderer component; `extension_request` is ignored by projector and renderer.

- Contract: typed `question_request` / `question_resolved` events (question text, options,
  multi-select, free-text) — provider-neutral so Cursor / Claude / Codex all map into it.
- Convex `pending_questions` + projector upsert/resolve + `resolve_question` job.
- Renderer: inline question card (options + free-text), reusing the inline-permission
  placement pattern.
- Wire `cursor/ask_question` through it first (real UX to validate against); Claude
  (answers keyed by full question text) and Codex (`{answers: {questionId: …}}`) become
  pure mapping work later. Kills the plan doc's open question Q3 — no auto-decline.

## P4 — Plan / todo pipeline

`plan_update` events exist and Cursor emits standard ACP plans, but the projector has no
case for them (nothing persisted), the renderer ignores them, and the full todo payload of
`cursor/update_todos` currently dies in the default "cancelled" response.

- Normalize `cursor/update_todos` → `plan_update` (needs P2 since it's a request on the
  wire; respond success after normalizing).
- Projector: one stable `plan` message part per turn (update, don't append);
  `StreamingMessagesStore` mirrors it live; `MessageParts` gets a `plan` case
  (checklist with statuses). Fits the tool-call UI redesign workstream.
- OpenCode: keep `suppressPlanUpdates` for now; hide plan affordances where
  `supportsPlans` is false.

## P5 — Plan mode completion (Cursor first, sets Claude policy)

Mode selection/`current_mode_update` are fully wired, but plan mode has no behavior: plans
aren't rendered, `cursor/create_plan` (blocking) gets auto-"cancelled", and there is no
accept-plan / proceed-to-agent-mode flow.

- Handle `cursor/create_plan` via P2: render the produced plan, user accepts/rejects,
  response returns the decision.
- "Proceed" action on a completed/accepted plan → existing `setSessionMode` to the
  build/agent mode. Provider's `current_mode_update` stays the source of truth.
- Persist per-session current mode in Convex (`sessions.modeId` exists but is never
  written) if reopened sessions should show mode before hydration.
- This decides the plan doc's open question Q2 (Claude `ExitPlanMode`): same approve-plan
  permission flow, no deny-and-wait hack.

## P6 — Subtasks / subagent tasks ✅ (implemented 2026-07-22)

Live probes (2026-07-22 and cancellation verification on 2026-07-23) reset the
design: **neither provider streams subagent activity live** — the parent sees one opaque
task tool call. Key wire facts:

- **Cursor**: `cursor/task` is a **blocking REQUEST** (not the notification the decompile
  doc claimed), fired once ~2ms after the Task tool completes, carrying
  `{toolCallId, description, prompt, subagentType, model, agentId, durationMs}`;
  `subagentType` is a nested tagged enum (`{"custom":{"unspecified":{}}}`), and `agentId`
  is NOT a loadable session (`session/load` rejects it; absent from `session/list`).
  Subagent permission requests bubble to the parent under orphan toolCallIds. Completion
  orders `pending → in_progress → completed → cursor/task → end_turn`. Cancellation emits
  no terminal Task update; the authoritative terminal signal is parent
  `stopReason:"cancelled"`.
- **OpenCode** (1.17.15): `task` tool call (`title:"task"`, `kind:"think"`); in_progress
  carries `{description, subagent_type, prompt}`; completed `rawOutput.metadata` leaks the
  **child sessionId** (+ parentSessionId + model), and `session/load` on it fully replays
  the subagent transcript. Cancellation emits Task `failed` with
  `rawOutput.metadata.interrupted:true`, followed by parent `stopReason:"cancelled"`; the
  normalized subtask status is `interrupted`.

Shipped: `subtask_update` contract event (+ `SubtaskUpdate`, extended `SubtaskPart` with
live-activity fields `currentActivity`/`toolCallCount` reserved for Claude Code);
`ProviderConfig.subtasks` adapter (`fromToolCall` classifier suppresses the raw tool
events for claimed ids, `fromExtension` acks `cursor/task` with `{}` and emits the
enrichment); `extensionNotification` now uses the sessionless fallback binding; projector
upserts one merged `subtask` part per taskId (no status regression after settle), records
whether status came from a provider task event or provider turn result, and terminalizes
missing Task updates as cancelled/failed/unknown from the turn stop reason; the live
renderer store mirrors the same reducer;
`SubtaskCard` renderer (status shimmer, type/model/duration chips, expandable
prompt/result, including explicit cancelled/interrupted/unknown labels); OpenCode-only
**View transcript** → `sessions.registerChild` (`parentExternalId`) → existing
`acp:load-session` replay → read-only chat pane with ancestry-derived back banner. Child
transcripts appear nested beneath their parent in the sidebar. Both providers now declare
`supportsSubtasks: true`. Deliberately deferred: live-follow (poll `session/list` mid-run +
`session/load` the child while running) — revisit when Claude Code lands, since its SDK
streams child activity with `parent_tool_use_id` and can populate `currentActivity`
directly.

## P7 — Smaller parity / robustness (fit in where convenient)

- **Slash-command picker**: `available_commands_update` is fully plumbed into renderer
  state and `chrome.slashCommands`, but `MessageInputView` never consumes it. Add the `/`
  popup.
- **Usage rendering**: `chrome.usage` / `tokenMeter` are computed but unused; `StepMeta`
  is written but never imported. Wire the composer meter + per-message token footer;
  projector case for `usage_update` only if it must survive restart.
- **Neutral spawn cwd**: first `start()` fixes the provider process cwd
  (`AcpBackend.ts:263-287`); sessions get their own cwd via ACP, so spawn from a stable
  neutral dir to avoid first-workspace coupling.
- **Server capability negotiation**: `initialized` re-emits static config; merge the
  server's `agentCapabilities` where available.
- Optional cosmetics deferred: `acp:*` channel renames, OpenCode fallback defaults,
  provider icons.

---

## Phase 0 of the integration plan, in plain words

Phase 0 ("runtime refactor") is small and safe — it is **not** part of the above and can
wait until the actual Claude/Codex work starts. Today `AgentRuntime` does
`new AcpBackend(config)` for every provider (`AgentRuntime.ts:36`), and `ProviderConfig`
only describes ACP things (spawn command, ACP auth hints). Phase 0 just makes each
provider bring its own `createBackend()` factory so cursor/opencode keep returning
`AcpBackend` while claude/codex can return different backend classes. ~4 files, zero
behavior change. Verified accurate against current main.

## Suggested order

```
P0 → P1 ∥ P2 → P3 (needs P2) → P4 (needs P2) → P5 (needs P2+P4) → P6 → P7 (anytime)
```

After P1–P6, the integration plan's open questions Q2 and Q3 are already answered by
product surfaces, and Phases 0/1/2 of the Claude/Codex plan proceed on top of finished
permission/Q&A/plan/subtask pipelines.
