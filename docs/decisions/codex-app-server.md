# Codex through `codex app-server`

Status: Accepted, 2026-11-20. Runtime recorded from [CAL-244](https://linear.app/calledforth/issue/CAL-244/decide-how-openmanager-runs-codex); product, in its own section at the end, from [CAL-245](https://linear.app/calledforth/issue/CAL-245/decide-how-codexs-controls-and-features-appear-in-openmanager).

Openmanager runs Codex through `codex app-server`, the protocol Codex's IDE extension and T3 Code use: JSON-RPC as newline-delimited JSON over stdio, with no `jsonrpc` member. This page records how. Every claim marked _probed_ was checked live against codex-cli 0.170.0 on Linux (WSL2) on 2026-11-20; the earlier research covered 0.158 and 0.160.

## Runtime

### One app-server per session, under a Codex budget

Each openmanager session gets its own `codex app-server` process, held by its `SessionRuntime` exactly as a Claude or ACP session is. The session's subagents are child threads on that same connection and stay inside the runtime that owns the parent ([CAL-257](https://linear.app/calledforth/issue/CAL-257/keep-codex-subagent-threads-out-of-the-parent-and-stop-them-with-it)).

Why per session, when threads multiplex:

- It is the shape `SessionRuntimeRegistry` already manages: one runtime, one process, one liveness, one termination ladder. A shared process would make every Codex runtime a view over a connection someone else owns.
- A crash, a hang or a wedged MCP server takes down one session, not all of them.
- T3 Code made the same choice.

What it costs (_probed_, process tree only, one sample, RSS):

| State | RSS |
| -- | -- |
| `app-server` idle, after `initialize` | ~100 MB |
| + first thread | ~200 MB |
| + another thread, same process, Apps connector off | ~200 MB |
| + another thread, same process, default config | ~222 MB |

So the expensive part is a process's _first_ thread (one-time warm-up), not each thread: 20 sessions are ~4 GB as 20 processes against ~0.6 GB as 20 threads in one. The research's "each thread adds about 100 MB" was measuring first threads. These numbers have no user MCP servers in them. A stdio MCP server is a child process of the thread that starts it, so its cost comes on top, per thread, whatever the process model.

The memory is bounded by a budget rather than by sharing:

- **Cap.** A soft cap of **8 live Codex runtimes**, separate from the registry-wide `MAX_SESSION_RUNTIMES`. That is ~1.6 GB before MCP servers, the "~2 GB ceiling is 8" line in `session/constants.ts`. Built as `MAX_CODEX_SESSION_RUNTIMES`, a per-provider limit in `SessionRuntimeRegistryImpl` next to the global one, which evicts only among that provider's runtimes.
- **At the cap.** The same rules as the global cap: evict the least recently used Codex runtime that has no turn in flight, is not starting and is not `busy` (background terminals, running children). If every one is busy, go over the cap and log it, since nothing can be stopped safely. An evicted session resumes on its next prompt (`thread/resume`), so eviction loses no history.
- **Idle.** The existing 30-minute reaper, unchanged.
- **Children count.** A runtime with a running child thread is `busy`, so its children are counted through their parent.

Kept open: the client is written against a connection, not a process, so a shared pool can replace it later if the cap proves too tight. The decision would be revisited with real numbers from users with MCP servers configured.

Rejected: `codex app-server daemon`. It is a managed, long-lived app-server for SSH and remote control that the user's own Codex also drives, and its `update` "may interrupt running work". Our sessions would live on a lifecycle we do not own.

### One service process for work outside sessions

Account state, login, usage limits, the model catalog, sandbox setup, MCP status, thread listing, skills and file search are all needed when no session exists, and device-code login must stay alive until `account/login/completed`. A throwaway probe per question cannot hold a login open.

So `AgentRuntime` owns **one Codex service process per environment**: started lazily on first need, reaped after idle, never holding a thread. It also answers the boot probe ([CAL-250](https://linear.app/calledforth/issue/CAL-250/discover-codexs-account-policies-and-models-at-boot)), so discovery does not spawn a second process. It does not count toward the session cap. Built in [CAL-249](https://linear.app/calledforth/issue/CAL-249/run-a-codex-service-process-for-work-outside-sessions).

As built (`CodexService`, reached through `AgentRuntime.codexService(providerId)`):

- It runs in the user's home directory: it serves the environment, and a question about a project names its directory (`permissionProfile/list` takes `cwd`).
- It is reaped after **2 minutes** with nothing in flight, shorter than the 5-minute health interval, so an unused environment holds no standing ~100 MB and each health refresh pays a ~0.3s start instead.
- A crash fails what was waiting on it; the next request starts a fresh process. Each request has a 10s budget, below the health probe's 30s, so the request (not the probe) is what times out on a hung process. A request that times out, or that its caller abandons after waiting 5s, is taken as a hung process, which is replaced the same way. The boot probe's optional reads (profiles, policy, flags) have a 5s budget and never replace the process, since other reads may be mid-answer on it. Shutdown waits for every process it is stopping, including one being reaped or replaced.
- `account/updated` that says Codex is signed in again (or as someone else) makes the service read the account again, so health shows who; a sign-out drops the account's limits.
- `account/updated` and `account/rateLimits/updated` carry no `threadId`. They are merged into one provider-level state (rate-limit updates are sparse: a `null` keeps the last value). A sign-out announced this way reaches provider health at once. Only the service connection's are merged so far: a session's connection drops them, so limits a turn moves are not seen until the next read ([CAL-266](https://linear.app/calledforth/issue/CAL-266/feed-codex-usage-limits-into-provider-limits)).
- The runtime census reports it as `serviceProcesses`, beside the sessions and never among them.
- The boot probe reads `account/read`, then (signed in, or no sign-in needed) paginated `model/list`, `permissionProfile/list`, `configRequirements/read` and `experimentalFeature/list` (only `fast_mode` and `guardian_approval` are kept). `collaborationMode/list` is not read: there is no plan mode. Only the first two can fail the probe. While the service process is running, the probe costs no spawn, so the health monitor runs it beside its one-slot probe queue rather than behind other providers' CLIs. When it is not running (it is reaped between health ticks), the probe would start one, so it takes its turn in the queue like any other CLI. A probe announces `process_spawned` only when it started the process.

### Executable

Resolved in this order, by one helper shared with title generation (`apps/server/src/session-titles/generator.ts`), so `CODEX_BIN` means the same binary everywhere, as `acpCommandBin` does for ACP providers:

1. `CODEX_BIN`, already read by title generation.
2. `codex` on `PATH`. On Windows, an npm `.cmd` shim is resolved to the native `codex.exe` it wraps, so a session does not cost a `cmd` + `node` pair.
3. The standalone CLI the desktop app installs and keeps updated: `~/.codex/packages/standalone/current/bin/codex` (on Windows, reached through `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`). It follows desktop updates and was 0.144.6 on one machine in October, so its version is always read at runtime.

**Versions.** Read from `initialize.userAgent` (`OpenManager/0.170.0 (…)`, _probed_), so no extra `--version` spawn. **Minimum 0.160**, the last version the research covered end to end. **Recommended 0.170**, the version the vendored types are generated from. Below the minimum the provider reports unhealthy with "Update Codex to 0.160 or later", and no session starts. Between the two it runs, with a notice.

**Who may set the path.** Only the environment's trusted configuration (its env or config file). A path arriving over the wire would be remote code execution.

### Protocol types

Generated with `codex app-server generate-ts --experimental` into a vendored package, pinned to one CLI version (0.170.0: 187 client methods, 88 notifications, 11 server requests, _probed_), with a script that regenerates them and records the version. Hand-written types and T3's schema patches are not used.

Decoding is tolerant, because the surface moves weekly (four types changed between 0.158 and 0.160):

- An unknown notification, item type or server request is logged at debug, counted and ignored. It never fails the connection.
- An unknown server request is answered with `-32601` at once, never left pending.
- Enums that grow (`PlanType`, `ReasoningEffort`, item types, statuses) stay open strings at the decode boundary. Only the values we act on are matched.

### Experimental API

Opted in: `initialize` sends `experimentalApi: true`. Ordered approval choices (`availableDecisions`) and the `auto_review` reviewer depend on it, and so would plan mode (`collaborationMode`) and `turn/settings/update`, which are not used. Every experimental use has a fallback that keeps the session working when the field is missing or rejected: approval choices then come from the stable decision set.

### MCP extensions

`openai/form` is declared in `initialize` `capabilities.extensions` in the same change that answers `mcpServer/elicitation/request` ([CAL-259](https://linear.app/calledforth/issue/CAL-259/answer-codex-questions-and-elicitation-requests)), and never before it: declaring it without a handler invites forms nobody can answer. The legacy `mcpServerOpenaiFormElicitation` flag is not used. `requestAttestation` is `false`, and `attestation/generate` is declined.

### The user's Codex home

Openmanager shares `~/.codex` with the user's CLI and desktop app: one login, one config, the same skills and rules. `initialize` sends `clientInfo.name: "OpenManager"`, which becomes each thread's originator (_probed_: `userAgent` starts `OpenManager/0.170.0`). Our threads therefore appear in the user's Codex history, which is accepted.

What applies to our threads, by default:

| Setting | Default | Why |
| -- | -- | -- |
| MCP servers | Inherited | The user's tools should work the same in openmanager as in the CLI |
| Skills and rules | Inherited | Same |
| Hooks | Inherited | Same |
| Memories | Inherited | Same |
| Apps connector (`codex_apps`) | Inherited | Same. Costs ~20 MB per thread (_probed_) |
| `notify` program | **Off** | Openmanager sends its own notifications. The user's program would fire for every turn we run, doubling them |
| `update_plan` tool | **On** | Off unless a client turns it on (_probed_: with the default config the model has no `update_plan` and no `turn/plan/updated` arrives). It is what keeps the todo checklist |

Both are set per thread, by `config: { notify: [], "tools.update_plan.enabled": true }` on `thread/start` and `thread/resume`, never by editing the user's `config.toml`. _Probed_: with `notify` set globally, a thread without the override ran its program once per turn, and a thread with `notify: []` ran it zero times. Per-thread `config` also starts extra MCP servers (_probed_), so the mechanism is sound for any later default.

### Spellings

The same setting is spelled differently in different places (_probed_ against the generated types):

| Where | Type | Values |
| -- | -- | -- |
| `thread/start.sandbox`, `thread/resume.sandbox` | `SandboxMode` | `read-only`, `workspace-write`, `danger-full-access` |
| `turn/start.sandboxPolicy`, `thread/settings/update.sandboxPolicy` | `SandboxPolicy` | tagged objects `readOnly {networkAccess}`, `workspaceWrite {writableRoots, networkAccess, excludeTmpdirEnvVar, excludeSlashTmp}`, `dangerFullAccess`, `externalSandbox {networkAccess}` |
| `approvalPolicy` everywhere | `AskForApproval` | `untrusted`, `on-request`, `never`, or `{granular: {…}}` |
| `approvalsReviewer` | `ApprovalsReviewer` | `user`, `auto_review`, `guardian_subagent` |
| `summary` | `ReasoningSummary` | `auto`, `concise`, `detailed`, `none` |

Named permission profiles (`permissions`) are new since 0.160 and cannot be combined with `sandbox`/`sandboxPolicy`. Openmanager does not use them: the access presets ([CAL-245](https://linear.app/calledforth/issue/CAL-245/decide-how-codexs-controls-and-features-appear-in-openmanager)) map to explicit sandbox and approval values.

### Settings flow

- **Every `turn/start`** sends the session's model, effort, `summary: "detailed"`, approval policy, sandbox policy and `approvalsReviewer`, all of them, every time. _Not yet built:_ effort is not sent until the composer offers it ([CAL-260](https://linear.app/calledforth/issue/CAL-260/codex-models-reasoning-speed-and-access-in-the-composer)); everything else is. Turn overrides are sticky (_probed_: each `turn/start` with overrides emits `thread/settings/updated`), so a value left out is whatever the last turn set, not the default. T3 shipped a bug from a sticky reviewer. Sending the full set makes "what this turn ran with" a property of the turn, as `SessionRuntime.prompt` requires. Without `summary: "detailed"`, reasoning items arrive empty.
- **Between turns**, a change from the composer goes through `thread/settings/update`, and the state shown is read back from `thread/settings/updated` (_probed_), never assumed from what was sent. _Not yet built_ ([CAL-260](https://linear.app/calledforth/issue/CAL-260/codex-models-reasoning-speed-and-access-in-the-composer)): today a model change applies with the next `turn/start`, and the selection shown is the one written.
- **During a turn**, the model and effort are not changed. A change made while a turn runs applies to the next turn. `turn/settings/update` is experimental and is left unused for now.

### History

Openmanager's SQLite stays the transcript of record, as for every provider. For each Codex session we persist the native thread id (as `sessions.provider_session_id`), and the turn and item ids carried on the events we store, which revert, fork, dedupe and reconciliation need. Turn ids repeat across forks (`thread/fork` reuses the source's ids), so a turn id is always scoped by its thread id. New threads use `historyMode: "paginated"`, and history is read with `thread/turns/list` / `thread/items/list` instead of full-history `thread/read`, which the protocol now marks deprecated for paginated threads.

### Resume fallback

- **Missing thread.** `thread/resume` answers `-32600` with `no rollout found for thread id …` (_probed_). The runtime starts a fresh thread, durably re-stamps `provider_session_id` before the first prompt runs, and shows a note in the conversation that Codex lost the earlier context. _Not yet built:_ the note; the loss is only logged for now ([CAL-254](https://linear.app/calledforth/issue/CAL-254/keep-codex-sessions-consistent-across-restarts-outside-changes-and-errors)). Handing the context over with `thread/inject_items` is follow-up work ([CAL-254](https://linear.app/calledforth/issue/CAL-254/keep-codex-sessions-consistent-across-restarts-outside-changes-and-errors)).
- **Archived thread.** Unarchived, then resumed again once.
- **Malformed id.** Also `-32600` (`invalid session id: …`, _probed_), and treated as missing.
- Matching is on the message text as well as the code, because `-32600` is the generic invalid-request code. The matcher lives in one place with a test per known message.

### Subagents

A subagent is a child thread on its parent's connection ([CAL-257](https://linear.app/calledforth/issue/CAL-257/keep-codex-subagent-threads-out-of-the-parent-and-stop-them-with-it)), tracked by `CodexSubagents` (`session/codex/codex-subagents.ts`). What 0.170 does (_probed_, recorded in the `subagent` and `interrupt-with-child` fixtures): the child's whole stream (status, turns, items, deltas, usage, MCP startup) arrives on the parent's connection under the child's `threadId`; the child gets **no** `thread/started` and is known only from the parent's `subAgentActivity` item; interrupting the parent's turn does **not** stop a running child; ephemeral threads cannot spawn subagents.

- **Dispatch.** Every notification goes to exactly one place. One that names a thread goes to that thread: ours, a known child, or nobody. Without a thread id, only an allowlist (account, skills, apps, MCP, Windows, config warnings, standalone `command/exec`) is global; any other is dropped. A thread-scoped notification never falls through to the parent.
- **Registration.** A child is registered from `subAgentActivity` (`started`), from an older Codex's `collabAgentToolCall` `spawnAgent`, and from a `thread/started` naming a known parent. An activity or collab call that reaches a child we have not seen (one spawned before a restart) makes it known without a card or a place in `busy`, since Codex may have no such agent: it gets both once it runs a turn or a collab call reports it running, and a `notFound` state forgets it. A child's `turn/started` that arrives before it is registered is buffered, and a turn that started and ended before then is remembered, so the child registers settled (at most 32 threads each). A child's own subagents are children one level down. A closed child (`closeAgent`, `thread/closed`, a `shutdown` state) has its running card cancelled and is forgotten.
- **What the parent shows.** Until child pages exist ([CAL-279](https://linear.app/calledforth/issue/CAL-279)), each child is a subagent card (`subtask_update`, `taskId` = the child's thread id, anchored on the item that started it): running while its turn runs, then completed, interrupted or failed with its last answer, token total and tool-call count. The parent's other collab calls (`wait`, send, resume, close, interrupt, list) are tool rows, so its waiting shows. A child running on after the parent's turn ended (completed or failed), or one that starts while the parent has no turn, is reported `background`. Nothing of the child's own stream reaches the parent's turn, messages or usage.
- **Stop.** Cancel interrupts the parent's turn and every child turn, and resolves once the parent's turn has ended and those interrupts are sent: the host holds the session busy until then. Detached from it, the stop keeps looking (for children that start a turn late, and while the parent's turn is still ending) until none runs, bounded at 10 s; a new prompt or the process exiting ends the look. A card's stop (`stopSubtask`) interrupts that child and its own children the same way. A parent turn that does not end within the interrupt grace is closed by the runtime, and its process is then replaced (`stop({ reason: 'restart' })`), since Codex may still be running that turn; the session resumes on its next prompt, and children die with the process. A `turn/start` that times out replaces the process the same way, since Codex may be running a turn it never names to us; one Codex refuses started nothing and leaves the process be. If a `turn/start` answer names a turn the runtime already closed, that turn is blocked and interrupted, so its late events never reach a later turn. A finished turn's subagent items still reach `CodexSubagents`, so a child it spawned gets its card and keeps the runtime `busy`.
- **Busy.** A runtime with a running child is `busy`, so the idle reaper and LRU eviction leave it alone.
- **Never a session.** A child's id never becomes a session id, and `thread/resume` of a subagent's thread unsubscribes from it (`thread/unsubscribe`) and is treated as a missing thread. Listing (not used yet) must keep `thread/list`'s default interactive `sourceKinds`, which exclude subagent threads.

### Tool calls

Each tool item of the session's own turn is a tool call (`CodexTools`, `session/codex/codex-tools.ts`), keyed on Codex's item id, in the shape every provider's tool rows take (docs/sync-foundations.md §6.7). Shapes were checked against 0.170 in the `tool-items` and `terminal-interaction` fixtures.

- **Names.** A built-in tool keeps Codex's item type as its name (`commandExecution`, `fileChange`, `webSearch`, `imageView`, `sleep`); an MCP tool is `mcp__<server>__<tool>`, the name the model calls it by; a dynamic tool is `<namespace>.<tool>`. The shared presenter reads the rest from the input.
- **`commandExecution`.** Input: the command without Codex's `/bin/bash -lc '…'` wrapper, `cwd`, `source`, `commandActions`, and at the end `exitCode` and anything written to it with `write_stdin` (`stdin`, from `item/commandExecution/terminalInteraction`, which names the command it went to). Output streams from `item/commandExecution/outputDelta`; `aggregatedOutput` is what it settles with. A command whose actions are all `read` is a read, with the paths as locations and no output kept, like any read; one `search` or `listFiles` is labelled as that (`Searched for "x" in src`, `Listed src`); anything else is a command. Duration is the row's `startedAt` to `finishedAt`.
- **`fileChange`.** Every change (add, delete, update, move) as a file touched, with line counts read off the diff Codex reported for it. No diff leaves the runtime. `item/fileChange/patchUpdated` keeps it live.
- **`mcpToolCall`.** Arguments as input; `structuredContent` as the result when there is one, else the text content; images move into the reply under the call's id, like any tool's; an error fails it; `item/mcpToolCall/progress` streams as lines of output.
- **Others.** `dynamicToolCall`, `webSearch` (search, open page, find in page, from its `action`), `sleep`, `imageView`. Hook runs (`hook/started`, `hook/completed`) are rows of their own, and a `hookPrompt` item is a row holding the text the hook added.
- **Declined and cancelled.** Codex's `declined` status is the declined outcome. Codex has no status for an interrupted call: a call that fails while the turn is being stopped reads as cancelled, and one still open when the turn ends is closed as cancelled by the server.
- **Plan.** `turn/plan/updated` is the todo checklist (`plan_update`), and a row (`update_plan`) where the model updated it, since Codex has no item for that call.
- **Skipped on purpose.** `functionCallOutput` is the echo of a `toolOutput` a client hands Codex with `turn/start`; openmanager sends none. `item/fileChange/outputDelta` is deprecated and no longer sent. `plan` items and `item/plan/delta` belong to plan mode, which is not ported. `imageGeneration` is not translated yet.
- A subagent's own items stay out of the parent's turn (see Subagents).

### Notifications

`initialize` sends `optOutNotificationMethods`:

- `turn/diff/updated`: the whole turn diff on every change. Chat carries no diffs, and each file change's paths and line counts come with its own item. T3 opts out too.
- `remoteControl/status/changed`: remote control is out of scope (openmanager is the remote).

Everything else is received. Notifications we do not act on are dropped at decode, which is cheaper than maintaining a long opt-out list that changes with every CLI version.

### Platform notes

- **Linux.** Without `bubblewrap` on `PATH`, `app-server` logs an error and sends a `configWarning` at startup, then falls back to a bundled copy (_probed_). The warning is surfaced in provider health as advice, not a failure. _Not yet built:_ the warning is logged, not shown in health.
- **Windows.** The sandbox runs commands as a separate Windows user, which breaks Git ("dubious ownership") and `%TEMP%` folders. Until [CAL-273](https://linear.app/calledforth/issue/CAL-273/make-the-codex-sandbox-work-on-windows) solves it, native Windows defaults to Full access (see Access presets).

## Product

Recorded from [CAL-245](https://linear.app/calledforth/issue/CAL-245/decide-how-codexs-controls-and-features-appear-in-openmanager), 2026-11-20.

### Access presets

The composer's mode control for Codex is **Access**, with four presets. Each maps to the spellings above:

| Preset | `approvalPolicy` | `approvalsReviewer` | `sandbox` (thread) | `sandboxPolicy` (turn) |
| -- | -- | -- | -- | -- |
| Supervised | `untrusted` | `user` | `read-only` | `readOnly` |
| **Auto-accept edits** (default) | `on-request` | `user` | `workspace-write` | `workspaceWrite` |
| Auto | `on-request` | `auto_review` | `workspace-write` | `workspaceWrite` |
| Full access | `never` | `user` | `danger-full-access` | `dangerFullAccess` |

- **Default: Auto-accept edits.** Edits inside the workspace go through, and anything that leaves the sandbox asks. It is the closest match to Claude Code's `acceptEdits`, and it keeps the sandbox on.
- **On native Windows the default is Full access**, with a notice in the composer saying why, until [CAL-273](https://linear.app/calledforth/issue/CAL-273/make-the-codex-sandbox-work-on-windows) makes the sandbox usable. The Windows sandbox runs commands as a separate user, which breaks Git and `%TEMP%`, so a sandboxed default would fail in ways that look like Codex bugs. WSL and Linux keep the sandboxed default.

### No plan mode

Codex's plan mode (the experimental `collaborationMode`) is **not ported**. There is no Build/Plan toggle for Codex, and Access is its only mode control. This replaces the Build/Plan toggle agreed on 2026-10-06. A plan Codex writes on its own (`turn/plan/updated`) still renders as the ordinary plan checklist. [CAL-261](https://linear.app/calledforth/issue/CAL-261/plan-mode-for-codex-a-plan-card-you-can-implement-or-refine) is out of scope.

### Sign-in from the CLI only

Codex is signed in the way Cursor and OpenCode are: on the machine, with `codex login`. Openmanager has no Codex sign-in of its own. When `account/read` reports no account, provider health says "Run `codex login` on this machine" and no session starts. `account/login/*` is unused. [CAL-270](https://linear.app/calledforth/issue/CAL-270/sign-in-to-codex-from-openmanager) is out of scope.

### Threads: archive on delete, no import

- **Titles** go from openmanager to Codex (`thread/name/set`), so a thread is recognisable in the user's Codex history.
- **Deleting a session archives its Codex thread** (`thread/archive`). It never hard-deletes, so the thread can still be recovered in Codex.
- **An archive or delete made outside openmanager** does not delete the session. The next resume follows the resume fallback: it unarchives an archived thread, and starts fresh with a note when the thread is missing.
- **Existing Codex threads are not imported.** [CAL-276](https://linear.app/calledforth/issue/CAL-276/import-existing-codex-threads) stays parked.

How it works (_probed_ on 0.170):

- `thread/name/set` echoes `thread/name/updated` to the connection that sent it, every time, even for the same name, so the runtime drops the echo of its own names. Codex trims a name and keeps the rest (no collapsing, no truncation at 600 characters); an update that arrives while a set is unanswered counts as its echo even if it differs. A refused set is tried again after the next turn. Any other `thread/name/updated`, and the name a resumed thread already has when openmanager has no title of its own, is the agent's title, weighed like any provider title (fallback < provider < generated < user).
- Only user and generated titles are sent. A live runtime gets a rename at once; a session with no live runtime gets its title when its runtime next starts, so a rename never starts a process.
- Codex refuses `thread/archive` (and `thread/resume`) from a second process while another holds the thread ("already has an active writer"). So a deletion first waits for any start or stop of the session's runtime, then archives on that runtime's own connection when one is live (interrupting a running turn first), else on the environment's Codex service process (work outside sessions), and the runtime is then stopped. One service process serves every such archive, one at a time, so deleting many unloaded sessions starts at most one app-server and one hung archive fails alone; an archive the process exits under is tried once more. A live runtime that goes away during its archive hands it to the service process. A thread Codex no longer has (`no rollout found`) counts as archived.
- Removing a project retires its sessions the same way, since their rows go with it.
- Because of the same refusal, an outside archive can only happen while openmanager holds no runtime for the thread, and resuming it answers `-32600` "session … is archived". The runtime unarchives it and resumes once.
- `canDeleteSession` stays false: it advertises deleting from the provider's own list, which this is not.

Built in [CAL-271](https://linear.app/calledforth/issue/CAL-271/sync-titles-archive-and-delete-with-codex).

### Persistent approvals

"Always allow `<prefix>`" and network host rules write the user's Codex rules (`acceptWithExecpolicyAmendment` and similar). They need only the **`agent`** grant, the same as Claude Code's "Always allow", which also persists to the user's own settings. Openmanager does not add a stricter rule for one provider.

### Rewind

History only (`thread/revert`, which rewrites history and never files; `thread/rollback` no longer exists in 0.170), with a clear "files are not restored" warning, until the Wave 6 checkpoints exist ([CAL-264](https://linear.app/calledforth/issue/CAL-264/rewind-codex-sessions-history-only)).

### Queue

Openmanager owns the queue, and a setting chooses what Enter does while a turn runs (agreed 2026-10-06). Codex's native `thread/queue/*` is never used.

### Steer

A steered message goes out as `turn/steer` with `expectedTurnId` and the message's id as `clientUserMessageId` ([CAL-262](https://linear.app/calledforth/issue/CAL-262)). It carries no settings, so it runs on the turn's own model, access and effort. Codex echoes it as a `userMessage` item of the running turn, with that id as `clientId`, within milliseconds of accepting it and before the tool call under way ends (_probed_); the model reads it at its next step. That echo is where openmanager shows the message (`steer_delivered`), from its own copy.

- **Wrong or ended turn.** `-32600`, `expected active turn id … but found …` or `no active turn to steer` (_probed_). The steer is refused and the message is queued for the next turn.
- **Turn that cannot be steered** (a review, a compaction): `activeTurnNotSteerable`, refused the same way. Not probed.
- **No answer** (a timeout, a broken pipe) is not a refusal: Codex may hold the message, so it stays pending rather than being queued to run twice.
- **No take-back.** Codex has no un-steer. "Send now" only works while the steer waits for Codex to name the turn, before `turn/steer` goes out; after that `withdrawSteer` is false.
- **Turn ends first.** A steer Codex answered but the turn completed without echoing is given back (`steer_withdrawn`) and queued; none has been seen, even with an interrupt sent straight after the steer (_probed_). One still unanswered when openmanager closes the turn itself (an interrupt past its grace) counts as delivered, the side that never sends twice.
- **Mid-message.** Codex takes a steer even while the model is writing. Its delivery is held until the message or thought in progress completes, so the message is not split and the steer sits where the model reads it.
