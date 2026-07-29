# Session-scoped runtime — target design

The shared vocabulary for the 6-phase migration from one CLI process per
*provider* to one CLI process per *session*. Phases 1–4 should read this before
writing code and use these names verbatim.

Companion documents:

- `docs/t3code-lifecycle-reference.md` — the reference architecture (sections 3,
  4, 6, 7) with `file:line` citations.
- The measured facts driving the change (Cursor's process-global model state,
  the 11.5s per-message preamble, ~141 MB per process, ~10.2s cold start) live
  in the phase briefs and are quoted inline below where a number justifies a
  decision. Do not re-derive them.

Phase 0 shipped the types in `packages/agent-runtime/src/session/` and
`packages/shared/src/contracts/provider-health.ts`. Nothing is wired: no runtime
behaviour changed.

---

## 1. Ownership tree

```
AgentHost                       desktop wiring: IPC, Convex projection, status push
└── AgentRuntime                provider configs, event sequencing, capability gates
    ├── PermissionBroker        app-wide, keyed by requestId
    ├── ExtensionBroker         app-wide, keyed by requestId
    ├── SessionRuntimeRegistry  Map<ThreadId, SessionRuntimeEntry> — SOLE owner of runtimes
    │   └── AcpSessionRuntime   one per thread
    │       ├── AcpConnection       1 child process + 1 ACP connection
    │       ├── ACP session         exactly 1, created or loaded at start()
    │       ├── AppliedConfigCache  mirror of this session's config options
    │       └── resumeCursor        latest cursor seen on session/update
    ├── AcpProbeRuntimeFactory  throwaway processes: session/list, models, health
    └── ProviderHealthMonitor   Map<ProviderId, ProviderHealth>          (Phase 3)
```

Rules the tree encodes:

- **The registry is the only owner of a runtime.** Nothing else holds a
  reference that can outlive the entry. When a runtime exits, the registry drops
  the entry in the same tick — that is what makes "UI shows Healthy against a
  dead process" structurally impossible.
- **A runtime owns its process and its session, and nothing else.** It does not
  know about other threads, other providers, or the registry.
- **The brokers stay app-wide.** They are already keyed by `requestId` and each
  pending record carries `providerId`/`threadId`/`workspaceId`/`sessionId`, so
  `AgentRuntime.respondPermission(requestId, outcome)` keeps working with no
  requestId→thread lookup table. A runtime settles only its own thread's
  requests when it exits. (Phase 1 needs one additive broker method: a
  `settleThread(providerId, threadId)` that cancels with reason
  `'session_closed'` — the existing `cancelThread` uses `'tool_cancelled'`,
  which is right for a user cancel and wrong for a process death.)
- **Health lives above runtimes, liveness inside them.** See §5.

## 2. Lifecycle of one session, end to end

1. **Bind.** A job arrives for `threadId`. `AgentRuntime` binds the thread to a
   provider (unchanged) and calls `registry.ensure(spec)` with the
   `SessionRuntimeSpec`: `{threadId, providerId, workspaceId, cwd, sessionId?,
   resumeCursor?, desiredConfig?}`.
2. **Reuse or create.** An entry whose `providerId` and `cwd` both match is
   reused and `touch`ed. Any mismatch supersedes: stop the old runtime
   (`'cwd_changed'`), create a new one carrying `sessionId`/`resumeCursor` so
   history survives.
3. **Start** (`AcpSessionRuntime.start()`, ~10.2s cold on Cursor, ~5.8s on
   OpenCode; each step under its own timeout from `DEFAULT_RUNTIME_TIMEOUTS`):
   spawn with the spec's `cwd` → `initialize` → `authenticate` → `session/load`
   if a `sessionId` was supplied and the provider advertises it, else
   `session/new`. `session/load` fails with "Session not found" for a session
   that was created but never prompted, so it always falls back to
   `session/new`. Concurrent callers share the one in-flight start.
