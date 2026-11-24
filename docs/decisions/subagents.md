# Subagents: one record, child sessions, one router

Status: Accepted, 2026-11-18. Recorded from [CAL-204](https://linear.app/calledforth/issue/CAL-204/decide-the-subagent-record-and-how-child-activity-is-routed-and-stored).

## Decision

Every subagent, whoever started it, is one **subagent record** on the parent's thread and one **child session** holding its work. A provider adapter only has to say which events belong to which subagent; the environment server files them, stores them, and carries them to clients the same way for every provider.

There are two origins:

| Origin        | Started by                                                  | Runs on                         | Child can be prompted by a person                   |
| ------------- | ----------------------------------------------------------- | ------------------------------- | --------------------------------------------------- |
| `native`      | the provider's own tool (Claude `Agent`, OpenCode/Cursor task) | the parent's provider process   | only where the provider allows it (OpenCode: yes; Claude, Cursor: no) |
| `openmanager` | our `spawn_agent` MCP tool                                  | any provider, its own process   | yes: it is an ordinary session                      |

Claude keeps its own `Agent` tool. Same-provider delegation stays native: it shares the CLI, its agent types (`Explore`, `Plan`, `.claude/agents`) and its own background wake-up. `spawn_agent` is for another provider, or for a child the user wants to talk to.

## The record

`SubagentSchema` in `packages/protocol/src/subagents.ts`. It travels whole in `subagent.updated` on the **thread whose transcript holds the call that started it** (the parent's, or for a nested subagent, its parent subagent's child thread), and in that thread's snapshot (`subagents`). Whole, so a repeat is harmless and the newest wins.

Fields: `subagentId` (ours, random), `parentSessionId`, `turnId`, `toolCallId` (the card's anchor), `parentSubagentId`, `depth`, `origin`, `providerId`, `modelId`, `agentType`, `title`, `prompt` (preview), `status` (`pending`, `running`, `waiting`, `completed`, `failed`, `cancelled`, `interrupted`), `waitingOn`, `background`, `childSessionId`, `promptable`, `stoppable`, `stats` (`toolCalls`, `tokens`, `durationMs`), `activity` (one line: latest tool or progress summary), `result` (preview), `statusReason`, `startedAt`, `finishedAt`, `updatedAt`.

## Identity

The runtime picks a `taskId` that is stable for the subagent's whole life within its session, and the server maps `(parent session, taskId)` to its own `subagentId`, stored with the child session's row so a restart finds it again.

| Provider | `taskId`                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| Claude   | the spawning `Agent` tool call id. Every frame of the subagent carries it as `parent_tool_use_id`, **including after a `SendMessage` revives it under a new tool call**, so it is known from the first frame and never changes. The runtime maps `task_*` frames (keyed by `agentId`) back to it, and keeps `agentId` as `providerTaskId` for `stopTask` and history. |
| Cursor   | `subagentSessionId`, joined to the parent call through `_meta.cursor.toolCallId` (later).                   |
| OpenCode | the child `sessionId` (later).                                                                             |
| Codex    | the child `threadId` (after Codex integration).                                                            |
| ours     | the server mints it at `spawn_agent`.                                                                      |

The issue proposed keying Claude on `agentId`. The tool call id is equivalent (the mapping is one-to-one and revivals keep it) and is available earlier, before `task_started`.

## Child sessions

Every subagent gets a `sessions` row with `parentSessionId` as soon as it is first reported, native ones included, so the child page is just a session page. The summary carries `subagent: { subagentId, origin, promptable }`. A child that cannot be prompted shows a read-only footer saying only the parent agent can reach it; its parent can still revive it (`SendMessage`), which opens a new turn in the same child. The row is idempotent on `(parent, taskId)` and respects `forgottenChildren`. The child of a nested subagent is filed under its parent subagent's child session, so the session tree follows the agent tree. Clients do not list subagent sessions in the sidebar: the parent's card shows how many it has, its cards in the chat open them, and a child page's title bar trail reads project / parent / subagent with the parent as the way back.

## Routing

One router in the server, not one per provider. A runtime marks an event that is a subagent's work with `subtaskId` (`AgentEventBase`). The server sends such events to the child's record and projects them with the same code that projects a session's own turn: text, reasoning, tool calls, notices. Events without `subtaskId` are the session's own, as before. The Claude translator stops dropping `parent_tool_use_id` frames and the ACP runtime stops dropping updates for other sessions; both tag instead.

Claude specifics: the query sets `forwardSubagentText: true` and `agentProgressSummaries: true`. Subagent text arrives as whole blocks (no `stream_event`s), so the child streams by block. `task_started`/`task_progress`/`task_updated`/`task_notification` drive the record.

## Persistence

A child's events are stored as the child thread's own turns, messages and tool calls in the event log, so reload and replay come from our store even when the provider cannot replay (Cursor). A child turn opens when the subagent starts or is revived (`origin: 'delegated'`, its user message is the prompt the parent gave) and settles with the subagent. The parent's transcript keeps the `Agent` tool call as an ordinary tool call; clients show the card in its place by `toolCallId`. The guard that drops events for a turn that is not active applies to the child's turn, not the parent's, so a background subagent that outlives the parent turn keeps streaming into its own child. Filling a child from `getSubagentMessages` for history we never saw is left for later.

## Permissions and questions

A permission or question carrying `subtaskId` is filed on the child's thread, shown on the child page, and answered there. The card shows `waiting` with `waitingOn`, and the parent session's status says `waiting` too, because the parent's provider is blocked on it. The answer goes back to the parent's runtime under the same request id.

## Stopping

`subagent.stop` (`agent` access) stops one subagent from its card. Native: `SessionRuntime.stopSubtask(taskId)`, which is Claude's `query.stopTask(agentId)`. Ours: interrupt the child's turn. `stoppable` says whether the card offers it.

## The spawn tool

Tools on the host MCP server every session already gets (`packages/agent-runtime/src/tools/agent-tools.ts`, as `link_pull_request` is):

- `spawn_agent({ provider, model?, prompt, title, background? })` creates a child session with `origin: 'openmanager'` on the chosen provider, sends the prompt, and returns its `subagentId`. `background` defaults to **true**: it returns at once. With `background: false` it waits up to 45 s (under common client tool timeouts) and returns the answer, or the handle if the child is still running.
- `wait_agent({ id, timeoutSeconds? })`, capped at 45 s.
- `send_agent({ id, message })`: a follow-up to a child, queued if it is busy.
- `list_agents()`: this session's whole subagent lineage as an indented tree: its `spawn_agent` children and its provider's native ones (Claude's `Agent` tool and the like), with each one's own children nested under it at any depth (`SpawnHost.subagentsOf`, the records filed on a session's thread, live ones from memory and settled ones from the rows). Each entry gives the subagent id and child session id, status (and what a waiting one waits on), provider/model, title, how it was started, what it was asked (a one-line preview), what it is doing now while live, how long it ran, its tool count when known, and whether this session can act on it: only its own direct `openmanager` children take `send_agent`/`wait_agent`/`stop_agent`. Live ones first. Then the providers and models a child can use. Its description steers a model to it over its own task or agent listing tool, since it shows what the user sees.
- `list_active_agents({ scope? })`: every agent live in the environment now, of every provider and origin, as lineage trees grouped by project (`SpawnHost.activeAgents`, built from memory: running sessions are always loaded, and every subagent reported since boot is remembered; boot settles the rest). Live means a session running, waiting on the user or running only background work, or a subagent not yet settled. A live agent's ancestors are shown for context and marked idle. Each line gives the id to refer to it by (its session id, or the subagent id when its child session was deleted), title, provider/model, status, how long its current turn has run, what it is for (a subagent's prompt preview), what it is doing now (the latest tool call, a native subagent's progress, or a background task), and its relation to the caller: `you`, `your subagent` (marked when it is the caller's to act on), `your subagent's subagent`, `your parent`, `your ancestor`, `sibling`, or nothing. `scope: 'project'` keeps the caller's project only; the default is `'all'`. It says so plainly when nothing else is running, and stops after 60 agents with a count of the rest. It is read-only: it gives no way to reach a session that is not the caller's own child.
- `stop_agent({ id })`.

`wait_agent`, `send_agent` and `stop_agent` take either the subagent id or the child's session id, as the listings show both. They work the same on a child of every provider (Claude, Codex, Cursor, OpenCode): a child of ours is an ordinary session, so a follow-up is `startTurn` (or `enqueue` behind a busy turn) and a stop is `interruptTurn`, with nothing provider-specific on the way.

**Waking the parent.** An MCP tool cannot start a turn in the model, but the server owns the parent session. When a background child settles and its result has not been read with `wait_agent`, the server adds one message to the parent's queue with `origin: 'subagents'`, naming each finished child, its status and its answer (cut, with a pointer to `wait_agent` for the rest). Children that settle together share one message. It runs as a turn with `origin: 'subagents'` as soon as the parent is idle, or after its current turn, so it works the same whether the parent is Claude, Codex, Cursor or OpenCode. Clients show it as a notice, not as a message the user typed. A child the user stopped does not wake its parent.

**Limits.** A child of ours never runs in a broader permission mode than its parent; by default it starts in its provider's default mode, so its permission prompts appear on its child page. At most depth 2, 4 running children per session and 8 per turn, with clear errors back to the model. The card claims the `spawn_agent` tool call, found as the parent's pending call of that tool in the active turn.

The tools are on by default in local environments while the feature is young, with an environment setting to turn them off. CAL-211 proposed off by default; revisit before a public release.

## Nesting

Claude allows depth 2, Cursor 1, OpenCode is configurable. The record's `depth` and `parentSubagentId`, and the child-of-child session row, carry the tree. The parent chat shows cards for its direct subagents only; a nested subagent's card lives in its parent subagent's child page.

## Alternatives considered

| Alternative                                            | Assessment |
| ------------------------------------------------------ | ---------- |
| Route Claude's own subagents through `spawn_agent` too | Loses agent types, the shared CLI and Claude's own background wake-up for no gain on same-provider work. |
| Keep subagent work in the parent's transcript, nested  | Every client reimplements the tree, and the parent's history grows with every child's tool output. A child session reuses the session page, replay and tool renderers as they are. |
| No session row for native subagents                    | The child page would need its own transport and storage path; replay for Cursor (which cannot) would need a second store. |
| Per-provider routing (each runtime drops or forwards)  | What we had. Every new provider repeats it, and each did it differently. |
| Poll-only `wait_agent`, no wake                        | The model either blocks a turn or forgets; waking through the queue matches what Claude does natively and costs nothing. |