4. **Seed the cache.** The `session/new`/`session/load` response carries the
   full `configOptions` array with `currentValue` for free. `AppliedConfigCache.
   refresh(options, 'session/new')`. This is the read-back path (§4).
5. **Apply desired config once.** `applyDesiredConfig(spec.desiredConfig)`:
   model first, re-plan, then mode and values. On a fresh Cursor process this
   costs a handful of writes; on every subsequent message it costs **zero**,
   because the cache already matches.
6. **Prompt.** `registry.beginTurn(threadId, turn)` →
   `runtime.prompt({prompt, userMessageId})` → `registry.endTurn(threadId)`.
   Events stream out as `BackendEvent` already stamped with this runtime's
   `threadId`/`workspaceId`; `AgentRuntime.forward` is unchanged.
7. **Idle.** `lastActivityAt` advances on every prompt, cancel, config write and
   inbound event. After 30 minutes idle with no active turn, the reaper stops
   the runtime with reason `'reaped'`. ~141 MB RSS per `cursor-agent` process is
   why this is mandatory, not optional. The same ~141 MB is why
   `MAX_SESSION_RUNTIMES` evicts the least recently used idle runtime
   (`'evicted'`) when a ninth thread wants a process — see §9.
8. **Death.** Expected (`stop()` → SIGTERM → SIGKILL after 2s) or unexpected
   (the child exited on its own). Either way `AcpConnection.exited` resolves,
   the runtime settles its brokers, emits `process_exited` **to its own
   thread**, sets `exit`, and the registry removes the entry.
9. **Revival.** Lazy, on next use. `AgentRuntime.liveEntry` sees no live entry
   and re-enters `ensureSession` with the durable `sessionId` (+ `resumeCursor`
   and the last `desiredConfig` if they survived), so a respawn walks the same
   path a cold start does and re-applies desired config against the *new*
   process's own read-back — without which a respawned Cursor would inherit
   the model it restored from disk. `session/load` failing ("Session not
   found", the created-but-never-prompted case) falls back to `session/new`.
   Nothing supervises or auto-restarts: a thread nobody touches again stays
   dead and costs nothing.

## 3. State model — what lives where

| state | scope | lifetime | home |
|---|---|---|---|
| child process, ACP connection | per session | dies with the runtime | `AcpConnection` |
| ACP `sessionId` | per session | created once at `start()` | `AcpSessionRuntime.sessionId`, persisted as Convex `sessions.externalId` |
| applied config `currentValue` map | per session/process | dies with the process | `AppliedConfigCache` |
| `modelConfigId` / `modeConfigId` | per session | discovered at `start()` | `AppliedConfigCache` |
| `resumeCursor` | per session | in-memory; last value survives in `exit.resumeCursor` | `AcpSessionRuntime.resumeCursor` |
| `lastActivityAt`, `activeTurn` | per thread | in-memory, dies with the app | `SessionRuntimeEntry` |
| thread → provider binding | per thread | in-memory today | `AgentRuntime.threadProviders` |
| pending permission/extension requests | app-wide, tagged by thread | until settled | `PermissionBroker` / `ExtensionBroker` |
| `DesiredSessionConfig` (model, mode, values) | per **workspace + provider** | **persisted** | electron-store today (`getLastModelForWorkspace`, `getConfigValuesForWorkspace`) |
| `ProviderHealth` | per provider | in-memory snapshot with an age | `ProviderHealthMonitor` (Phase 3) |
| provider config (`ProviderConfig`) | per provider | static | `packages/agent-runtime/src/providers` |

The single most important line in that table is the split between **desired**
and **applied**:

- **Desired** is durable user intent, per workspace + provider. It survives
  process death, app restarts and machine reboots. It is what the composer
  shows.
- **Applied** is what *this* session's agent reported over *its own* wire. It is
  per-process and never persisted, because Cursor's on-disk state lies: a
  brand-new process was measured reporting `model=gemini-3.1-pro`, a value left
  behind by an already-exited process. Only a response from this connection is
  trusted.

There is **no cwd-keyed or workspace-keyed process registry.** `cwd` is a
property of a session runtime, never a lookup key.

## 4. The applied-state cache

Type: `AppliedSessionState`; implementation: `AppliedConfigCache`
(`packages/agent-runtime/src/session/AppliedConfigCache.ts`, already written and
tested in Phase 0 — Phase 2 wires it, it does not rewrite it).

**Where it lives.** Inside the runtime, one per process. It is constructed empty
and dies with the child, so a respawn can never serve state from a previous
process.

**How it is seeded.** From the `session/new` (or `session/load`) response, which
reports the full `configOptions` array including `currentValue` at no extra
cost. That is the whole trick: the state we need is already in a response we
already make.

**How the model is applied.** Through `session/set_config_option` on the option
whose `category === 'model'` (`AppliedSessionState.modelConfigId`), *not*
`session/set_model`. `set_model` costs ~2.9s even when setting the identical
value and returns `{}` — no state, so nothing can be cached. `set_config_option`
costs 1.4–3.0s but returns the full refreshed `configOptions` array. When an
agent advertises no model-category option, `ConfigApplyPlan.legacySetModel` is
true and the caller falls back to `session/set_model`, accepting that it cannot
cache the result.

**Refreshed by** — every one of these is a wire response, never a local guess
(`AppliedStateSource`):

- `session/new`
- `session/load`
- the `session/set_config_option` response
- the `config_option_update` session notification

**Invalidated by:**

| event | effect |
|---|---|
| process exit / respawn | cache dies with the runtime; the new one starts empty |
| model change | not invalidated — *replaced*. `refresh()` swaps the whole array so options the new model dropped disappear |
| a `set_config_option` that errors | nothing; the cache was never touched, so the next attempt retries |
| `config_option_update` notification | full replace |
| `current_model_update` / `current_mode_update` notification disagreeing with the cache | the notified value replaces the cached `currentValue` for that one option (Phase 2). The agent changing model/mode mid-session is in-session, not out-of-band, and the notification is wire-sourced; ignoring it would let a later write be skipped against a value the agent has moved away from. The rest of the list is repaired by the next write's response |
| an out-of-band change by another process | **cannot happen** — that is what per-session processes buy. Cursor emits no `current_model_update`, so there would be no way to learn about it |

**Which options are legal.** Modelled as map membership, not a hardcoded matrix.
The option set is model-dependent (`composer-2.5` advertises mode/model/fast;
`claude-opus-5` advertises six) and sending an absent option burns ~1.4s before
failing with `Unknown model config option: effort`. `decide()` returns:

- `'satisfied'` — `currentValue` already matches; **no RPC**
- `'apply'` — the only outcome that costs a round trip
- `'unsupported'` — the current model does not expose this option; never send
- `'invalid'` — the option exists but does not advertise this value; never send

**Ordering.** `plan()` puts the model first and sets
`staleAfterModelChange: true` when the model needs writing, because applying a
model rewrites the legal option set. Phase 2 must apply the model, feed the
response back through `refresh()`, then re-`plan()` the rest. Config *values*
survive a model round trip (`effort=low` persisted through
`composer-2.5 → claude-opus-5`), so a model change does not reset values — it
changes which are legal.

**Steady state on Cursor is 0 RPCs per message.** That is the ~11.5s of dead
preamble deleted.

## 5. Dead processes: liveness vs health

They are different questions with different owners.

**Liveness** — "is *this thread's* child process still running?" Owned by
`AcpSessionRuntime`, learned from `AcpConnection.exited`, which resolves from
the child's `exit` event, not from an RPC failing. Detection is therefore
immediate and does not require a user to fail a turn first. (This is where the
reference architecture is deliberately *not* copied: T3 Code watches
`child.exitCode` only for Codex and OpenCode; for Cursor and Grok a dead process
sits in the map with `stopped: false` until the next RPC fails. We watch every
provider.)

On exit, in order: settle this thread's pending permissions and extensions →
emit `process_exited` with the thread's own route → resolve `exited` and set
`exit` → registry removes the entry. `SessionRuntimeExit` carries `expected`,
`reason`, `exitCode`, `signal`, `forced` and the last `resumeCursor`.
`expected: false` with no `reason` is the definition of a crash.

Three current bugs this closes:

- `AcpBackend.emitAll()` iterates bound sessions, so a process that dies with
  zero sessions tells nobody. A runtime always has exactly one thread to tell.
- `AgentHost.setStatus` is a one-shot latch; `'unhealthy'` is in the union and
  never assigned.
- `AcpBackend.start()` early-returns when alive and silently ignores its `cwd`.
  `cwd` is now immutable spec, and a mismatch supersedes the runtime.

**Health** — "does this CLI work at all?" Owned by `ProviderHealthMonitor`
(Phase 3), expressed as `ProviderHealth`
(`packages/shared/src/contracts/provider-health.ts`): independent
`install` / `auth` / `runtime` / `models` / `lastProbe` / `update` axes instead
of one enum, plus a derived `ProviderHealthSummary` for badges that is computed,
never stored. Probes run in **throwaway processes** (`AcpProbeRuntime`) on a
timer, because on Cursor every model/config write is process-global — probing
inside a live session process would change the model a user's turn runs on.
`runtime` is the only axis fed by session runtimes; it is a rollup
(`liveProcesses`, `activeTurns`, `lastUnexpectedExit`).

`SidecarStatus` stays exported and unchanged so the current code compiles;
Phase 1/3 migrate `AgentHost`, the IPC surface and the renderer.

## 6. Where the vocabulary lives, and why

```
packages/agent-runtime/src/session/
  lifecycle.ts               ThreadId, SessionRuntimePhase, stop reasons,
                             TerminationRequest, ProcessExit, SessionRuntimeExit,
                             DesiredSessionConfig, SessionResumeRecord
  constants.ts               RuntimeTimeouts + DEFAULT_RUNTIME_TIMEOUTS,
                             SESSION_IDLE_TIMEOUT_MS, SESSION_REAP_INTERVAL_MS
  AppliedConfigCache.ts      AppliedSessionState, ConfigApplyDecision,
                             ConfigApplyPlan, AppliedConfigCache (implemented)
  AcpSessionRuntime.ts       SessionRuntimeSpec/Deps, AcpConnection(+Factory),
                             AcpSessionRuntime, SessionRuntimeFactory
  AcpProbeRuntime.ts         AcpProbeRuntime, AcpProbeResult, its factory
  SessionRuntimeRegistry.ts  ActiveTurn, SessionRuntimeEntry, SessionRuntimeRegistry
  index.ts                   barrel, re-exported from the package index

packages/shared/src/contracts/provider-health.ts
                             ProviderHealth and its axes, UNPROBED_PROVIDER_HEALTH,
                             summarizeProviderHealth
```

A single top-level `session/` directory rather than nesting under
`backends/acp/`: Phase 1 deletes `backends/acp/AcpBackend.ts` wholesale, and the
registry is a `core/` concern used by `AgentRuntime`. Keeping the whole
vocabulary in one directory keeps the migration diff legible and gives Phase 1 a
clean "new dir in, old file out" shape. `AcpBackend`'s wire-normalisation helpers
(`contentBlock`, `toolContent`, `normalizeModelListing`, `subtaskFromTool`,
`extensionRequest`, the elicitation and plan paths) are **not** being redesigned;
Phase 1 lifts them across as-is.

`ProviderHealth` lives in `@openmanager/shared` next to `SidecarStatus` because
that is what the renderer and IPC already import. It carries no `providerId`
field: it is always held in a map keyed by one, and `@openmanager/shared`
deliberately has no dependency on `@agentpack/contract`.

## 7. Migration order and seams

Each phase owns disjoint files. Where two phases touch the same file, the seam
is named.

**Phase 1 — process per session.**
Adds: `session/AcpSessionRuntimeImpl`, `session/ChildProcessConnection`,
`session/SessionRuntimeRegistryImpl`, `session/AcpProbeRuntimeImpl`.
Rewrites: `core/AgentRuntime.ts` (backends map → registry; `promptQueues`
becomes per-thread only), `apps/desktop/src/main/agent-host.ts`
(`ensureProvider` and `refreshSessionTitles` move to probe runtimes),
`apps/desktop/src/main/index.ts` (stop passing `process.cwd()` at startup).
Deletes: `backends/acp/AcpBackend.ts`, `AcpBackend.prompt`'s `promptTail`, and
`ProviderConfig.quirks.correlateSessionlessExtensionsToActivePrompt` together
with `extensionBinding`'s active-prompt branch — a process owning one session
has an unambiguous correlation target, so the sole-session fallback is always
correct. That restores Cursor concurrency.
Leaves alone: the applied-state cache (Phase 2 wires it), health (Phase 3),
reaper/timeouts/resume (Phase 4). Phase 1 may start runtimes without any
config-apply logic; `job-worker`'s blind preamble keeps working unchanged
because `setModel`/`setConfigOption` still exist on the runtime.

**Phase 2 — model/config cache.** `AcpSessionRuntimeImpl` (wire
`AppliedConfigCache` into `setModel`/`setConfigOption`/`applyDesiredConfig`),
`apps/desktop/src/main/job-worker.ts` (replace the per-message preamble in
`send_message`/`start_session_with_message`/`create_session`/`set_model` with a
single `desiredConfig`), and one seam in `core/AgentRuntime.ts`:
`RuntimeSessionArgs.desiredConfig`, which `ensureSession` puts on the spec
*and* reconciles after start — a reused runtime never sees its spec again, and
reconciling a warm session costs no RPCs. Does not touch the registry.

**Phase 3 — health.** New `core/ProviderHealthMonitor`, `AcpProbeRuntimeImpl`
usage, `agent-host.ts` status push, renderer badge, and the
`SidecarStatus`→`ProviderHealth` migration of the IPC surface. Its only overlap
with Phase 2 is `agent-host.ts`; Phase 2 should not touch that file.

**Phase 4 — lifecycle hardening.** New `core/SessionReaper` and
`session/timeout.ts`; per-RPC timeouts inside `AcpSessionRuntimeImpl` and
`AcpProbeRuntimeImpl`; SIGTERM→SIGKILL in `ChildProcessConnection.terminate`;
`reapIdle`, the LRU cap and an awaitable `shutdown` in
`SessionRuntimeRegistryImpl`; lazy respawn-with-resume in
`AgentRuntime.liveEntry`, which is what `setModel`/`setMode`/`setConfigOption`
now go through instead of throwing. `app.on('before-quit')` holds the quit open
until every child is gone. On Windows, `shell: true` makes the direct child
`cmd.exe`, not the CLI; termination therefore awaits `taskkill /T /F` against
the shell pid before treating the process tree as gone. POSIX keeps the
SIGTERM→grace→SIGKILL ladder against the CLI itself. See §9 for the decisions
it closed.

Respawn deliberately lives in `AgentRuntime`, not
`SessionRuntimeRegistryImpl.ensure`: the registry is handed a complete
`SessionRuntimeSpec` and has no business inventing a session id or a desired
config, whereas `AgentRuntime` already owns the durable route args and the
resume map. `ensure` stays the mechanism; `liveEntry` is the policy.

**Phase 5 — verification.**

## 8. Invariants

Later phases must not break any of these.

1. **A session runtime owns exactly one ACP session for its whole life.** No
   code path creates a second session on an existing runtime.
2. **A runtime owns exactly one child process for its whole life.** A runtime
   never respawns; a dead runtime is replaced.
3. **`cwd` and `providerId` are immutable on a runtime.** Changing either
   supersedes the runtime.
4. **The registry key is the thread id, never the ACP session id.** They
   coincide after `create_session` only because the job worker rebinds.
5. **The registry entry never outlives its process.** An exit removes the entry
   synchronously.
6. **Applied state is never persisted and never shared between processes.**
7. **Applied state is only ever written from a wire response** — `session/new`,
   `session/load`, a `set_config_option` response, or a `config_option_update`
   notification. Never from what we asked for.
8. **The model is applied before any other config option**, and the remaining
   options are re-planned against the refreshed list.
9. **Health probes never run in a session process.**
10. **The reaper never touches a runtime with a non-null `activeTurn`**,
    however long the turn has run.
11. **Every process exit reaches its thread**, expected or not.
12. **No provider-wide serialisation of prompts.** Two threads on the same
    provider run concurrently.
13. **Pseudo-thread ids (`desktop-bootstrap:*`, `session-metadata:*`) never
    create session runtimes.** Those callers use probe runtimes.

## 9. Decisions, resolved

Phase 4 closed the four lifecycle questions below. Each records what was
decided and why, so a later change argues with the reasoning rather than
rediscovering it.

- **Where `SessionResumeRecord` is persisted — nowhere new.** As recommended.
  The durable anchor is the ACP `sessionId`, already persisted as Convex
  `sessions.externalId`, and it arrives back on the args of every job that
  names a session — so a respawn survives an app restart with no new storage.
  `AgentRuntime.resumes` holds `resumeCursor` and the last `DesiredSessionConfig`
  in memory as best-effort optimisations on top: losing the cursor costs a full
  transcript replay, which is what the 90s `loadSessionMs` budget is for, and
  losing the desired config costs nothing because the caller re-supplies it on
  the next `ensureSession`. A SQLite-equivalent table would buy only the cursor
  across restarts, at the price of a schema and a staleness problem.
- **Timeout values.** The measured steps kept their budgets;
  `authenticateMs` went **30s → 60s**. Machine cost is 4.5s (Cursor) / 60ms
  (OpenCode), so everything past ~10s is not a latency allowance but an
  allowance for a CLI waiting on a *person*, and the two ways of being wrong
  are asymmetric — cutting a wedged agent off late looks like a slow app,
  cutting a real browser login off early destroys a sign-in. A dead CLI is
  still caught in milliseconds either way, because `bootstrap()` races every
  step against the child's own exit. New: `controlRequestMs: 30_000` covers
  every non-prompt live RPC (`set_config_option`, `set_model`, `set_mode`,
  `session/cancel`, `session/list`) — these sit on the prompt's critical path
  via `ensureSession`, so they need a ceiling. `session/prompt` deliberately
  has none.
- **Reaping a thread the user is looking at — no exemption.** Visibility is not
  use: reading generates no agent work, so a resident CLI buys nothing until
  the user types, and the entire cost of reaping wrongly is one ~10.2s
  respawn. An exemption inverts the policy exactly where it hurts — the
  focused thread is the one most likely to sit idle-but-watched overnight —
  needs a renderer→main "which thread is focused" channel whose staleness
  (window closed, renderer reloaded) would pin ~141 MB *forever*, and
  duplicates a signal `lastActivityAt` already carries. Full argument in
  `core/SessionReaper.ts`.
- **Concurrency limit — a soft LRU cap, `MAX_SESSION_RUNTIMES = 8`.** The
  reaper bounds memory in time, not in count: 20 threads touched inside one
  30-minute window is ~2.8 GB. Eviction converts an unbounded, unrecoverable
  failure (the OS killing the app mid-turn) into the bounded, recoverable one
  the reaper already produces. Enforced in `SessionRuntimeRegistry.ensure`,
  stop reason `'evicted'`. Soft: a runtime with a turn in flight is never
  evicted, so the cap is exceeded rather than a turn destroyed — the same
  reasoning as invariant 10.

Still open, and not Phase 4's:

- **`summarizeProviderHealth` policy.** The axes are the contract; the rollup to
  one badge word is policy and Phase 3 may tune it. The mapping shipped in Phase
  0 is a starting point, not a constraint.
