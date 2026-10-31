# Sync foundations: design (phase F1)

Status: revision 3.2. Revision 2 took in the gpt-6.1 and Fable reviews; revision 3 reworked liveness
and flow control (§7.2, D13) after gpt-6.1's confirmation pass; 3.1 caps fragment size at 8 KiB so a
sudden rate drop cannot trip the browser watchdog (C4). Appendix B says what was accepted,
changed or rejected. No code in this phase. **Approved by the user on 2026-10-18**, with Q2
(sidebar in F5) decided as "include". Revision 3.2 adds §4.7: what the user decided after F2
(X1, X2, S17, S18, S19, the crash-window seam), what stored events need across F3's format change,
and the corrections F3's verification found. §4.7 cites the tree at ad1e856, not 606e2cc.
Base: `main` at 606e2cc, protocol v16, migrations 1–19. PR #219 (session states, migration 20) is
assumed to merge first; §10.2 lists every place it touches the same code.
Audience: the builders and reviewers of phases F2–F7.
Rules: `~/.t3/reviews/sync-audit/decisions-and-roadmap.md`. This doc designs to them and does not
reopen them.

All `file:line` references are to the 606e2cc tree unless prefixed with a PR number
(`#212:` = `cal-227-tool-payloads` at 4141fa0, `#213:` = `cal-230-notices` at bbdd23d plus its
uncommitted working tree, `#219:` = `session-states` at 4c46f08).

---

## 0. Decisions at a glance

| #   | Question                                                           | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Main reason                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Where restart recovery runs                                        | Once per boot, after the event service exists, before the server listens. It moves out of `openEnvironmentDatabase`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Events need the repository. The open function also runs 7 times per boot today                                                                                                                                                                                                                                                                                                                                 |
| D2  | What recovery writes                                               | Ordinary events through the repository, **one transaction per open turn**: a close event for each open tool, thought and question, then `turn.interrupted {reason: 'server_restarted'}`. The existing streams, epochs and sequences, with no epoch bump. A turn whose transaction fails is logged with its ids, left as it is, and retried on the next boot. Boot continues                                                                                                                                                                                                                                                                                                   | A client resuming from its bookmark replays exactly what changed. One bad turn cannot cause a crash loop                                                                                                                                                                                                                                                                                                       |
| D3  | Legacy open tools and thoughts under turns that have already ended | An idempotent **boot repair** through the repository emits close-only events for them (`tool.updated {status:'cancelled'}`, `message.reasoning {phase:'stop'}`). For a finished turn, the projector accepts only these monotonic closes and rejects every other late event. No migration rewrites rows and no epoch is bumped                                                                                                                                                                                                                                                                                                                                                 | Rule 2 has no exception. It ships in F3                                                                                                                                                                                                                                                                                                                                                                        |
| D4  | Turn end: child events, or a terminal that carries the children?   | **Explicit child events, written before the terminal event in the same transaction.** The server builds them from the rows inside that transaction. The terminal's projection asserts nothing is left open. The derived `session.updated` is computed **once per session per transaction**                                                                                                                                                                                                                                                                                                                                                                                    | One write path per entity on both sides. Replay equals live. No `waiting→running→error` flicker                                                                                                                                                                                                                                                                                                                |
| D5  | Turn `waiting`/`running` while questions are open                  | Every interaction event carries `turnState`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | The client sets the state, never derives it                                                                                                                                                                                                                                                                                                                                                                    |
| D6  | Command responses                                                  | A mutation's response acknowledges its command and settles the client's overlay entry. **Only events, snapshots and read answers (§4.7.10) change server-owned state.** A response that must carry a change carries its durable record, applied by cursor; nothing on the chat path needs one. An overlay entry lives until its command **fails**, or until server state no longer shows the item pending                                                                                                                                                                                                                                                                     | One authoritative path. No regression from a retried `turn.send`. No flicker on `interaction.respond`                                                                                                                                                                                                                                                                                                          |
| D7  | The ordered queue                                                  | Take #213's `event-delivery.ts` and extend it into one process-wide FIFO. `workspace.*` no longer skips it. A transient flushes the batcher first, carries `after` (its scope's head cursor), and goes only to subscribers. The client applies a transient only when `after` equals its cursor. A send that fails closes that connection. The batcher stays                                                                                                                                                                                                                                                                                                                   | Delivery order = commit order. Lost records are detected                                                                                                                                                                                                                                                                                                                                                       |
| D8  | Replay framing                                                     | One logical answer, built in the same tick the subscription is registered, with no cap. The transport splits it into fragments. The answer is complete at its last fragment. Live events follow it in the FIFO                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Point-in-time consistency and an atomic apply, without holding SQLite read snapshots open                                                                                                                                                                                                                                                                                                                      |
| D9  | Replay or snapshot                                                 | Snapshot when the log no longer has the events. Otherwise compare **exact** sizes: replay bytes are `SUM(octet_length(event_json))` plus the exact envelope. The snapshot is serialized only when replay bytes exceed a cheap exact lower bound on its size. Ties go to replay                                                                                                                                                                                                                                                                                                                                                                                                | A comparison, as rule 4 says, with no estimation constants                                                                                                                                                                                                                                                                                                                                                     |
| D10 | Snapshot contents                                                  | The whole thread, and the whole environment (sessions, workspaces, composer preferences). The client replaces its copy. `session.history` is deleted. `session.open` stays, for identities and resuming the provider runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                  | One read model                                                                                                                                                                                                                                                                                                                                                                                                 |
| D11 | Workspace and composer writes                                      | Every write (register, rename, availability, recency, removal, preferences, provider profiles) becomes event + projection in one transaction. Caches update after commit. Snapshot reads never write                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The crash window and the out-of-band writes go away                                                                                                                                                                                                                                                                                                                                                            |
| D12 | Limits                                                             | Delete every outbound cap and budget. Keep the inbound 64 KiB, the connection/subscription/command counts, rate limits and retention                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Rule 5                                                                                                                                                                                                                                                                                                                                                                                                         |
| D13 | Liveness and flow control with big messages                        | **Two mechanisms.** _Liveness:_ the browser sends a beat upstream every 10 s; the server declares a connection dead only after 30 s with no inbound frame; the server sends a keepalive when idle; the browser's watchdog (45 s) resets on every received frame. _Flow control:_ the server writes only while unacknowledged bytes are under a send window (256 KiB, auto-tuned up to 4 MiB). Past a 1 MiB backlog, the affected scopes go **lagging**: their queued frames are dropped and a catch-up answer (D9 rule) is sent when the window reopens. Large messages go out as binary fragments sized to the measured rate, between 512 B and an absolute cap of **8 KiB** | Liveness has no server-side throughput floor. Because a browser sees only whole frames, it has two floors: about 12 B/s in steady state, after adaptation, and about 182 B/s while the frames already in flight drain after a sudden rate drop, at the 8 KiB cap. Memory per connection is bounded by window + backlog + one answer per lagging scope, without losing content. This is the TCP/HTTP2/SSH split |
| D14 | Write failures                                                     | **Rows are the truth; memory follows commits.** A failed write is retried and the in-memory state does not advance past it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Single writer. Failing the turn would itself need a write that fails for the same reason                                                                                                                                                                                                                                                                                                                       |
| D15 | Convergence harness                                                | The real `startServer` in a child process (so it can be killed), with title generation off; the real `environment-client`; a TCP proxy that shapes the link; a fake ACP provider. Scripted and seeded-random runs. Normalized state is compared with a fresh load. Each expected failure on main is a stated construction, demonstrated with a structural diff                                                                                                                                                                                                                                                                                                                | Rule 6, against the real thing                                                                                                                                                                                                                                                                                                                                                                                 |

---

## 1. Why: the four weaknesses

- **W1. Silent recovery.** `recoverInterruptedTurns` rewrites sessions, interactions, messages and
  turns in SQL (`apps/server/src/db/database.ts:42-105`). It runs from `openEnvironmentDatabase`
  (`database.ts:28`), before any event service exists (`server.ts:263` vs `:267`). The event log is
  untouched, so a replay from a pre-crash bookmark comes back empty and valid
  (`replay.ts:154-176`), and the client keeps showing the turn as running.
- **W2. The snapshot merge.** `applySnapshot` keeps older messages
  (`packages/environment-client/src/state.ts:572`, `:616-622`) and the history cursor (`:588-594`),
  rebuilds the older order from messages alone (`:584-587`), and replaces all reasoning and tools
  (`:595-596`). #212 and #213 then stacked about 16 guess rules on top (provenance audit §2d).
- **W3. Split delivery.** Durable events go out through the batcher (≤100 ms,
  `db/event-batcher.ts:11`) and then on a microtask (`server.ts:284-286`). Transient events go out
  at once (`thread-service.ts:885` → `server.ts:757` → `websocket.ts:609-613`). On the client,
  durable records are buffered during recovery (`environment-client/src/websocket.ts:609-612`), but
  transient ones are applied at once (`:630-635`).
- **W4. The 1 MiB close.** `send` closes with `slow_consumer` when
  `bufferedAmount + frame > 1 MiB` (`apps/server/src/websocket.ts:248-251`). A single large frame
  on an idle socket trips it. Every other bound in the path exists because of it (§7.1).

Real data (2026-10-17, no tool output stored yet): 123 chats; typical 20 KB, p90 85 KB, largest
271 KB (209 messages); 3.4 messages and 64 events per turn; the longest turn has 1,361 events; an
average event is 687 B.

---

## 2. Invariants

Each phase must establish or preserve these, and the reviewers check against them.

- **I1, single writer, no exceptions.** Every change to a row a client can see (`workspaces`,
  `sessions`, `threads`, `turns`, `messages`, `message_parts`, `turn_activity`, `interactions`,
  `drafts`, `workspace_composer_preferences`, `provider_profiles`) happens inside
  `EventRepository.write` (`db/event-repository.ts:244-269`), as the projection of an event logged
  in the same transaction.
  - Host-private columns no client sees (`sessions.provider_session_id`) and retention (which
    shrinks the log, not the domain) are not changes of client-visible state.
  - Migrations add tables, columns and indexes only. They never change client-visible rows.
    Corrections of existing data are boot repairs that emit events (§4.2).
  - An epoch changes only when a scope's history itself is replaced, for example a database
    restored from a backup. It never changes to signal a row edit.
- **I2, total and explicit projection.** An event changes only the entities it names, plus fields
  it declares, such as `turnState`. The server projector and the client fold are the same function
  of (state, event). Where practical they are the same code: a per-entity reducer in
  `@openmanager/protocol`, as #212's `applyToolUpdate` already is
  (`#212: packages/protocol/src/tool-state.ts:21`).
  - A projector guard that silently drops part of an event is a bug; guards become assertions that
    roll the write back.
  - For a finished turn, the only allowed child events are monotonic closes: tool → `cancelled`,
    reasoning → `stop`.
- **I3, close before end.** When a turn ends, by any path including recovery, each open tool,
  thought and question gets its own closing event. Those events commit in the same transaction as
  the terminal event, and before it.
- **I4, one order.** Per connection, the server sends frames in commit order. A transient frame
  carries the cursor it follows (`after`). A frame that cannot be sent closes that connection. The
  one exception is a scope that went lagging (§7.2): its dropped frames are replaced by one
  catch-up answer, and the answer is that scope's recovery boundary.
- **I5, exactly once, by cursor.** The client applies a durable record only when its sequence is
  cursor + 1 in the same epoch. Lower sequences are ignored. A gap or an epoch change starts a
  recovery. A transient is applied only when `after` equals the cursor.
- **I6, whole snapshots.** A snapshot is the entire state of its scope at its cursor. Applying one
  replaces the server-owned part of the client's copy.
- **I7, no size-driven behaviour.** The sync path has no cap, budget, omission marker or
  size-based close. Fragmenting is transport only and never changes what is delivered.
- **I8, liveness and flow control are separate.** Liveness is upstream beats plus the browser's
  watchdog, and it closes only silent connections. Flow control (a send window and the lagging
  rule) bounds server memory, and it never closes a live connection or drops content.
- **I9, convergence.** The F2 property holds (§8).
- **I10, mutation responses do not author state.** A **mutation** command's response settles its
  command and its overlay entry, and never writes server-owned client state. A **read** command's
  answer is the server stating a fact and is applied as such until F5's whole-environment snapshot
  replaces it (§4.7.10).
- **I11, rows are the truth.** Server memory (thread records, caches, the workspace registry)
  follows committed records and never runs ahead of a failed write.

---

## 3. Rule 1: the server is the only author

### 3.1 (a) Today

The web client derives, guesses, merges or compares server state in more than 30 places. The full
audit is in §3.6. The structural causes:

- **Thread state.** The client fold settles children that the server never settles:
  - `closeReasoning` (`packages/agent-view/src/fold/foldProtocolEvent.ts:80-86`), applied at
    `:137`, `:169-172` and `:211`;
  - pending interactions dropped at a terminal event (`:138`).

  The server rows keep the thought open (`event-projection.ts:326-351`).

- **Turn state** is derived from interactions on the client (`state.ts:310-351`, `:518-535`), and
  separately in the server projector (`event-projection.ts:496`, `:521-523`).
- **Snapshot and history merges** (`state.ts:547-622`, `:651-733`) are keyed by hydration state
  rather than by data.
- **Command responses written into server state.** Each of these responses writes server data
  into the store:
  - `turn.send` → `applyTurnStarted` (`websocket.ts:1387`);
  - `session.create` → `applySessionCreated` plus an invented status (`:1208-1239`);
  - rename and regenerate → `applySessionTitle` with an invented `titleSource` (`:1346-1355`). The
    response is a bare `Session` (`protocol/src/commands.ts:251`, `:253`) with no provenance;
  - acknowledge, delete and workspace remove (`:1362-1373`, `:1183-1189`);
  - composer preference answers, ordered by client-issued tickets (`:1089-1130`).

  A retried `turn.send` is answered from the command cache with the turn as it was at the start
  (`thread-service.ts:1414-1419`). Only `confirmTurnStart`'s keep-existing guard
  (`state.ts:777-785`) stops that answer from rewinding a turn that has since advanced.

- **Optimistic overlays that write into server data:**
  - the settle tracker masks server events (`settle.ts:69-79`, applied at `websocket.ts:599`);
  - interaction answers remove the server's interaction and flip its turn (`state.ts:861-867`).
- **Mirrored cascades:**
  - session children (`state.ts:353-391`);
  - a workspace's sessions (`state.ts:912-931`);
  - workspace recency (`state.ts:253-270`);
  - `updatedAt` from event timestamps (`state.ts:432`).

### 3.2 (b) Target

The client state has two parts.

**Server-owned state:** sessions, workspaces, composer preferences, and each thread's turns,
messages, reasoning, tools, order and pending interactions. It changes only through:

1. a durable record applied by cursor (I5);
2. a snapshot replace (I6);
3. a durable record carried in a command response, applied through the same cursor path. A record
   ahead of the cursor is parked until the stream catches up, and dropped once the cursor passes
   it. No chat-path command needs this today; the path exists so no response ever needs a second
   rule.

Read responses for **current readings** that are not event-sourced (provider catalog and health,
the device list, filesystem browse) are applied as whole readings. They are not part of the
synced durable state.

**Client-owned state:** drafts and draft edits, active selection, hydration flags, connection
state, and a `pending` overlay for the user's own unconfirmed actions:

| Overlay entry                                 | Created by                          | Shows                                     | Removed when                                                                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending.sends[commandId]` (today's outbox)   | `sendTurn`                          | the echoed prompt                         | a turn with that `commandId` is in server state; on failure it turns into the failed row the user can retry                                                                                                   |
| `pending.creates[sessionId]`                  | `createSession`                     | the new session row and its first message | server state has the session                                                                                                                                                                                  |
| `pending.answers[interactionId]`              | `respondToInteraction`              | hides the prompt                          | server state no longer lists the interaction as pending, or the command fails with anything except `conflict`. A conflict means it was answered elsewhere, so the prompt stays hidden until the event says so |
| `pending.settles[sessionId]`                  | `settleSession` (latest click wins) | the requested settled/active placement    | server state's `settledAt` matches the request (null vs set), or the command fails                                                                                                                            |
| `pending.acks[sessionId]`                     | `acknowledgeSession`                | not done                                  | server state's `doneAt` is null, or the command fails                                                                                                                                                         |
| `pending.removals[id]`                        | delete session, remove workspace    | hides the row                             | server state no longer has it, or the command fails                                                                                                                                                           |
| `pending.preferences[workspaceId:providerId]` | composer set commands               | the requested selection                   | server state's preference `revision` is at least the revision the command's acknowledgement named, or the command fails                                                                                       |

- Selectors compose overlay and server state for display.
- The overlay never writes into server-owned state.
- A disposed or disconnected transport fails its pending commands (`rejectAllPending`,
  `websocket.ts:354-358`), which removes their entries. The screen falls back to the server's last
  word.

The fold (`foldProtocolEvent`, `applyEvent`) becomes a set of per-entity reducers; each event
touches only what it names (I2). Derived **views** are allowed in selectors, because they are
recomputed from server state and never stored, for example `selectActiveTurn`. Structural sharing
is allowed: keeping an object's identity when its new value is deep-equal still yields exactly
what the server sent.

**Composer preferences get a server revision.** Each `(workspaceId, providerId)` preference row
gets a `revision` integer, incremented by its projection. The `composer.preferences.updated` event
carries the preference with its revision. Set commands answer with an acknowledgement naming the
revision they produced. The environment snapshot carries every preference, so the client never has
to read one on demand, and the ticket ordering goes (§3.6 row 26).

### 3.3 (c) Protocol and schema

Specified with the rule that needs them: §4.5 (rule 2), §5.3 (rule 3), §6.3 (rule 4). The ones
only rule 1 needs:

- **Responses keep their shapes.** The client uses a mutation's response only for ids and for
  settling overlay entries; read answers stay applied as facts (§4.7.10). That needs no schema change, and so no compatibility break beyond the version bump.
  - The `turn.send` answer's `TurnStart` is used for its `turnId` and `commandId`.
  - The `session.create` answer is used for its `sessionId` and `threadId`.
- `TurnSchema` gains `commandId` (from the existing `turns.command_id` column), so
  `pending.sends` is reconciled by id, not by text.
- `turn.started.payload.turn.startedAt` is always set by the server.
- `session.updated` gains `updatedAt` whenever it changes the sidebar sort key.
- `composer.preferences.updated` gains `revision`, and preference acknowledgements carry it.
- `session.created`'s payload becomes a full `SessionSummary` (F5, §6.3).

### 3.4 (d) Deleted

- Everything marked "delete" or "replace" in §3.6.
- `applyTurnStarted`, `applySessionCreated`, `applySessionTitle`, `applySessionAcknowledged`,
  `applySessionSettled` and `applyInteractionResolved` as response-driven writers.
- `confirmTurnStart` (`state.ts:769-802`). It is deleted only **after** responses stop writing
  turns, in F3, because until then its guard is what stops a cached retry answer from rewinding a
  turn.
- The late-join synthesis of unknown turns (`state.ts:312-318`; `foldProtocolEvent.ts:129-136`
  when `turn` is undefined).
- The fold's blanket settled-turn guard (`foldProtocolEvent.ts:115`). The server's rule replaces
  it: close-only events for finished turns (I2).

### 3.5 (e) Edge cases

- **An event names an entity the client does not hold** (a turn it never saw). Every thread
  subscription starts with a replay or a snapshot, so this is a protocol error. The client starts a
  recovery of the scope instead of inventing the entity.
- **A response arrives before or after its event.** It no longer matters: the response changes
  only the overlay. This holds for asynchronous command results too, whose replies are sent after
  the dispatched promise settles (`apps/server/src/websocket.ts:374-376`), and so after the events
  that command produced.
- **A retried `turn.send` answered from the cache** (`thread-service.ts:1414-1419`). The client
  matches the answer to its `pending.sends` entry by `commandId` and changes nothing else. The
  turn's state comes only from events.
- **An overlay outlives its command** (the socket dropped before the answer). The command fails,
  so the entry goes. A stale status on screen is correct until the server sends a change.
- **The desktop app.** It is out of scope, but it depends on contracts this design deletes, not
  only on reducers:
  - `ProofResponse<'session.history'>`
    (`apps/desktop/src/renderer/src/environment/convex-environment-client.ts:192`);
  - its `loadSessionHistory` implementation (`:941`) of the shared `EnvironmentClient` interface
    (`packages/environment-client/src/types.ts:443-449`);
  - `applySessionHistory`, `applySessionList`, `deriveSessionStatus` and others (`:8-24`).

  Before F3 or F5 deletes anything desktop uses, the desktop's legacy types, adapter interface and
  folds move into `apps/desktop`: a desktop-owned copy of the old contract and the reducers it
  calls. **Desktop typecheck and its adapter tests are a gate for F3 and F5.**

### 3.6 Audit: every place the client derives or invents server state

"Keep" means it is the client's own state, a pure view, or a current reading. "Replace" means an
explicit server event or field takes its place. "Delete" means it goes without a replacement.
Phases are in brackets.

| #   | Where                                                                                                                           | What it does                                                                                              | Verdict                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `foldProtocolEvent.ts:80-86` `closeReasoning`, called at `:137`, `:169-172`, `:211`                                             | Closes thoughts the server leaves open                                                                    | **Replace** [F3]: the server emits `message.reasoning {phase:'stop'}` in-turn (§4.3.3) and at turn end                                                                                                     |
| 2   | `foldProtocolEvent.ts:138`                                                                                                      | Drops a turn's pending interactions at a terminal event                                                   | **Replace** [F3]: `interaction.cancelled` events before the terminal                                                                                                                                       |
| 3   | `foldProtocolEvent.ts:139-146` `failures` list                                                                                  | Failure text lives only in the live event; a snapshot resets it (`state.ts:574`)                          | **Replace** [F3]: `Turn.failure {reason, message}`, persisted and in snapshots                                                                                                                             |
| 4   | `foldProtocolEvent.ts:115` settled-turn guard                                                                                   | Ignores every late event                                                                                  | **Replace** [F3]: the server sends only close-only events for finished turns, and the client applies what it receives                                                                                      |
| 5   | `foldProtocolEvent.ts:129-136`, `state.ts:310-324` `setTurnState`                                                               | Synthesizes a turn it never saw                                                                           | **Delete** [F3]; a protocol error, so recover                                                                                                                                                              |
| 6   | `state.ts:526` and `:331-351` `resolveInteraction`                                                                              | Derives turn state from interactions                                                                      | **Replace** [F3]: `turnState` on every interaction event                                                                                                                                                   |
| 7   | `state.ts:861-867` `applyInteractionResolved`, from `websocket.ts:1407-1410`                                                    | Optimistically removes the server's interaction and flips its turn                                        | **Replace** [F3]: the `pending.answers` overlay (lifetime in §3.2)                                                                                                                                         |
| 8   | `settle.ts:20-80` (masking `:69-79`, applied at `websocket.ts:599`)                                                             | Writes `settledAt` itself and strips server events                                                        | **Replace** [F3]: the `pending.settles` overlay; events are applied unmasked                                                                                                                               |
| 9   | `websocket.ts:1208-1239` `createSession`                                                                                        | Applies the response and invents `providerId` and `status: 'running'` (`:1231`)                           | **Replace** [F3]: the `pending.creates` overlay; the session comes from events                                                                                                                             |
| 10  | `websocket.ts:1362-1365` `acknowledgeSession`                                                                                   | Sets `doneAt: null` locally                                                                               | **Replace** [F3]: the `pending.acks` overlay                                                                                                                                                               |
| 11  | `websocket.ts:1369-1373` delete, `:1183-1189` workspace remove                                                                  | Removes locally after the response, with a cascade                                                        | **Replace** [F3]: the `pending.removals` overlay, and server-emitted `session.deleted` cascades (§4.4); unsubscribing stays                                                                                |
| 12  | `state.ts:353-391` `removeSession` descendant walk                                                                              | Mirrors the FK cascade (`migrations.ts:84-85`)                                                            | **Replace** [F3]: one `session.deleted` per descendant                                                                                                                                                     |
| 13  | `state.ts:912-931` `applyWorkspaceRemoved` session loop                                                                         | Mirrors the workspace cascade                                                                             | **Replace** [F3]: one `session.deleted` per session, then `workspace.removed`                                                                                                                              |
| 14  | `state.ts:253-270` `touchWorkspaceActivity` (called at `:413`, `:495`, `:882`)                                                  | Recomputes workspace recency on turn events                                                               | **Replace** [F3]: a server-derived `workspace.updated` in the same transaction (§4.4)                                                                                                                      |
| 15  | `state.ts:432`                                                                                                                  | `updatedAt = event.timestamp`                                                                             | **Replace** [F3]: an explicit `updatedAt` on `session.updated`                                                                                                                                             |
| 16  | `state.ts:150-250` `upsertSession` with `settledOf`/`doneOf`/`backgroundOf`/`composerOf`, and #219's `activityOf`               | Field-by-field merge of partial summaries; "an older environment keeps what is known"                     | **Delete** [F5]. The handshake needs an exact version match (`negotiation.ts:131`). Once every source sends a full summary, upsert = replace. `sameSummary` stays as structural sharing                    |
| 17  | `state.ts:180-182` `threadIds` union                                                                                            | Merges thread lists                                                                                       | **Delete** [F5]; the session snapshot is the whole list                                                                                                                                                    |
| 18  | `state.ts:547-605` thread `applySnapshot`, `:616-622`, `:584-587`, `:588-594`                                                   | Merges the snapshot with held pages                                                                       | **Delete** [F5]; a wholesale replace (§6.2)                                                                                                                                                                |
| 19  | `state.ts:549-557` environment `applySnapshot`                                                                                  | Upserts sessions and never removes missing ones                                                           | **Replace** [F5]: a whole-environment replace                                                                                                                                                              |
| 20  | `state.ts:651-733` `applySessionHistory` (the `turnId` guess at `:689-699`, persisted-status restore at `:657-659`, `:725-732`) | The page merge                                                                                            | **Delete** [F5] with `session.history`                                                                                                                                                                     |
| 21  | `state.ts:747-761` `reconcileOutbox`                                                                                            | Matches failed echoes by message **text**                                                                 | **Replace** [F3]: by `Turn.commandId`                                                                                                                                                                      |
| 22  | `state.ts:769-802` `confirmTurnStart`, and `applyTurnStarted` from the `turn.send` response (`websocket.ts:1387`)               | Response-driven turn writes, with a no-rewind guard                                                       | **Delete** [F3], in this order: responses stop writing turns, then the guard goes (§3.4)                                                                                                                   |
| 23  | `websocket.ts:946-1004` `reconcileCachedSessions`, `:1027-1068` catalog walk                                                    | Guesses deletions from keyset walks                                                                       | **Delete** [F5]; the environment snapshot is the whole list                                                                                                                                                |
| 24  | `websocket.ts:574-588` `applyRecord`                                                                                            | Applies any `sequence > cursor`, so gaps are skipped silently                                             | **Replace** [F4]: I5                                                                                                                                                                                       |
| 25  | `websocket.ts:630-635` transient ring (4096 ids)                                                                                | Dedupes unscoped transients                                                                               | **Replace** [F4]: scoped, positioned transients (§5)                                                                                                                                                       |
| 26  | `websocket.ts:1089-1130` composer preference tickets, plus `applyComposerPreference` from get/set answers                       | Orders answers against events by client issue order                                                       | **Replace** [F3 for the revision and projection; F5 for the snapshot]: server `revision`, the `pending.preferences` overlay, preferences in the environment snapshot                                       |
| 27  | `websocket.ts:877-881` preferences reset and drafts relisted after an environment snapshot                                      | Invalidates and re-reads what the snapshot lacks                                                          | **Delete for preferences** [F5]: they are in the snapshot. **Keep for drafts**: a replace by a fresh read of a versioned entity (`events.ts:104-108`)                                                      |
| 28  | `websocket.ts:1346-1355` rename and regenerate                                                                                  | Apply the response title and **invent** `titleSource` (`'user'`, or `'generated'`); the response has none | **Delete** [F3]; `session.updated` carries the title and its source                                                                                                                                        |
| 29  | `websocket.ts:1180` `addWorkspace`, `:1196-1197` `listSessions`, workspace-list answers                                         | Apply response payloads to server-owned state                                                             | **Delete** [F3 for workspaces; F5 for sessions]: events and snapshots                                                                                                                                      |
| 30  | `packages/app-core/src/providers/environment-application.tsx:471`, `:733-742` `turnPending` / `localSessionStatus`              | The client's own "sending" state                                                                          | **Keep**: client-owned. Re-reviewed with B13 in F7; it is superseded by `pending.sends`                                                                                                                    |
| 31  | `environment-application.tsx:1471-1475` `activeStatus`                                                                          | A view                                                                                                    | **Keep** as a view. After #219, read `inBackground`                                                                                                                                                        |
| 32  | `packages/environment-client/src/mock.ts:274-334`, `:1047-1057`, `:1650-1657` (`deriveSessionStatus`, which #219 extends)       | The mock plays the server                                                                                 | **Keep, as a fake server only.** It must emit the new events (child closes, `turnState`, revisions). It is never used for convergence. `deriveSessionStatus` moves into `mock.ts`, and desktop gets a copy |
| 33  | `state.ts:137-148` `deriveSessionStatus` (export)                                                                               | Session status from turns                                                                                 | **Delete** from the shared client (row 32)                                                                                                                                                                 |

---

## 4. Rule 2: every change is an event

### 4.1 Restart recovery

#### (a) Today

- `openEnvironmentDatabase` runs the migrations, then `recoverInterruptedTurns`
  (`database.ts:17-34`).
- `recoverInterruptedTurns` runs one `BEGIN IMMEDIATE` (`:45-95`) that:
  - sets `sessions.status='error'` (`:47-58`);
  - touches `threads.updated_at` (`:59-67`);
  - cancels pending interactions (`:68-76`);
  - finalizes messages (`:77-85`);
  - interrupts every running or waiting turn (`:86-94`).
- **No events are written.** Open tool rows stay `in_progress`, and so do the client's copies.
- **It runs on every open of a connection.** That is 7 times per boot:
  - the audit log (`server.ts:161`) and the client store (`:166`);
  - the event database (`:263`) and pairing (`:438`);
  - the workspace registry, the composer store and environment settings (`audit.ts:185`,
    `authorized-clients.ts:206`, `pairing.ts:230`, `workspaces.ts:128`, `composer-store.ts:33`,
    `environment-settings.ts:28`).

  It is harmless today only because all of them open during boot.

- **#212's patch, which is not adopted:** an epoch bump of each recovered thread
  (`#212: apps/server/src/db/database.ts:89-103`) and an SQL tool cancel (`:104-121`). Together they
  forced a `stream_reset` snapshot into the client merge (A4 → … → A16).

#### (b) Target

1. `openEnvironmentDatabase` configures and migrates only. `recoverInterruptedTurns` is deleted.
2. A boot step, `eventService.reconcileAfterRestart(environmentId)`, is called once from
   `startServer`:
   - **after** `createPersistentEventService` (`server.ts:267-302`) and `setEnvironmentId`
     (`:448`);
   - **before** `forgetStaleBackgroundWork` (`:449-454`), `providerService.start()` (`:759`) and
     `server.listen` (`:726-732`).

   No socket exists yet, and `publishDurableEvent` is a no-op until `:756`, so every record stays
   replayable. The step runs, in order:
   1. **Recovery of open turns (§4.1).** It selects every `running` or `waiting` turn. **For each
      turn, in its own transaction**, it writes `turn.interrupted {turnId, reason:
'server_restarted'}` through the terminal path of §4.3. That path first writes one close
      event per open child, then the terminal, then the derived session status (once per session,
      §4.3).
   2. **The legacy repair (§4.2).**
   3. `forgetStaleBackgroundWork`, unchanged.

3. `turn.interrupted {reason: 'server_restarted'}` projects the session to `error`, as recovery
   does today (`database.ts:37-41`). `reason: 'user'` rests the session as today
   (`event-projection.ts:553-558`).
4. **A turn whose transaction fails** (a broken projection invariant) is rolled back and logged at
   `error` with `sessionId`, `threadId`, `turnId` and the reason. It stays as it is in the rows, so
   the screen shows it as running; that is stale, but it is the truth of the rows. It is retried on
   the next boot. Boot continues, so there is no crash loop under the service supervisor (#216).
   - **Consequence:** until the turn is fixed, `selectActiveTurn` sees an open turn on that thread,
     while the server has no in-memory active turn for it. The thread service must refuse a new
     `turn.send` on a thread with an open turn row (it checks memory only today,
     `thread-service.ts:1425`), and `turn.interrupt` for such a turn must write
     `turn.interrupted {reason:'user'}` through the same terminal path. Both are F3 items.

**Sequence, epoch and scope stay consistent.**

- Events go through `writeScope` (`event-repository.ts:107-242`).
- `ensureStream` inserts a row only when none exists (`:81-87`), so an existing thread keeps its
  epoch, and the cursor is `head+1` (`:132-135`).
- The scope is the thread's own:
  `{type:'thread', environmentId: identity.environmentId, sessionId, threadId}`.
- A thread with no stream row has never had an event, so no client holds a cursor for it. Its new
  row takes the process epoch, which is also what `replay.ts:147-149` assumes.
- A client holding `(E, n)` replays `n+1…`, which are exactly the recovery events.

**Which events, exactly**, for each turn in `running` or `waiting`:

| Child                                                     | Event                                          | Payload                                                                                                           | Exists today?                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Tool whose `status` is absent, `pending` or `in_progress` | `tool.updated`                                 | `{toolCallId, turnId, status: 'cancelled'}`                                                                       | The event yes; **the status no** (`domains.ts:239`). Add `cancelled`; #212's `declined` belongs to F6 |
| Reasoning whose `phase` is not `stop`                     | `message.reasoning`                            | `{messageId, turnId, phase: 'stop'}`                                                                              | Yes                                                                                                   |
| Pending interaction                                       | **`interaction.cancelled`** (new)              | `{turnId, response: {kind, interactionId, outcome: {outcome:'cancelled', reason:'server_restarted'}}, turnState}` | New. The reason enum (`domains.ts:280-286`) gains `server_restarted` and `turn_ended`                 |
| Message with `is_final = 0`                               | none                                           | finalized by the terminal's projection (`event-projection.ts:549`)                                                | `is_final` is not client-visible (`domains.ts:209-215`); it is a server guard against late deltas     |
| Turn                                                      | `turn.interrupted`                             | `{turnId, reason: 'server_restarted'}`                                                                            | `reason` is new and required (`'user' \| 'server_restarted'`)                                         |
| Session status                                            | `session.updated` (derived, environment scope) | `{sessionId, status:'error', …}`                                                                                  | Yes, once per session per transaction                                                                 |

#### (e) Edge cases

- **A crash during recovery.** The current turn's transaction rolls back; the turns already
  committed stay done. The next boot recovers the rest.
- **Background turns** are handled the same way, then `forgetStaleBackgroundWork` clears rosters
  (`thread-service.ts:1564-1591`). Its "a turn cut off by the restart already reads as failed"
  (`:1583`) still holds.
- **A client connected during recovery** is impossible, because nothing listens yet.

### 4.2 The legacy repair (finished turns with open children)

Main never settled tools or thoughts, so turns that ended long ago still have `in_progress` tools
and unclosed thoughts.

- **The repair.** At boot, after recovery, the repair selects the open children of **finished**
  turns:
  - tools with status absent, `pending` or `in_progress`;
  - reasoning with `phase != 'stop'`.
- **One transaction per thread.** It writes `tool.updated {status:'cancelled'}` and
  `message.reasoning {phase:'stop'}` through the repository, with deterministic ids
  `repair:${kind}:${childId}`.
- **Idempotent.** A repaired child is no longer open, so a second run selects nothing, and a
  retried event deduplicates by id (`event-repository.ts:138-154`).
- **The projector rule for finished turns:** accept exactly these two transitions (tool from open
  to `cancelled`, reasoning from non-`stop` to `stop`) and reject everything else, including a
  close of a child that is already closed (I2). Runtime late events are still dropped by the thread
  service (`thread-service.ts:2648-2655`), and any that slipped through would be rejected.
- **The client** applies what it receives (§3.6 row 4). These events change only the named child.
- **Failure policy** is the same as recovery: log, leave the thread as it is, retry next boot,
  continue.
- **Volume.** One event per legacy child; F3 counts them on a copy of the real database before
  merging.
- **Why not a migration.** It would rewrite rows without events, and so needs an epoch bump to be
  honest. That would push a `stream_reset` snapshot through today's merge (the A6 path) and make an
  exception to rule 2. The repair keeps history, satisfies rule 2, and ships in F3, with no
  intermediate state between F3 and F5.

### 4.3 Turn end

#### (a) Today

The terminal projection (`event-projection.ts:528-570`):

- finishes the turn (`:538-548`) and finalizes its messages (`:549`);
- **cancels pending interactions in SQL** (`:550`);
- sets the session status (`:553-561`) and `done` (`:566-568`).

**Tools are never settled**, on either side. Thoughts stay open in the rows.

The repository derives one environment `session.updated` **per causing event**
(`event-repository.ts:183-222`). A batch that closes a question and then ends the turn would
therefore publish `waiting→running` and then `running→error`.

#### (b) Target: explicit child events before the terminal

- **Where.** `writeScope` gains a hook. When the event to write is terminal, a new module,
  `db/turn-closure.ts`:
  1. reads the turn's open children from the rows, inside the same transaction: tools with status
     absent, `pending` or `in_progress`; reasoning with `phase != 'stop'`; interactions with
     `state = 'pending'`;
  2. writes and projects one close event per child, with id
     `${terminal.eventId}:close:${kind}:${childId}`;
  3. then writes the terminal.

  The same module serves live turn end and recovery. Every terminal path reaches it:
  - `emitCompleted`, `emitFailed`, `emitInterrupted` (`thread-service.ts:501-556`);
  - `prompt_completed` (`:2675-2683`);
  - `process_exited` (`:2685-2696`);
  - auth and capability failures (`:2698-2711`);
  - all of them through the batcher into `finalizeTurn` (`event-batcher.ts:27-35`,
    `event-repository.ts:274-291`).

- **The close events:**
  - tool: `tool.updated {status:'cancelled'}`;
  - thought: `message.reasoning {phase:'stop'}`;
  - question: `interaction.cancelled {reason:'turn_ended', turnState}`.
- **The terminal projection** no longer cancels interactions (delete `event-projection.ts:550` and
  `:129-132`). It **asserts** that no children are open.
- **The derived status, once per transaction.** `write` (`event-repository.ts:244-269`) records
  each affected session's status row (with #219's activity fields) when the session is first
  touched. After every group is projected, it compares that with the final row and emits **one**
  `session.updated` per session that changed.
  - The id is `${lastCausingEventId}:status`.
  - The retry path (`:126-131`) re-publishes it by looking up `:status` against every existing
    event of the batch.
  - The same pass emits the derived workspace recency event (§4.4).
- **Late events.** `onRuntimeEvent` already drops turn-scoped runtime events for a turn that is no
  longer active (`thread-service.ts:2648-2655`). The projector rejects any child event for a
  finished turn except the repair's closes (§4.2).
- **Memory follows commits.** The in-memory interaction mirror (`thread-service.ts:484-497`) is
  updated from the committed `interaction.cancelled` records, not by a rule of its own (I11).

**Why not a terminal that carries the child states?** It would give a tool two writers on each
side (`tool.updated`, and the terminal's child list). Every future child kind would have to be
taught to both, and they would drift, as the reasoning merge already has: the projector takes
`max(tokens)` (`event-projection.ts:341-342`), the fold takes the last value
(`foldProtocolEvent.ts:189`). The repository already supports a multi-event batch ending in a
terminal (`event-repository.ts:274-291`).

#### 4.3.3 Closing thoughts during a turn

ACP providers never frame their thoughts, so the fold closes one when assistant text or a tool
update follows (`foldProtocolEvent.ts:169-172`, `:211`). That is provider semantics, so it moves
to the server:

- `projectOwnEvent` (`thread-service.ts:812-925`) keeps `active.openReasoning`;
- before it appends an assistant `message.delta` or a `tool.updated`, it appends
  `message.reasoning {phase:'stop'}` for each open id.

The batcher keeps their order: `coalesceDeltas` merges only delta into delta
(`event-batcher.ts:123-132`).

#### (e) Edge cases

- **A tool completes in the same batch as the turn end.** The batch is projected in order, so the
  tool is `completed` before `turn-closure` reads it.
- **Interrupt while a permission is pending:** `interaction.cancelled {turn_ended}`, then
  `turn.interrupted {user}`, then one `session.updated`.
- **A tool row with no status at all** is treated as open, and cancelled.
- **Re-publishing after a publish failure:** see §5.2 point 6. The children are found by their
  deterministic ids.
- **In-memory mode** (unit tests only; `server.ts:365` always passes a database). It must emit the
  same events, or not be used for these tests. The F2 harness never uses it.

### 4.4 Other writes that change client-visible rows without an event

| Writer                                                                | Today                                                                                                                                                                                                                                                                      | Target                                                                                                                                                                                                                                                                                                                                                                                            | Phase |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Workspace **register**                                                | `upsert` inserts the row (`workspaces.ts:178-179`), `refresh` may write availability (`:309`), then `register` emits (`:397-398`). Each step is its own statement, outside any event transaction                                                                           | One `workspace.updated` whose projection inserts the row, in one transaction                                                                                                                                                                                                                                                                                                                      | F3    |
| Workspace **rename**                                                  | `statements.rename` (`workspaces.ts:166`) writes before the event; the projector writes the name again (`event-projection.ts:388-394`). Two writers                                                                                                                        | The projection is the only writer                                                                                                                                                                                                                                                                                                                                                                 | F3    |
| Workspace **availability and git**                                    | `refresh` writes availability (`workspaces.ts:309`) and emits. It is called from `list()` (`:417-423`), so **building the environment snapshot writes and appends events** (`server.ts:306` → `replay.ts:86`)                                                              | Observation is a separate step, run on command paths (`resolve`, `get`, `availability`, `resolvePath`, register, `markUsed`). It appends `workspace.updated` only when availability or the git reading changed. `list()` and the snapshot read rows only. The git reading is stored (`workspaces.git_json`, migration 22), so a row fully describes the workspace without touching the filesystem | F3    |
| Workspace **recency**                                                 | `markUsed` writes `last_used_at` (`workspaces.ts:523`) and emits. `lastActivityAt` is computed at read time from `MAX(sessions.updated_at)` (`:151`, `:242-245`), and the client mirrors it (§3.6 row 14)                                                                  | `markUsed` becomes an event. When a session's `updated_at` moves its workspace's `lastActivityAt`, the repository emits a derived `workspace.updated` in the same transaction, once per workspace per transaction, built from rows only                                                                                                                                                           | F3    |
| Workspace **capabilities.providers**                                  | Computed per listing from provider health (`server.ts:247-251` → `workspaces.ts:238`), so it changes with health without any workspace event                                                                                                                               | It leaves the durable workspace record. Provider health entries gain a server-computed `available` flag (`ready \|\| warning`, today's rule at `server.ts:247-251`), and the composer reads it there. A current reading stays a current reading                                                                                                                                                   | F3    |
| Workspace **removal**                                                 | `DELETE FROM workspaces` (`workspaces.ts:145`, `:404-413`) cascades through FKs (`migrations.ts:72-141`); only `workspace.removed` is emitted, and its projection is a no-op (`event-projection.ts:395-397`)                                                               | One transaction: a `session.deleted` per session (deepest children first), a `draft.deleted` for each cascaded draft, then `workspace.removed`, whose projection deletes the row. The registry cache changes after commit                                                                                                                                                                         | F3    |
| Session deletion                                                      | `DELETE FROM sessions` (`event-projection.ts:459-461`); children (`migrations.ts:84-85`) and the session's draft cascade silently                                                                                                                                          | A `session.deleted` per descendant and a `draft.deleted` per cascaded draft, in one `appendAtomic` (`event-service.ts:84-94`)                                                                                                                                                                                                                                                                     | F3    |
| Composer **preferences** and provider **profiles**                    | Written by `composer-store.ts` (`:47-75`) on its own connection, then published (`composer-service.ts:111`, `:137`, `:222-224`); the projector ignores both (`event-projection.ts:455-458`)                                                                                | The projection writes them; preferences gain `revision` (§3.2)                                                                                                                                                                                                                                                                                                                                    | F3    |
| `persistRuntimeSession`                                               | Writes `provider_id`, `provider_session_id` **and `updated_at`** (`thread-service.ts:419-426`). Called after `session.create` once the provider session resolves (`:1833`), and when a child session is registered (`:1348`); **not** on resume (`restoreSession`, `:712`) | Write `provider_session_id` only. `provider_id` is already set by `session.created`'s projection (`server.ts:293-299`); assert it is unchanged                                                                                                                                                                                                                                                    | F3    |
| `updateSessionTitle` and other silent projector guards                | The projector refuses some titles (`event-projection.ts:46-59`) while the event claims the change; the producer pre-checks against memory (`thread-service.ts:1055-1061`). Same for `updateSessionBackground` (`:433-438`) and `updateSessionComposer` (`:444-447`)        | The producer decides and emits only changes it will apply. The projector asserts `changes === 1` (I2)                                                                                                                                                                                                                                                                                             | F3    |
| Migration 11 backfill (`migrations.ts:796-934`), #212's legacy settle | Rewrite projected rows                                                                                                                                                                                                                                                     | Not repeated. Corrections are boot repairs (§4.2); I1 has no migration exception                                                                                                                                                                                                                                                                                                                  | —     |
| Retention (`event-retention.ts`)                                      | Deletes log rows                                                                                                                                                                                                                                                           | Unchanged; the log shrinks, the domain does not                                                                                                                                                                                                                                                                                                                                                   | —     |

**Crash-window tests (F3).** For each former "row write, then event write" pair (workspace
register, rename, availability, `markUsed`, removal, composer writes, the runtime stamp), kill the
server child between the two operations. Use the repository's `beforeCommit` seam
(`event-repository.ts:27-28`), which exists for exactly this. Then assert that after a restart
the row and the event are both present or both absent, and that a client replaying from its
bookmark converges.

**Write-failure policy (D14, I11).** Rows are the truth; memory follows commits.

- Today a failed write is reported and the in-memory turn settles anyway ("Provider callbacks and
  turn settlement must not fail because a write did", `thread-service.ts:458-466`). Memory then
  runs ahead of the rows every client reads.
- **Target:**
  - the batcher already keeps a failed batch and retries it first (`event-batcher.ts:57-68`);
  - the thread service advances its records (turn state, interactions, titles, workspace and
    composer caches) only from committed records;
  - a persistently failing database (disk full) is logged at `error` and reported in health. The
    turn is not "failed" in memory, because writing that failure would hit the same disk.
- `applyTitle`'s "announced before it is believed" (`thread-service.ts:1062-1064`) is already this
  policy; F3 makes it the rule everywhere.

### 4.5 (c) Protocol and schema changes for rule 2 (F3)

- `ToolCallStatusSchema` gains `cancelled`.
- New event `interaction.cancelled`:
  `{turnId, response: InteractionResponse /* cancelled outcome */, turnState}`.
- `CancellationReasonSchema` gains `turn_ended` and `server_restarted`.
- `interaction.requested`, `.resolved` and `.expired` gain `turnState: 'running' | 'waiting'`
  (required). It is computed in `projectOwnEvent` from `active.pendingInteractions` (#219 makes it
  a map). The projector applies it and asserts it against the pending rows
  (`event-projection.ts:496`, `:521-523`).
- `turn.interrupted` gains `reason: 'user' | 'server_restarted'` (required).
- `TurnSchema` gains `commandId?`, `failure?: {reason, message}`,
  `interruptedBy?: 'user' | 'server_restarted'`.
- `turn.started.turn.startedAt` is always set.
- `session.updated` gains `updatedAt?`.
- `workspace.updated`'s workspace drops `capabilities.providers`.
- Provider health entries gain `available: boolean`.
- `composer.preferences.updated` gains `revision`. The preference set commands' acknowledgements
  carry it.
- **Migrations 21 and 22** (additive only; numbering per §4.7.9):
  - 21 (PR A): `turns.failure_message TEXT` (`failure_reason` is selected but dropped when mapped,
    §4.7.8 item 6); `turns.interrupted_by TEXT`; `event_streams.replay_floor` and the stored-format
    record (§4.7.7);
  - 22 (PR B): `workspaces.git_json TEXT`; `workspace_composer_preferences.revision INTEGER NOT NULL
DEFAULT 0`.
- **Protocol** v16 → v17, unless #219 takes v17 first. As written it does not bump (its
  `docs/session-status.md`). The handshake requires an exact match (`negotiation.ts:131`).

### 4.6 (d) Deleted in F3

- `recoverInterruptedTurns` and its call (`database.ts:28`, `:36-105`).
- The terminal interaction cancel (`event-projection.ts:129-132`, `:550`).
- The per-event status derivation (`event-repository.ts:183-222`), replaced by the
  per-transaction one.
- In the fold:
  - `closeReasoning` and its call sites;
  - the terminal interaction filter;
  - `failures`;
  - the blanket settled-turn guard;
  - the unknown-turn synthesis.

  (`foldProtocolEvent.ts:80-86`, `:115`, `:129-147`, `:169-172`, `:211`.)

- `setTurnState` and the turn flipping in `resolveInteraction` (`state.ts:310-351`, `:526`).
- The client cascades (`state.ts:353-391`, `:927-929`).
- In `workspaces.ts`: the direct row writes (`:166`, `:179`, `:309`, `:404-413`, `:523`) and the
  write inside `list()` (`:417-423`).
- `composer-store.ts`'s direct writes (they become projections).
- `updated_at` in `persistRuntimeSession` (`thread-service.ts:422`).
- The response-driven writers, and then `confirmTurnStart` (§3.4).
- #212's epoch bump and SQL tool cancel, never ported.

### 4.7 Additions decided after F2 (revision 3.2)

The user decided these on 2026-10-20, after F2's harness found them. All of them are F3 work.
The section was reworked on 2026-10-21 after the gpt-6.1 and Fable reviews.

References in this section are to ad1e856, the F2 branch: main at 4fc221d (with #219) plus tests.
Main has since moved to 49e3515 (#222, #223). `apps/server/src`, `packages/protocol/src` and
`packages/agent-runtime/src` are byte-identical there. Of the client files, only
`environment-client/src/{state,types}.ts` moved, with #222, and their references here are to
ad1e856.

#### 4.7.1 X1: a title is not activity

**(a) Today**

- Every title write stamps `sessions.updated_at` with the event time. That is `updateSessionTitle`
  (`apps/server/src/db/event-projection.ts:45-59`, `updated_at = ?4` at `:55`), and every source
  reaches it:
  - a rename (`thread-service.ts:2071-2135`);
  - a generated title, and a regenerated one;
  - the first-prompt fallback and a provider's own name (`applyTitle`, `:1097-1125`).
- The client does the same: any `session.updated` with a title sets `updatedAt` to the event time
  (`packages/environment-client/src/state.ts:471`).
- The server computes `lastActivityAt` at read time, as
  `max(MAX(sessions.updated_at), workspaces.last_used_at)` (`workspaces.ts:149-152`, `:223-246`).
  A rename therefore moves the workspace's recency on the server. The client's mirror
  (`touchWorkspaceActivity`, `state.ts:271-288`) moves only on `session.created` and turn events
  (`:427-435`, `:534`). That gap is F2's X1.
- In-memory mode stamps titles too, in three places: `applyTitle` (`thread-service.ts:1124`),
  `saveGeneratedTitle` (`:1205`) and rename (`:2120`).

**(b) Target**

- **No title write moves `updated_at`, whatever its source:** `user`, `generated`, `provider` or
  `fallback`. The user named rename, generated and fallback. A provider's name for its session is
  the same bookkeeping, so it follows the same rule.
- **The stored provenance mapping does not change.** The wire's `'generated'` is stored as
  `title_source = 'provider'` plus `title_generated = 1` (`event-projection.ts:409-415`). The
  column's CHECK allows only `fallback`, `provider` and `user` (`migrations.ts:78-80`).
- **Activity is unchanged otherwise.** Activity is everything that moves `updated_at` today, minus
  titles:
  - `session.created`;
  - every projection that sets `sessions.status`: `turn.started`, the terminals, and the
    interaction events (`event-projection.ts:60-62` and its callers);
  - a producer's status-bearing `session.updated`.
- **Every move of `updated_at` is announced.** The per-transaction pass of §4.3 compares
  `updated_at` as well as status and activity. Its `session.updated` carries `updatedAt`, read
  from the row. This covers moves that today emit nothing, such as a second request while a session
  is already `waiting` (§4.7.8, item 3).
- **Workspace recency is derived in the same pass.** For each workspace whose sessions or
  `last_used_at` the transaction touched, the pass computes `lastActivityAt` from the rows before
  and after, with the registry's own function. When it changed, the pass emits one
  `workspace.updated` built from the rows. The change may go backwards: deleting a workspace's
  newest session lowers its `lastActivityAt`.
- **The client reads `updatedAt` only from payloads:** the `session.created` summary (§4.7.2),
  `session.updated.updatedAt`, listings, snapshots and `session.open`.

**(c) Protocol and schema**

- `session.updated.updatedAt` (already in §4.5).
- The derived `workspace.updated` needs a workspace that rows alone describe, so X1's recency half
  ships with §4.4's `git_json` and the removal of `capabilities.providers`.
- No migration for X1 itself.

**(d) Deleted**

- `updated_at = ?4` in `updateSessionTitle`.
- The event-time rule at `state.ts:471`.
- `touchWorkspaceActivity` and its three callers (§3.6 row 14).
- The three in-memory title stamps (`thread-service.ts:1124`, `:1205`, `:2120`).

**(e) Edge cases**

- **Rows already stamped by a title stay as they are.** The value is not wrong; an old policy
  produced it. A repair would emit events for nothing.
- **A fallback title in the same batch as `turn.started`.** The turn moves the time and the title
  does not, so the session keeps the turn's time.
- **Session paging.** `session.list` pages by `(updated_at, session_id)` (`session-store.ts:175-197`).
  Renames stop reordering pages while a client walks them.
- **The harness.** S9 moves the catalog under the walk with renames (F2 evidence, S9). After X1
  renames no longer move it, so S9 would converge because its construction lost its mover, not
  because F5 fixed it. F3 rebuilds that mover from real activity (turns on the renamed sessions)
  and keeps the cause. The renames still make the replay gap.

#### 4.7.2 X2: `session.created` carries a `SessionSummary`

This moves from F5 (§3.3, §6.3) into F3.

**(a) Today**

- **The payload is a bare `Session`** (`packages/protocol/src/events.ts:63-67`,
  `domains.ts:87-97`), with no provider, status or time.
- **The client fills the gaps.** `upsertSession` takes the event time and what it already holds
  (`state.ts:151-196`, `:427-435`). `providerId` stays absent until a listing, so the sidebar falls
  back to OpenCode (`DEFAULT_PROVIDER_ID`, `WorkspaceSidebarView.tsx:77`, used at `:1343`, `:1810`,
  `:1853`).
- **The projection learns the provider from a host resolver.** That is
  `sessionProviderId` (`server.ts:290-299`), fed by the thread service's `announcedProviders`
  (`thread-service.ts:594-637`).
- **The session-scope snapshot also strips the summary to a bare `Session`**
  (`apps/server/src/db/replay.ts:98-106`).
- **Title provenance disagrees between memory and row at creation.** The insert writes no
  `title_source` (`event-projection.ts:31-35`). The in-memory record says `fallback` for a session
  created with a title (`thread-service.ts:1888`) and `provider` for a child its provider named
  (`:1374`).

**(b) Target**

- **The payload is a `SessionSummary`.** The producer builds every field the projection will
  write:
  - `providerId`;
  - `title`, and `titleSource` with the value the in-memory record holds;
  - `status: 'idle'`;
  - `updatedAt`: the event time;
  - `parentSessionId`;
  - `settledAt: null` and `doneAt: null`.

  The payload is in the **canonical form** `sessionRowToSummary` emits. That form writes
  `settledAt` and `doneAt` as `null` (`session-store.ts:163-164`) and leaves out what a new row
  does not have: background work, `waitingOn`, `inBackground` and `composer`.

- **The projection inserts the row from the payload,** including `provider_id` and `title_source`.
  Inside the same transaction it reads the row back with `sessionRowToSummary` and **asserts the
  two canonical forms are equal**. "Built from the row the projection wrote" is checked, not assumed.
- Child sessions are announced the same way, with the parent's provider.
- **The session-scope snapshot carries the `SessionSummary`** that it already reads.
- **The client's `SessionSummary` makes `providerId` and `updatedAt` required.** Every source
  carries both: `session.created`, listings, both snapshots and `session.open`.
  - The `?? DEFAULT_PROVIDER_ID` fallbacks are deleted, so the type checker proves that no path
    lacks a provider.
  - **The response writers stay until their overlay lands.** The `createSession` writer (§3.6 row 9) and the rename and regenerate writers (row 28) stay until `pending.creates` and
    `pending.renames` replace them, in the same PR as `pending.sends` (§4.7.10).
  - Until then `createSession` fills the required fields from what it already has:
    `input.providerId` and the answer's `announcedAt` (`websocket.ts:1229`).
- Stored `session.created` events in the old shape: §4.7.7.

**(c) Protocol and schema**

- `session.created.payload.session` becomes `SessionSummarySchema`.
- The session-scope snapshot's `session` becomes a `SessionSummary`.
- No migration.

**(d) Deleted**

- The `sessionProviderId` resolver and `announcedProviders`.
- The client's `at` fallback in `upsertSession`.
- The `?? DEFAULT_PROVIDER_ID` fallbacks.

**(e) Edge cases**

- **A session created with a title now stores `title_source = 'fallback'`** where the row held
  NULL. Every reader treats the two alike: the projector's guard, `shouldReplaceSessionTitle`, and
  no UI reads `titleSource`. Memory and row now agree from the start.
- **The row's own defaults** (`status`, timestamps, the `null` settle and done times) must equal
  the payload. The assertion rolls back any drift.
- **A canonical `null`** also lets the client tell "none" from "not said", which its
  `settledOf`/`doneOf` merge cannot do with an absent field.
- **The desktop app** builds summaries from its own Convex data. A required `providerId` in the
  shared type is part of the §3.5 gate.

#### 4.7.3 S17: a command for a chat that is not in memory

**(a) Today**

- **After a restart the thread service holds no records.** Only `session.open` rebuilds them
  (`restoreSession`, `thread-service.ts:710-753`; its only call is `:2321`).
- **Thread and session commands answer as if the chat did not exist:**
  - `turn.send` answers "Thread not found." (`:1466-1468`), unless the send is a retry the log
    already holds (`:1460-1465`);
  - `turn.interrupt` does the same (`:2420-2423`);
  - `interaction.respond` checks the log first and answers "already resolved" for an interaction
    only the log knows (`:2496-2511`);
  - the composer's model, mode and config setters resolve the runtime through
    `resolveRuntimeSession` (`thread-service.ts:1682-1689`) and answer "Session not found."
    (`composer-service.ts:291-297`).
- **The client does not reopen a session it still subscribes to** (`websocket.ts:1073-1083`).
  `recover()` resubscribes every scope first (`:1022-1023`), so a reconnect after a restart never
  sends `session.open`.
- **The wire has no per-process identity.** Stream epochs survive restarts (§4.1), and the
  bootstrap carries none (`server.ts:461-468`).

**(b) Target**

1. **One loader.** `loadSession(sessionId, context)` is factored out of `session.open`'s branch for
   a session not in memory (`:2283-2327`). It runs the same checks in the same order:
   1. summary;
   2. provider capability;
   3. provider health;
   4. workspace;
   5. threads.

   Then it asks the runtime for the session and stamps whatever identity comes back (§4.7.4).
   `session.open` becomes the loader plus its answer.

   - **Access checks stay where they are.** The transport's authorization runs first
     (`apps/server/src/websocket.ts:409`).
   - `turn.send` still resolves the workspace with the caller's context before it answers anything,
     a cached retry included (`thread-service.ts:1447-1455`).

2. **Every command that needs a session's records loads it first, then serves the command as if
   the session had been open.**
   - `turn.send` loads the session.
   - So do the composer setters, through `resolveRuntimeSession`.
     - Today `resolveRuntimeSession(sessionId)` takes no `CommandContext`, and
       `composer-service.ts:292-298` has none to give.
     - F3 passes the caller's context through to the loader, so the workspace check audits the
       right client.
   - `turn.interrupt` does not need the provider, but it no longer answers "not found" for a thread
     the log holds:
     - when the rows hold no open turn, it answers "Turn is not in progress.";
     - when they hold one (a failed recovery, §4.1 point 4), it writes `turn.interrupted {reason:
'user'}` through the terminal path.
   - `interaction.respond` keeps its log check.
3. **Loading is synchronous.** The records exist before the command returns. The provider load is
   the record's `runtimeSession`, which every prompt already awaits. A send right after a restart
   is accepted at once, and its prompt waits for the provider.
4. **Records dropped while their rows survive end every turn started on them.** Each such turn
   ends with `turn.failed {reason: 'provider_error'}` through the terminal path, before the records
   are dropped.

   What main does, re-verified after Fable's review (revision 3.2 first described it wrongly):
   - **A single-thread session whose own load fails ends its turn correctly.** The restore catch
     (`:743-748`) calls `dropSessionRecords` (`:647-668`), which only forgets the records and does
     not call `abandonTurn`. `sendTurn`'s catch (`:1584-1594`) then still sees its own active turn
     and writes `turn.failed`.
   - **The gap is a record dropped by something else while its own `runtimeSession` succeeds.**
     For example, another thread of a multi-thread session fails to load. The send's `.then` returns
     early (`:1552-1557`) because the record is no longer in the map. `promptStarted` stays unset,
     so the next handler (`:1574`) writes no terminal, and the turn row stays `running` until the
     next boot.
   - **Session deletion and workspace closing are not affected.** They also drop records
     (`:1662`, `:2128` → `abandon`), but their rows go with them, so they need no terminal.

   The C3 unit test: records dropped before `runtimeSession` settles → the turn still ends through
   the terminal path.

5. **The client's backup.** The server reports a per-process `instanceId` (random per boot) in the
   bootstrap and the handshake answer. The client remembers it per environment. When it changes,
   the resync reopens the active session even though it still holds the session's scopes.
   - This is not the fix: with points 1 to 3, a send works without it.
   - It starts the provider before the user types.
   - It re-checks the session, and an open failure shows as it does today.

**(c) Protocol and schema**

- `BootstrapResponse` gains `instanceId`, required in the bumped version.
- No migration. S18 adds one error code (§4.7.4).

**(d) Deleted**

- "Thread not found." for a thread the log holds (`turn.send`, `turn.interrupt`).
- "Session not found." from the composer setters for a persisted session.
- The reopen workaround in the harness: S17's reopen, and the seeded runs' `stale` reopen
  (`model.test.ts:48-58`, `:265`).

**(e) Edge cases**

- **The provider is unhealthy, the workspace is missing, or the provider cannot load sessions.**
  The command gets the answer `session.open` would give, not "not found".
- **Two commands race for one unloaded session.** The first creates the records synchronously and
  the second finds them.
- **A retried `turn.send`** that the log holds is answered from the log, without loading
  (`:1460-1465`).
- **A thread whose recovery failed** (§4.1 point 4) refuses a new send with `conflict` after
  loading.
- **The client's reopen racing the user's open** is S19 (§4.7.5).
- **A composer change loads the session,** which may start a provider process. The user asked to
  change that session, so that is expected.
- **In-memory mode** has nothing to load and is unchanged.

#### 4.7.4 S18: a session left without a provider identity

**(a) Today**

- **Creating a session writes the session before the provider exists.**
  - `session.create` writes `session.created` and `thread.created` in one `appendAtomic`
    (`thread-service.ts:1849-1864`), then answers.
  - Only then does it ask the provider for a session (`ensureSession`, `:1866-1881`), and only
    after that does it stamp the identity (`persistRuntimeSession`, `:436-443`).
  - A first message writes `turn.started` before the provider session exists (`:1952-1981`,
    `:1506-1528`). `runtime.prompt` runs only after the stamp, because it awaits `runtimeSession`
    (`:1547-1571`), which includes the stamp.
- **A hard kill between the two leaves a row with `provider_session_id` NULL.** `session.open`
  refuses it on every attempt ("The provider session identity is unavailable.", `:2297-2304`).
- **Only a hard kill shows it.** A graceful shutdown waits for pending starts
  (`packages/agent-runtime/src/session/SessionRuntimeRegistryImpl.ts:388`).
- **Child sessions have their own window.** The rows and the stamp are two commits with no await
  between them (`thread-service.ts:1364`, `:1391-1393`).
- **The runtimes already recreate a session whose stored identity they do not know.**
  - ACP: a `session/load` answered "not found" falls through to `session/new`
    (`AcpSessionRuntimeImpl.ts:531-552`); any other load failure fails the start.
  - Claude: `resolvableSessionId` drops an id the CLI does not know and starts fresh
    (`claude/ClaudeSessionRuntime.ts:647-665`).

  Both report `state: 'created' | 'loaded'` (`AcpSessionRuntimeImpl.ts:524-528`, `:570`;
  `backends/Backend.ts:10`).

- **Nobody re-stamps on resume.** `restoreSession` resolves `runtimeSession` to the id the
  runtime returns (`thread-service.ts:729-734`), but stamps nothing. After a fallthrough the row
  keeps the stale id, so the next boot loads it again. OpenCode keeps every session it opens, so it
  gains one empty session each time.

**What each provider does** (only three exist: `packages/agent-contract/src/providers.ts:4`):

| Provider | Creation                                                                                                                                    | Created twice                                                                                                                                                                          | Abandoned half-way                                                                             | Fresh creation on the next open             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------- |
| OpenCode | ACP `session/new` (`AcpSessionRuntimeImpl.ts:554-570`); the agent assigns the id                                                            | One extra empty "New session" in OpenCode's own history (`opencode.ts:98-101`)                                                                                                         | Same: if the agent finished, one empty session remains in its storage. No prompt was ever sent | Safe; at worst one empty orphan in OpenCode |
| Cursor   | ACP `session/new`; nothing is kept for a session that was never prompted (`cursor.ts:286-292`)                                              | Nothing left behind                                                                                                                                                                    | Nothing durable remains                                                                        | Safe                                        |
| Claude   | The runtime picks a UUID before the CLI starts (`ClaudeSessionRuntime.ts:461-467`); `query()` starts with an empty input queue (`:523-527`) | Two UUIDs; at most one orphan transcript, if the CLI writes one before any prompt (not verified; the probe passes `persistSession: false` to avoid one, `ClaudeProbeRuntime.ts:94-97`) | No prompt was pushed                                                                           | Safe                                        |
| Codex    | No runtime in this repo. It appears only in a plan (`docs/claude-codex-integration-plan.md`) and title generation                           | —                                                                                                                                                                                      | —                                                                                              | Decided by the same invariant when it lands |

**(b) Target: one path, driven by what the runtime reports**

- **The loader (§4.7.3) always calls `ensureSession(route(record, identity?))`,** passing the
  stored identity when there is one. It **stamps the identity the runtime returns before any prompt
  may use it** whenever:
  - the result's `state` is `'created'`; or
  - the returned `sessionId` differs from the stored identity.

  The stamp is §4.4's identity-only stamp, and it is part of `runtimeSession`, which every prompt
  awaits.

  This applies to **root sessions**. A child session is loaded under a load-only policy that
  never creates (see (e)).

- **For a root session, that one rule covers three cases:**
  - a NULL identity (S18): the runtime creates;
  - an identity the agent no longer knows: today's silent fallthrough, now stamped;
  - identity drift on resume.

  A test drives the ACP fallthrough (load answers "not found", then `session/new`) and checks that
  the new identity is durable before the prompt.

- **Why recreating is safe: one invariant, now stated and tested.** No prompt reaches a provider
  before the session's identity is durable.
  - For a created session this holds by construction today: the prompt awaits `runtimeSession`
    (`:1547-1571`), and the stamp is part of it (`:1866-1881`).
  - F3 extends it to every load and adds a test for the order.
  - A row without an identity is therefore a session whose provider never received anything.
- **The first turn.** Boot recovery (§4.1) has already interrupted it with events. The user
  resends; nothing is replayed to the provider automatically.
- **A failed start keeps the session eligible.** `rollbackSession` (`session.deleted`) applies only
  while `session.create` is in flight. Later:
  - a start that fails before any prompt leaves the row as it was, with no identity;
  - any turn it had started ends with `turn.failed` (§4.7.3 point 4);
  - the next command retries.

  Such a failure is not "prior provider output", because the prompt never left: it waits for the
  stamp. A test checks that a retry succeeds after one transient start failure.

- **The legacy-output exception of the first draft is dropped.** It would have refused a
  recreation that the runtimes already do silently on every stale identity. The question was
  whether the user's database holds root rows it would apply to: it holds none.
  - Measured on a copy, 2026-10-21: 133 sessions, **0 without a provider identity** (roots or
    children).
  - A10 counts again before PR A merges. If that count is not zero, the rows and their ages go to
    the user for a decision before the rule ships.
- **A permanent refusal is explicit.** Only a child session can be refused now (below).
  - It gets a distinct error code, `session_unrecoverable`, with retry policy `never`.
  - The message says why and what to do: "This chat's history lives in the agent and can't be
    reopened. Delete it to remove it."
  - The open-failure UI (`ChatWorkspace.tsx:37-79`) offers **delete**, not "Try again", for this
    code.
  - No new session status.
- **The alternative, an evented "could not start" state with retry and delete, is not needed.**
  No provider makes recreation unsafe. That state would add a session status, a retry command and
  UI for a case the server fixes by itself.

**(c) Protocol and schema**

`ErrorCodeSchema` gains `session_unrecoverable` (`packages/protocol/src/errors.ts:3-14`), with
retry policy `never`.

**(d) Deleted**

- The refusal at `:2297-2304` for root sessions.
- The model run's orphan bookkeeping (`model.test.ts`, `orphaned`).

**(e) Edge cases**

- **Child sessions are not recreated.** Their transcript lives in the provider, so a fresh session
  would lose it.
  - **F3 closes their window.** A child's identity travels with the write that creates its row:
    it is an option on that `appendAtomic` call, and the `session.created` projection reads it from
    the call. There is no long-lived resolver map to clear.
  - **A legacy child row without an identity gets `session_unrecoverable`.** The copy has none.
  - **A child with an identity is loaded with an explicit load-only policy** (added after
    gpt-6.1's confirmation pass). Today the route carries no such policy
    (`thread-service.ts:428`), and the runtimes fall through to a new session when the stored id is
    unknown (`AcpSessionRuntimeImpl.ts:531-552`, `claude/ClaudeSessionRuntime.ts:647-665`).
    - The route gains `load: 'require'`, set for every session with a `parentSessionId`. The
      runtime keeps the policy for the thread, so its own respawn inside `runtime.prompt` uses it
      too (`AgentRuntime.ts:1222-1254`).
    - Under that policy a "not found" load fails the start with a typed "session unknown" error,
      instead of creating. The loader maps that error to `session_unrecoverable` before anything
      is created, stamped or prompted. The stored identity is unchanged.
    - The stamping rule of (b) therefore never sees `created` for a child.
    - Test (C4): a child with a non-null identity whose load answers "not found" creates no
      session, keeps its stored identity, and gets the non-retryable failure. The test covers both
      the initial load and a respawn.
- **The workspace or the provider is unavailable.** The loader gives the same answers as any open.
  The row stays as it is, and the next command retries.
- **The new identity cannot collide** with `UNIQUE (provider_id, provider_session_id)`
  (`migrations.ts:87`): it is new.
- **The runtime's own respawn.** A provider process the registry reaped and respawns inside
  `runtime.prompt` loads with `args.sessionId ?? remembered` (`AgentRuntime.ts:1222-1254`).
  - If that load also fell through to `session/new`, the server would not see the new id.
  - Build step C4 checks whether that path can create.
  - If it can, the runtime reports the new identity through a callback, and the server stamps it
    before the prompt is sent. If it cannot, a test pins that.

#### 4.7.5 S19: an overtaken open resolves early

**(a) Today**

- `openSession` bumps a generation (`packages/environment-client/src/websocket.ts:1243`).
- An open that a newer one overtook returns as soon as its own answer lands (`:1281`), before the
  chat is hydrated or subscribed.
- After a reload, the resync's own reopen (`:1078-1083`) overtakes the user's open. F2 saw this 15
  times in 15. A turn sent at that moment is not owed to the client live, and the chat arrives later
  by snapshot.

**(b) Target**

- **An open resolves successfully only when its chat is loaded and subscribed:** every thread
  `ready` and the session's scopes subscribed.
  - A thread whose hydration fails makes the open reject with that failure. The store still marks
    the thread `failed`, and the history retry shows as today.
  - Today an open resolves even then (`websocket.ts:1295-1308` catches per thread).
- **Something else may overtake it.** `openGeneration` moves on another open, on
  `setActiveSession` (`:1600`), on a close (`:416`) and on `dispose` (`:1645`). Each source has its
  own outcome:
  - **A newer open of the same session:** the overtaken open follows the newest open's outcome,
    through the chain until no newer open of that session exists.
  - **An open of another session, or `setActiveSession`:** it rejects with a distinct, typed client
    error, `superseded`. Callers treat it as "nothing to do".
  - **A close or `dispose`:** it rejects with the transport's error, as a pending command does
    (`rejectAllPending`). That rejection is never swallowed.
- **The generation is checked again after hydration,** not only when the answer lands. An open
  that hydrated after being overtaken therefore never reports success for the old selection.
- **No caller shows an error for `superseded`.** The callers, checked:
  - `environment-application.tsx:754`: `openSessionLatest`, awaited at `:1013`, `:1016` and
    `:1104`, and `.catch(fail)` at `:931` and `:1107`;
  - `environment-application.tsx:1715`: the history retry sets an error;
  - `ChatWorkspace.tsx:72` and `apps/web/src/components/session-workspace.tsx:71`, `:85`: these
    catch everything already.

  `fail`, `openSessionLatest` and the history retry gain an `isSuperseded(error)` check. The mock
  client (`mock.ts`) follows the same rules. Desktop has its own `openSession` and is not affected.

**(c) Protocol and schema**

None. `superseded` is a client-side error code of `EnvironmentClientError`, not a wire code.

**(d) Deleted**

The silent returns at `:1281` and `:1328` for an overtaken open.

**(e) Edge cases**

- **The newest open of the same session fails:** the overtaken one rejects with the same error.
- **A chain cannot hang.** A disconnect fails every pending command, and each thread's hydration
  settles.
- **Opens of A, then B, then A.** The first open of A follows the third, which is the newest open
  of A when the first one's answer lands. The open of B rejects `superseded`.
- **Only the newest open applies a `not_found` removal or an open failure** to the store, as
  today.

#### 4.7.6 The crash-window seam (W1–W7)

**(a) Today**

- **The repository has the hook.** `EventRepositoryOptions.beforeCommit`
  (`event-repository.ts:28-29`) runs once per write, just before `COMMIT` (`:272`). It covers
  `appendEvents`, `appendGroups`, `appendAtomic` and `finalizeTurn`.
- **`startServer` cannot pass it.** `createPersistentEventService` accepts it, but `startServer`
  passes only `epoch`, `sessionProviderId` and `onError` (`server.ts:286-301`), and `ServerConfig`
  has no field for it (`config.ts:18-81`). Only `tests/event-repository.test.ts` uses it.
- **§4.4 says it "exists for exactly this". That is not true of today's windows.** The workspace
  and composer row writes run on their own connections (`workspaces.ts:128`,
  `composer-store.ts:33`), and the runtime stamp runs outside `write()`. The seam becomes the
  right one only once F3 makes those writes projections.

**(b) Target**

- **A test-only `ServerConfig` field, inert unless a test supplies it:**
  `commitHooks?: { beforeCommit?(records), afterCommit?(records) }`, passed to the repository.
  - `beforeCommit` now receives the records about to commit. Existing callers ignore the argument.
  - `afterCommit` runs after `COMMIT`, before `write` returns.
- **The server child arms them over IPC:** "SIGKILL at `before` (or `after`) on the next commit
  whose records include an event matching this name and predicate".
  - `before` proves both the row and the event are absent.
  - `after` proves both are present, and the event, never published, reaches a client by replay.
- **The tests.** Each kills, restarts on the same data, and checks two things: the rows and the
  log agree, and a client that resumes from its pre-kill bookmark converges.

| Test | Pair                    | Kill on the commit holding                                                                                                                                                                | After the restart                                                                                                                                                                |
| ---- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1   | workspace register      | the `workspace.updated` of a new workspace                                                                                                                                                | before: no row, no event, and adding it again works. After: both, replayed                                                                                                       |
| W2   | workspace rename        | the `workspace.updated` that renames it                                                                                                                                                   | the old name in both, or the new name in both                                                                                                                                    |
| W3   | availability (and git)  | the `workspace.updated` an observation appends (the folder moved away, then a command resolves it)                                                                                        | the stored availability equals the last announced one                                                                                                                            |
| W4   | recency (`markUsed`)    | the `workspace.updated` carrying `lastUsedAt`                                                                                                                                             | `last_used_at` equals the last announced value                                                                                                                                   |
| W5   | workspace removal       | the cascade: `session.deleted` (deepest first), the drafts, then `workspace.removed`                                                                                                      | before: workspace, sessions and drafts all present. After: all gone, with no client cascade                                                                                      |
| W6   | composer                | `composer.preferences.updated` (with `revision`), and a profile's `provider.catalog.updated`                                                                                              | the stored preference and revision equal the last announced ones                                                                                                                 |
| W7   | the runtime stamp       | root: no event (the identity is host-private), so the kill comes between `session.created` and the stamp, through a delayed `newSession`, as in S18. Child: the child's `session.created` | root: the session opens through §4.7.4 and a send works. Child: before, neither row nor identity, and the next `subtask_update` registers it once. After, both, and no duplicate |
| W8   | create, then first turn | **known and not covered:** see below                                                                                                                                                      | —                                                                                                                                                                                |

**W8, the two-transaction create.** `session.create` with a first message commits twice:

1. `session.created`, `thread.created` and the sent draft's `draft.deleted` (`thread-service.ts:1849-1864`);
2. then `turn.started` (`:1506-1528`), from `sendTurn`, re-entered at `:1952-1981`.

A kill between the two leaves a session with no message, and the draft is already gone, so the
user's text is lost. That is a durability gap, not a sync divergence: rows and log agree on both
sides of it.

Closing it is not cheap. `turn.started` would have to join the first transaction, which means
splitting `sendTurn` into a part that validates and builds the events and a part that starts the
prompt. The artifact claim for draft images (`:1926-1946`) and its rollback would then have to
move inside the same transaction. That reaches into the server's ownership of draft images (#199),
well outside F3's rules.

F3 lists it here as a known window. It gets its own follow-up, with a W8 test written when it is
closed.

#### 4.7.7 Stored events across F3's format change

**(a) Today**

- **The replay reader parses every stored event with the current schema**
  (`apps/server/src/db/replay.ts:170-175`).
- **F3 changes events that are already in the log:**
  - §4.5 makes fields required (`turn.interrupted.reason`, `turnState` on interaction events);
  - X2 changes `session.created`;
  - §4.4 adds the preference `revision`.

  A replay that crosses the upgrade would throw, or would send a shape the client has to guess
  about. The doc did not cover this.

- **Upcasting at read time cannot be exact:**
  - an old `interaction.resolved`'s `turnState` depends on the turn's other interactions at that
    moment;
  - old deletions carry no child `session.deleted`;
  - an old `session.created` for a session deleted since has no provider anywhere.

**(b) Target: a replay floor per stream**

- **The floor.** `event_streams.replay_floor` (migration 21, default 0). A protocol constant,
  `EVENT_FORMAT_VERSION`, names the shape of stored events, and the database records the version
  its log was written in.
- **Raising it.** At boot, before recovery, when the recorded version is older than the server's,
  one transaction sets every stream's `replay_floor` to its `head_sequence` and records the new
  version.
- **Reading.** The replay reader treats sequences at or below the floor as not retained. A cursor
  below the floor gets a snapshot (`gap_expired`, an existing reason, so no client change). A cursor
  at the floor replays normally. Log rows are never rewritten, and retention is unchanged.
- **Why this is right.** Rule 4 already says "snapshot when the log no longer has the events". A
  log that has them only in a form the protocol can no longer state is that case.
- **Keeping the version honest.** A test pins a digest of the event schemas against
  `EVENT_FORMAT_VERSION`. Changing a schema without bumping the version fails it.
  - F3 is one release (§4.7.9), so it bumps the version once, from 1 to 2.
  - PRs A, B and C each update version 2's digest while the release is unmerged.

**Can a real client reach the floor, and with it the lossy snapshot? No.** Checked against the
code:

1. **Bookmarks live only in the transport's memory.** A cursor is a field of the transport's
   `Subscription` (`packages/environment-client/src/websocket.ts:336`, set at `:585`, `:867`,
   `:874`).
   - The store holds no cursors.
   - `cacheState` (`environment-client/src/cache-state.ts`) keeps store state only.
2. **A reload therefore never resumes from a bookmark.** It builds a new transport with an empty
   subscription map. Its opens hydrate each thread with `cursor: null` (`:903-911`), which is an
   `initial` snapshot. Its environment and session scopes subscribe without a cursor (`:807-811`).
3. **A transport cannot survive the upgrade.** The upgrade restarts the server, so every socket
   closes. The reconnect's handshake carries the old `PROTOCOL_VERSION`, and the exact match
   refuses it on both sides (`packages/protocol/src/negotiation.ts:131`, `:210-216`). The page has
   to reload to the new bundle, which by point 2 holds no bookmarks.
4. **A cursor below a floor therefore cannot occur** while event formats change only with the
   protocol version. F3 keeps that true with one bump that covers every format change (§4.7.9).

The floor stays as the server's guarantee for any client that might keep bookmarks in future, and
in case a format ever changes without a protocol bump. For today's clients it is unreachable.

**The cached state is a separate case.** The upgrade reload starts from the IndexedDB cache, a
v16-shaped state. It has no cursors, but it has:

- old fold output: `failures`, open tools and thoughts;
- sessions without `providerId`.

`applySnapshot` would merge that state into the `initial` snapshots, and older pages would keep
their stale reasoning and tools: S10's cause, which exists on main for every reload. For the
upgrade reload F3 closes it:

- **PR A adds the discard.** The web cache records `PROTOCOL_VERSION` with the state
  (`apps/web/src/lib/environment-cache.ts`), and a read under any other version drops the cache.
  Today it checks only `environmentId` and the state's shape (`:56-66`).
- **A web test** writes a cached state under version N and checks that a client at N+1 drops it.

The first load after the upgrade is therefore a fresh load. F3 adds no new lossy path; the
ordinary reload's merge (S10) stays F5's.

**(c) Protocol and schema**

- `EVENT_FORMAT_VERSION`.
- Migration 21: `event_streams.replay_floor`, plus a record of the format version. Log metadata
  only, so I1 holds.

**(e) Edge cases**

- **A floor at or above the head.** The reader treats the stream as having no retained events.
  `decideReplay`'s null case (`packages/protocol/src/replay.ts:305-310`) then replays a cursor at
  the head as empty and sends a snapshot for a lower one. A floor passed as "oldest" would trip
  its range check (`:294-300`).
- **New streams** start at floor 0.
- **Paths that read stored events without the schema are unaffected:** the repository's dedupe
  compares raw JSON (`event-repository.ts:154-162`), and migration 11's backfill reads raw JSON.

#### 4.7.8 Corrections to revision 3.1

F3's verification found these against ad1e856.

1. **Status derivation.**
   - The repository derives status per causing event. It collects the results per `writeScope`
     call and writes them through a nested environment `writeScope` (`event-repository.ts:191-254`).
   - #219 added activity (`waitingOn`, `inBackground`) to its trigger (`:206-215`) and to its
     payload (`:228`).
   - The per-transaction pass keeps both, and every status event carries the activity, because the
     client clears it on a status without it (`state.ts:440-464`).
   - `changesSessionStatus` is at `:337-345`.
2. **Three producers write status themselves, with activity from memory**, bypassing the
   derivation:
   - `applyBackgroundTasks` (`thread-service.ts:957-1003`, `:983`);
   - `emitStatus` on an idle process exit (`:1303-1327`, called at `:2658`);
   - `forgetStaleBackgroundWork` (`:1611-1638`).

   With a per-transaction derivation they would double up. The rule (corrected after review): **a
   producer carries `status` only when rows cannot derive it.**
   - `applyBackgroundTasks` and `forgetStaleBackgroundWork` emit only their fact, the roster.
     Status and activity then come from the pass, which reads the roster and the open turn rows.
     Today the producer reads `!record.activeTurn` from memory (`:969`).
   - **An idle process exit is a fact rows cannot derive.** The provider died with no turn open,
     and nothing else records it. It stays an explicit, persisted `session.updated {status:
'error', updatedAt}` (`emitStatus`, `:1303-1327`, called at `:2658`).
   - `error` carries no activity, so memory's activity never reaches it.
   - **The pass must not double it.** It emits a derived `session.updated` for a session only for
     what the transaction's own `session.updated` events have not already stated. That is the
     final row compared with the last state those events announced, not with the state before the
     transaction.

3. **`sessions.updated_at` moves on every projection that sets status**
   (`event-projection.ts:60-62`), even when no `session.updated` follows (same status, same
   activity). §4.5's `updatedAt` is therefore compared in the pass, not added by intent (§4.7.1).
4. **The cached `turn.send` answer.** §3.1 says it is the turn "as it was at the start". It is the
   live turn object, mutated as the turn advances (`thread-service.ts:1505`, `:1579`, `:1590`). After
   a restart it is the row's state (`session-store.ts:439-457`). It can still disagree with a
   client that holds `waiting`, because memory never says `waiting`. The conclusion stands:
   responses stop writing turns, then `confirmTurnStart` goes.
5. **Workspace removal also detaches new-session drafts.** `drafts.workspace_id` is
   `ON DELETE SET NULL` (`migrations.ts:651`), and the client mirrors it in `detachWorkspaceDrafts`
   (`state.ts:422-426`). §4.4's removal row lists only `draft.deleted`. F3 also emits a
   `draft.saved` with `workspaceId: null` for each detached draft, in the same transaction, and
   §3.6 row 13 covers this mirror too.
6. **`turns.failure_reason` is read.** It is selected (`queries.ts:76-81`) and then dropped when
   mapped (`session-store.ts:276-287`, `:454`).
7. **The crash-window seam is not reachable and does not cover today's windows** (§4.7.6).
8. **A turn row stays `running` when its record is dropped by something other than its own load
   failure** (§4.7.3 point 4). Revision 3.2's first draft named the wrong mechanism: a session's
   own failed load does end its turn.
9. **A child's identity is a second commit** (§4.7.4).
10. **Stored events and the new required fields** (§4.7.7).
11. **`startedAt` is not read when a retry is answered from the log.** `findTurnByCommandId`
    (`session-store.ts:453-457`) builds the turn without `startedAt`, and `TURN_FOR_COMMAND_ID_SQL`
    (`queries.ts:104-107`) does not select `started_at`. Once `startedAt` is required (§4.5), the
    first retry across a restart would fail validation. F3 selects and maps it.
12. **The registry's and the composer store's own connections** (§4.7.11).
13. **Line drift since 606e2cc**, in the files F3 touches:
    - `event-repository.ts`: +8 to +16;
    - `thread-service.ts`: +17 to +47;
    - `state.ts`: +18 to +39;
    - `domains.ts`: +13;
    - `queries.ts`: +16.

    `database.ts`, `event-projection.ts`, `event-batcher.ts`, `event-service.ts`, `server.ts`,
    `workspaces.ts`, the composer files, the client's `websocket.ts`, `settle.ts` and
    `foldProtocolEvent.ts` have not changed.

#### 4.7.9 What this section changes elsewhere

- **X2 moves into F3.** §3.3's last bullet and §9's F5 row no longer carry it.
- **F3 is built and reviewed as three stacked PRs (A, B, C) but released as one.**
  - All three carry one protocol bump, **v17**, and migrations **21** and **22**.
  - They merge to main together, with one server release, and each PR description says so.
  - Main never holds an intermediate wire, so the user's web app breaks against their server once,
    not three times.
- **Later numbers:** one bump per phase. F4 takes v18, F5 v19 (and v20 if F5a and F5b release
  apart). F6 takes migration 23 and F7 migration 24.
- The cut and the build order are in the F3 plan.

#### 4.7.10 Read answers and mutation answers

**The distinction.** Rule 1 forbids the client to invent, or to pre-apply, the effect of its own
**mutations**. The answer to a **read** is the server stating a fact.

- **Read answers keep being applied, as the server's facts,** until F5's whole-environment snapshot
  replaces them.
- **Mutation answers become acknowledgements:** they settle an overlay entry (§3.2) and write
  nothing server-owned.

Every response writer in `packages/environment-client/src/websocket.ts`:

| Command                                                  | Writer today                                                         | Kind     | After F3 (PR)                                                                                                                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment.get`                                        | `applyEnvironment` (`:1163`)                                         | read     | kept                                                                                                                                                                                         |
| `workspace.list`                                         | `applyWorkspaceList`, removing unlisted ones (`:1166-1176`)          | read     | kept (until F5)                                                                                                                                                                              |
| `session.list`                                           | `applySessionList` (`:1197`)                                         | read     | kept (until F5, with the catalog walk)                                                                                                                                                       |
| `session.open`                                           | `applySessionOpen`: the summary and thread identities (`:1282-1287`) | read     | kept                                                                                                                                                                                         |
| `session.history`                                        | `applySessionHistory` (`:1336`)                                      | read     | kept (until F5)                                                                                                                                                                              |
| `composer.preferences.get`                               | `applyComposerPreference`, ordered by client tickets (`:1108-1136`)  | read     | kept, ordered by the server's `revision`: applied only when its revision is newer than the one held (C1). The tickets go                                                                     |
| `provider.catalog.get`, `provider.probe`, workspace icon | `applyProviderCatalog`, `applyProviderProbe` (`:1430`, `:1435`)      | reading  | kept (current readings, §3.2)                                                                                                                                                                |
| `workspace.add`                                          | `applyWorkspaceList([workspace])` (`:1180`)                          | mutation | acknowledgement. The registration's `workspace.updated` reaches the socket before the answer, because `workspace.*` publishes synchronously (`server.ts:284-285`). No overlay is needed (C1) |
| `workspace.remove`                                       | `applyWorkspaceRemoved` (`:1188`)                                    | mutation | `pending.removals` (C1)                                                                                                                                                                      |
| `session.create`                                         | `applySessionCreated` plus an invented status (`:1216-1239`)         | mutation | kept through B, filled from `input.providerId` and `announcedAt`; then `pending.creates` (C1)                                                                                                |
| `session.rename`, `session.title.regenerate`             | `applySessionTitle` with an invented source (`:1348`, `:1352`)       | mutation | rename: `pending.renames` (shows the requested title until server state has it or a newer title, or the command fails). Regenerate: no overlay; the event brings the title (C1)              |
| `session.settle`                                         | the settle tracker's masking (`settle.ts`)                           | mutation | `pending.settles` (C1)                                                                                                                                                                       |
| `session.acknowledge`                                    | `applySessionAcknowledged` (`:1364`)                                 | mutation | `pending.acks` (C1)                                                                                                                                                                          |
| `session.delete`                                         | `applySessionRemoved` (`:1372`)                                      | mutation | `pending.removals` (C1)                                                                                                                                                                      |
| `turn.send`                                              | `applyTurnStarted` (`:1387`)                                         | mutation | `pending.sends` by `commandId` (C1, C2)                                                                                                                                                      |
| `interaction.respond`                                    | `applyInteractionResolved` (`:1409`)                                 | mutation | `pending.answers` (C1)                                                                                                                                                                       |
| composer set commands                                    | `applyComposerPreference` (`:1135`)                                  | mutation | `pending.preferences`, settled by the acknowledgement's `revision` (C1)                                                                                                                      |

**The overlay table of §3.2 gains `pending.renames`.**

**A fresh browser still gets its facts.** The environment scope recovers without a cursor by
subscribing only (`websocket.ts:807-811`). The resync then reads the environment, the workspaces,
the first session page and the provider catalog (`:1024-1072`), and the composer reads its
preferences. All of these are reads, so all are kept. After a gap, the environment snapshot plus
row 27's preference re-read cover the same ground.

#### 4.7.11 One writer for workspace and composer rows

- **Today** the registry (`workspaces.ts:128`) and the composer store (`composer-store.ts:33`)
  each open their own connection and write their rows on it.
- **After B3 and B4,** every client-visible write to `workspaces`,
  `workspace_composer_preferences` and `provider_profiles` is a projection on the event
  repository's connection.
  - The two modules stop opening connections. They read through the event database's connection,
    so there is one writer and no second WAL reader to go stale.
- **Their caches** (the registry's `byId`, the composer store's maps) change only from committed
  records.
  - The persistent event service already calls its record callback after `COMMIT`, once per
    record, and synchronously for `appendAtomic` (`event-service.ts:59-97`; the callback is at
    `server.ts:268-286`).
  - The registry and composer writes go through `appendAtomic`, and the two modules apply each
    committed `workspace.*` or `composer.*` record from that production listener.
  - This is not §4.7.6's test-only `afterCommit`.
  - A command that writes reads its own result from the cache only after `appendAtomic` returns,
    which is after the listener ran.

---

## 5. Rule 3: one ordered queue

### 5.1 (a) Today

- **Durable events.** The batcher (`event-batcher.ts:66-93`) holds deltas for ≤100 ms (`:11`);
  any other event flushes first (`:78-79`). After commit, every durable event except `workspace.*`
  is published on its own `queueMicrotask` (`server.ts:284-286`).
- **Response order.** A synchronous command's response is sent during the dispatch tick, so it
  precedes the events that command caused. An **asynchronous** result is sent after its promise
  settles (`websocket.ts:374-376`), so it follows them.
- **Publish failures.** A failure after commit is logged and the record is not sent
  (`server.ts:270-283`). The connected client does not notice the gap until something later
  arrives.
- **Transient events** (`turn.notice`, `thread-service.ts:874-876`, `:885`), provider health
  (`server.ts:724`) and the client list (`websocket.ts:618-624`) go out synchronously, to every
  ready connection whatever its subscriptions (`websocket.ts:609-613`).
- **The client** buffers durable records during a replay (`websocket.ts:609-612`, `:822`,
  `:883-885`) but folds transients at once (`:630-635`), even into threads it has not opened.

### 5.2 (b) Target

**#213's `event-delivery.ts`** shares one microtask FIFO between durable and transient events
(`#213: apps/server/src/event-delivery.ts:15-36`), and #213 flushes the batcher before a notice
(`#213: apps/server/src/thread-service.ts:900`). Four things are left to fix:

- the `workspace.*` bypass (`event-delivery.ts:30`);
- the flush is the caller's job;
- there is one microtask per item, so the FIFO is only implicit;
- transients are still unscoped and unpositioned.

**Design.**

1. **One `DeliveryQueue` per process.** An explicit array of `{durable, record}` and
   `{transient, event, after}` items, drained by one scheduled microtask, strictly in order.
   Everything goes through it, including `workspace.*`, health and the client list. With
   responses no longer writing server state (I10), response-vs-event order no longer affects
   correctness. The client applies workspace responses only as acknowledgements after F3.
2. **`eventService.publishTransient(event)`** does three things in order:
   1. flush the batcher (`event-service.ts:95`), so everything produced before the transient is
      committed and enqueued;
   2. read the scope's head, `{epoch, head_sequence}` from `event_streams`, or `{processEpoch, 0}`
      for a scope with no row (`replay.ts:147-149`);
   3. enqueue `{transient, event, after: head}`.

   The thread service no longer flushes before a notice.

3. **Scoped fan-out.** A thread-scope transient goes only to connections subscribed to that scope,
   as `subscription.transient {subscriptionId, after, event}`. Unscoped transients (health, client
   list) keep their envelopes but go through the queue.
4. **One delivery per connection,** even if several of its subscriptions match.
5. **The batcher stays.** It coalesces writes (64 events per turn is after coalescing). Every
   non-stream event and every transient flushes it first, so it never reorders anything. Its cost
   is ≤100 ms of extra latency on streaming text.
6. **A frame that cannot be sent closes that connection** (I4). This covers an error thrown while
   building or sending a frame for one connection. The client reconnects and replays from its
   bookmark, which makes delivery at-least-once.
   - An error that is not specific to one connection is a server bug. Today it is caught at
     `server.ts:274-283`. It closes every connection subscribed to the affected scope.
   - Nothing is ever silently skipped. This also covers re-publishing stored terminal and close
     events after a retried write.

**As built (F4).** Three decisions the design above left open:

- **An answer drains the queue before it is sent.** No answer overtakes a record committed before
  it. That is what keeps `workspace.add`'s `workspace.updated` ahead of its answer, now that the
  bypass is gone. It also means `turn.started` and `session.created`, written while their command
  runs, now reach the socket before the answer. Point 1 says this order no longer matters to the
  client, and the client was checked for it: overlays are laid only where server state lacks the
  row.
- **Recovery from a gap or a stale epoch releases the live subscription first**
  (`subscription.unsubscribe`), then replays from the cursor. Commands are answered in order, so
  the replay's read covers everything the released subscription would have carried.
- **The frame that started a catch-up gets no second one.** If the answer still cannot place it,
  it is dropped with a warning: the server stated a position its log cannot back, and asking again
  would loop. Every other held frame goes through the full tables.

**Client handling, live and during catch-up.**

- From the moment `recover()` sends `subscription.replay` until its answer is applied, the
  subscription holds every frame for its scope, in arrival order. This replaces `buffered`
  (`websocket.ts:202`, `:822`). When the answer has been applied at cursor C, the held frames run
  through the live rules below. Outside catch-up, frames go through the same rules as they arrive.
- **A durable record**, given cursor C in epoch E:

  | Record                         | Action                                                               |
  | ------------------------------ | -------------------------------------------------------------------- |
  | same epoch, `seq <= C.seq`     | drop                                                                 |
  | same epoch, `seq == C.seq + 1` | apply; C advances                                                    |
  | same epoch, `seq > C.seq + 1`  | gap: start a recovery from C, holding this record                    |
  | another epoch                  | start a recovery (the answer decides the epoch), holding this record |

  Records carried by command responses are parked instead of triggering recovery (§3.2).

- **A transient** with position `after = (Ea, Sa)`:

  | Position                        | Action                                                              | Why                                                                                                           |
  | ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
  | `Ea == E`, `Sa == C.seq`        | apply                                                               | —                                                                                                             |
  | `Ea == E`, `Sa < C.seq`         | drop                                                                | it describes a moment older than the state on screen                                                          |
  | `Ea == E`, `Sa > C.seq`         | start a recovery from C, holding this transient                     | durable records it follows have not been applied. With a FIFO that means a record was lost or never published |
  | `Ea != E`, live                 | start a recovery, holding this transient                            | the server has moved to another epoch, or this client's epoch is stale. The answer settles which              |
  | `Ea != E`, held during catch-up | drop unless `Ea` equals the answer's epoch, then use the rows above | —                                                                                                             |

  After a recovery completes, the held transient goes through the same table against the new
  cursor. It is applied only if its `after` equals that cursor.

- **Why hold at all, given server-side order.** Before the server reads the replay, the new
  connection has no subscription for the scope, so no durable record can arrive early. Transients
  published before the read can, and `after` places them exactly.
- **Retry notices stay transient.** They are not stored and not in snapshots. The convergence
  comparison therefore excludes them (§8).

### 5.3 (c) Protocol (F4)

- New server message `subscription.transient`:
  `{type:'event', name:'subscription.transient', payload: {subscriptionId, after: Cursor, event: TransientEvent}}`.
  `TransientEvent` is `turn.notice`, which #213 extends in F7.
- Thread-scope transients are no longer sent unscoped.
- Protocol bump (v18, or the next free number). No migration.

### 5.4 (d) Deleted (F4)

- The per-item microtasks and the `workspace.*` bypass (`server.ts:284-286`).
- The log-and-skip publish handler (`server.ts:270-283`), replaced by "close the connection".
- `publishThreadEvent`'s direct path (`server.ts:757`, `websocket.ts:609-613` for thread events).
- The client transient ring (`websocket.ts:337`, `:630-635`).
- #213's caller-side flush.

### 5.5 (e) Edge cases and tests

- **The final durable record is lost, and then only a transient arrives** (a new test, F4). A seam
  in the delivery queue drops one record for one connection. The following transient's
  `after` is ahead of the client's cursor, so the client recovers, replays the missing record, and
  converges. Without the seam this can only happen through a bug, and with point 6 such a bug
  closes the connection instead.
- **A notice for a thread nobody has open** is not sent.
- **A notice published with deltas still in the batcher.** The flush commits and enqueues them
  first. This is B4 and B8, now solved by construction.
- **Head-of-line blocking.** A large fragmented answer delays every later frame on that
  connection, which is the price of one order. If a measurement shows sidebar freezes, the fix is
  per-scope lanes with per-scope order. It is recorded as an F6 measurement item (§10.1).

---

## 6. Rule 4: catching up

### 6.1 Replay

#### (a) Today

- `replayReader.read` (`replay.ts:144-177`) runs `decideReplay`
  (`protocol/src/replay.ts:281-312`): no cursor → `initial`, another epoch → `stream_reset`, a
  cursor ahead → `cursor_ahead`, not retained → `gap_expired`.
- It then caps the replay at 500 events and 256 KiB (`replay.ts:31-41`, `:154-169`); anything over
  becomes a `gap_expired` snapshot (`:169`).
- The live subscription is registered in the same tick as the read (`websocket.ts:510-514`).
- Non-thread scopes without a cursor never replay (`environment-client/src/websocket.ts:807-811`).
- Building the environment snapshot calls `workspaces.list()` (`server.ts:306`), which may write
  and append events in the middle of the read (§4.4).

#### (b) Target

1. **The decision**, in order:

   | Condition                     | Answer                                   |
   | ----------------------------- | ---------------------------------------- |
   | no cursor                     | `initial` snapshot                       |
   | another epoch                 | `stream_reset` snapshot                  |
   | cursor ahead of head          | `cursor_ahead` snapshot                  |
   | events not retained           | `gap_expired` snapshot                   |
   | `replayBytes > snapshotBytes` | `snapshot_smaller` snapshot (new reason) |
   | anything else                 | replay                                   |

   An empty gap is a replay of nothing. Ties go to replay.

2. **Exact sizes, no estimation constants.**
   - **`replayBytes` is the exact UTF-8 length of the replay answer, without serializing it.** It
     is three parts:
     1. `SELECT COALESCE(SUM(octet_length(event_json)),0), COUNT(*) FROM event_log WHERE scope_key = ? AND sequence > ?`.
        This is a range on the primary key `(scope_key, sequence)` (`migrations.ts:250-258`),
        bounded by retention at 10,000 rows (`event-retention.ts:12`). `LENGTH` would count
        characters, so it must be `octet_length` (SQLite 3.53 here);
     2. the per-record wrapper,
        `{"cursor":{"scope":…,"epoch":"…","sequence":N},"event":…}` plus a comma. Its length is a
        constant for the scope, plus the decimal digits of `N`, which are summed arithmetically
        over the range;
     3. the response envelope, a constant.

     A unit test asserts the formula against the real serializer.

   - **The snapshot is serialized only when it could win.** First compute a cheap **exact lower
     bound**:
     `L = SUM(octet_length(message_parts.content_json))` over the thread's messages
     `+ SUM(octet_length(turn_activity.state_json))` over its activity (plus `payload_json` after
     F6). The snapshot embeds each of those stored JSON values byte for byte (a parse/stringify
     round trip preserves them), so `snapshotBytes ≥ L`.
     - If `replayBytes ≤ L`, replay without building the snapshot.
     - Otherwise build the snapshot, which is needed anyway if it wins. Take its exact byte
       length, which counts pending interaction bodies, turns and ids automatically, and compare.
       A losing snapshot string is discarded.
   - For the **environment and session scopes**, the snapshot (about 50 KB today) is always built
     and measured.
3. **Materialized in the registration tick.** The read, the decision, the rows or snapshot, the
   serialization and the registration all run synchronously. `DatabaseSync` and one JS thread make
   that a point-in-time read: no write, and no retention pass (a timer on the same thread), can
   interleave. Snapshot reads are pure (§4.4), so building one appends nothing.
4. **Framing.** The answer is the normal `response` to `subscription.replay`, split by the
   transport if large (§7.2). The client knows it is complete at the last fragment; it is then
   matched by `requestId`, as today.
5. **Live events during a long answer** are enqueued behind it (§5). The send window and the
   backlog bound apply (§7.2): if they pile up past the bound, the scope goes lagging and gets a
   catch-up after the answer. The client holds anything for the scope that arrived earlier, and
   applies the answer atomically in one `store.update`.
6. **Idempotency.** The cursor rules of §5.2. `ReplayPayloadSchema` already rejects
   non-contiguous or duplicate replays (`protocol/src/replay.ts:219-251`).
7. **Every scope uses replay every time.** The `subscribe`-only branch goes
   (`websocket.ts:807-811`).
8. **Encoding cost.** Today the server parses an answer twice: `DurableEventSchema` per row
   (`replay.ts:170-175`) and `ReplayResponseSchema.parse` (`websocket.ts:516`). Measure in F5 and,
   if needed, concatenate the stored `event_json` without re-parsing it; tests keep the
   validation.

#### (e) Edge cases

- **Retention prunes before the replay:** `gap_expired`. It cannot prune mid-read (point 3).
- **The thread was deleted:** `missing` → `not_found` (`websocket.ts:506-509`).
- **The client reconnects while an answer is still downloading.** The partial message dies with
  the old socket, and the bookmark has not moved.
- **Applying 10,000 events on the client** is O(events × thread) with the copying fold. Measure in
  F5. If it is slow, apply into a mutable draft inside one `store.update`.

### 6.2 Snapshot = the whole chat

#### (a) Today

- **Thread snapshots** (`replay.ts:109-113`) hold the newest 100 messages, with reasoning capped
  at 384 KiB (`session-store.ts:385`, `:394-418`) and no failure text.
- **The environment snapshot** holds the newest 100 sessions (`replay.ts:90`).
- **History pages** (`session-store.ts:257-366`) re-send every turn, every pending interaction
  (one query per turn, `:274-286`, `:319-327`) and every plan (`:329-355`). Their interactions
  lack a `turnId`, which the client guesses (`state.ts:689-699`).
- **The client** merges both (§3.6 rows 18–20) and loads older pages on scroll
  (`environment-application.tsx:1665-1686`, `:1708-1712`).

#### (b) Target

1. **Thread snapshot** = `readThreadState(db, sessionId, threadId)`:
   - `thread`;
   - all `turns`, with `startedAt`, `finishedAt`, `origin`, `commandId`, `failure`,
     `interruptedBy`;
   - all `messages`;
   - all `reasoning`, uncapped;
   - all `tools`;
   - the full `order`, sorted by the shared ordinal;
   - pending `interactions`, with `turnId`.

   There is no `nextCursor`, and `order` is required. Plans stay out: the client does not fold them.

2. **Environment snapshot:**
   - `environment` and `workspaces`, from rows only (§4.4);
   - **every** session summary (#219's `sessionRowToSummary(database, row)`);
   - **every** composer preference, with its revision.

   **Session snapshot:** the summary and all its threads.

3. **`session.open` stays**: identities, plus resuming the provider runtime
   (`thread-service.ts:2231-2314`). Thread content always comes from `subscription.replay`.
   - **`session.history` is deleted:** the command, the response, server-side and in-memory paging
     (`thread-service.ts:2316-2363`), `listSessionHistory`'s paging, the client's
     `loadSessionHistory`, and app-core's `loadMoreHistory` and `history.hasMore`.
   - **Why not keep it unused.** A second read model of the same state, with a different
     interaction shape and a different turn rule, is what produced A6.
   - **`session.list`** is deleted if nothing else calls it (grep the CLI and tests in F5).
4. **The client's `applySnapshot` replaces.**
   - **Thread:** the server-owned part is replaced. The overlay entries for the thread are kept,
     and are reconciled against the new state by the lifetime rules of §3.2. Notices are emptied,
     then held transients are applied by §5.2.
   - **Environment:** `environment`, workspaces, sessions, their orders and the composer
     preferences are replaced. Drafts, selection, connection and overlays are kept. Threads of
     sessions that no longer exist are dropped. Drafts are re-listed (§3.6 row 27).
   - **Session:** summary and thread list.

   Unchanged objects keep their identity.

5. **Reload with the IndexedDB cache** (`apps/web/src/lib/environment-cache.ts:17-40`). The cache
   paints first; the first replay is `initial` and replaces it. Caching cursors with the state,
   written atomically, is a possible later optimization.

#### Merge helpers to delete

**On main (F5):**

| File                                                          | Delete                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/environment-client/src/state.ts`                    | `orderOfMessages` (`:93-99`), `mergeById` (`:102-110`), `mergeOrder` (`:113-123`), `retainOlderMessages` (`:616-622`), the merging `applySnapshot` body (`:547-605`), `applySessionHistory` (`:651-733`), `upsertSession`'s partial merges (`:150-250`), `applySessionList` (`:894-901`) |
| `packages/environment-client/src/websocket.ts`                | `reconcileCachedSessions` (`:946-1004`), the catalog walk (`:1027-1068`), the `subscribe`-only branch (`:807-811`), `loadSessionHistory` (`:1331-1345`), the history fallback in `openSession` (`:1310-1329`), the preference tickets (`:1089-1130`, if not already removed in F3)       |
| `apps/server/src/db/session-store.ts`                         | the paging parts of `listSessionHistory` (`:257-366`), `capReasoningText` and `REASONING_TEXT_BUDGET_BYTES` (`:379-418`)                                                                                                                                                                 |
| `apps/server/src/db/replay.ts`                                | `REPLAY_LIMITS`, `RECORD_OVERHEAD_BYTES`, `limits` (`:25-41`, `:54`, `:78`), the fit check (`:159-169`)                                                                                                                                                                                  |
| `apps/server/src/session-pagination.ts`                       | the whole file once `session.list` goes (`:11-28`)                                                                                                                                                                                                                                       |
| `packages/protocol`                                           | `session.history` (`commands.ts:141-142`, `:207`, `:257-273`), `HistoryCursorSchema` (`domains.ts:158-164`), `nextCursor` on the thread snapshot (`replay.ts:154`), the history paging in `pagination.ts`                                                                                |
| `packages/app-core/src/providers/environment-application.tsx` | `loadMoreHistory` and its state (`:1664-1686`), `history.hasMore`, `isLoading`, `loadMore` (`:1709-1711`) and their consumers                                                                                                                                                            |

**In #212 (not ported in F6):**

- `olderActivity` and `older.keep` (`#212: state.ts:575-605`, `:628`);
- `staleRetainedTools` (`:668`), `applyToolStates` (`:691`), `shownOutputBytes`/`newerOutput`
  (`:711-739`), `mergeToolState` (`:740`);
- the history walk and its asked-set (`#212: websocket.ts:881`, `:915-977`);
- `attachToolPayloads` and `partialToolPayload` (`#212: session-store.ts:470-576`);
- the page and payload budgets (`:439-453`);
- `boundToolOutput`/`shrinkToolOutput` and every `TOOL_*_MAX` (`#212: protocol/src/tool-output.ts:13-32`,
  `:132`, `:180`);
- `output_bytes`;
- the epoch bump and the legacy-settle migration (replaced by §4.2).

**In #213 (not ported in F7):**

- `retainOlderActivity`, `pageWindowStart`, `withoutMarkersFrom` (`#213: state.ts:664-733`);
- the snapshot-first `mergeById` lines, the three-way order merge, the notice fresh/non-fresh
  direction;
- `openTurnNotices` (`:100`);
- `boundNotices`, `NOTICES_PER_PAGE_MAX`, `NOTICE_BUDGET_BYTES` and the marker
  (`#213: session-store.ts:463-519`; `protocol/src/domains.ts:302-304`).

`settleLiveNotice` (`:94`) is re-decided in F7, as a server-stated notice lifetime.

#### (e) Edge cases and UI

- **Scroll.** One TanStack virtualizer keyed by message id. A replace that keeps ids and object
  identity keeps the anchor. Messages are never removed from a living thread. The "load older"
  spinners and their traps go away.
- **First paint of a huge chat** costs one download; the cache paints first, and liveness and
  flow control keep a slow download alive (§7.2).
- **A snapshot during a running turn.** Deltas still in the batcher come live after it.

### 6.3 (c) Protocol and schema (F5)

- `SnapshotReasonSchema` gains `snapshot_smaller`. `parseReplayResult` gives it the
  `gap_expired` validity rule (`protocol/src/replay.ts:335-347`).
- `ThreadSnapshotSchema`: `order` is required and `nextCursor` goes.
- The environment snapshot carries all sessions and all composer preferences.
- `session.history` (and probably `session.list`) and `composer.preferences.get` are deleted from
  the client path.
- `session.created`'s payload becomes a `SessionSummary`.
- Fragments, beats, keepalives, acks, the send window and lagging catch-ups (§7.2).
- Protocol bump. No migration.

### 6.4 As built (F5b, protocol v20)

Decisions the design above left open, or where the code differed:

- **Replay answers are the stored JSON.** The reader concatenates each row's `event_json` inside the
  fixed record wrapper and the socket sends that text as is, so `replayBytes` (`octet_length` sum,
  wrapper, digit count, envelope) is exactly what is sent. A unit test compares the formula with the
  serialized answer. Snapshots are validated once (`ScopeSnapshotSchema`) and serialized once.
- **The environment snapshot also carries provider profiles.** `provider.catalog.updated` is an
  environment-scope event and profiles are client-visible rows; a server-initiated catch-up runs no
  resync, so a missed profile change would otherwise wait for the next reconnect. Drafts stay out:
  the client marks them unlisted on every environment snapshot and `draft-sync` relists.
- **`session.list`, `session.history` and `composer.preferences.get` are deleted from the server
  too**, with `HistoryCursorSchema`, the session list cursor, `PAGE_LIMIT_*` and the pagers. The
  thread service keeps `summaries()` and `threadState()` as inspection reads for tests.
- **`readThreadState`** reads a thread with one query per table (turns, messages, parts, activity,
  pending requests); the old reader hydrated each message and each turn's requests separately.
- **Every scope recovers by `subscription.replay`**, the session scope included; the client folds
  a replay answer in one `store.update`. A replace keeps the identity of unchanged objects
  (`share`), so a catch-up that changes nothing re-renders nothing.
- **Small scopes now often catch up by snapshot.** For a short chat a snapshot is frequently smaller
  than even a short replay; that is the rule working, not a fallback.
- **Desktop** files its whole Convex transcript through its own `legacy-history.ts`.
- **What a provider lists is not sidebar state.** A session's commands and settings came to about
  1.3 MB of a 1.5 MB environment answer, and a whole environment made a phone reload slower than
  the paged list did. `SessionSummary.composer` keeps `modelId`, `modeId`, `configValues` and
  `usage`. A chat's listing lives on `threads.listing_json`: it arrives in the thread snapshot and
  as thread-scope `thread.listing.updated`, so only a browser with that chat open gets it.
- **A new chat borrows from the server, not from other sessions.** `composer_listings` holds what
  each provider last listed in each workspace, announced by `composer.listing.updated`, which names
  only the fields that changed. Settings compare without their current values: a draft shows its
  own preference, and two sessions on one provider would otherwise take turns announcing. The
  environment snapshot carries every pair, each distinct command and setting once
  (`ComposerListingsSnapshotSchema`): 84 KB where whole lists would be 303 KB on the same data.
  A subscription scope per pair would cost the snapshot nothing, at the price of a fourth kind of
  scope; that is the next step if 84 KB ever matters.
- **Event format 3.** `session.composer.updated` lost two fields and its schema is strict, so a
  stored one is not a valid event any more. Replay answers are stored JSON, so the bump is what keeps
  them away from clients: boot raises every floor, and a client below one catches up by snapshot.

---

## 7. Rule 5: no artificial limits, liveness and flow control

### 7.1 Every limit in the sync path

| Limit                                                                                                                                                         | Where                                                                   | Verdict                                 | Reason                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxBufferedBytes` 1 MiB → `slow_consumer` close                                                                                                              | `apps/server/src/websocket.ts:57`, `:248-251`                           | **Delete** (F5)                         | W4. The send window and the lagging rule bound memory without closing (§7.2)                                                                                                                                                                                         |
| Replay 500 events / 256 KiB, 512 B per record                                                                                                                 | `db/replay.ts:31-41`, `:154-169`                                        | **Delete** (F5)                         | The exact comparison (§6.1)                                                                                                                                                                                                                                          |
| Thread snapshot = newest 100 messages                                                                                                                         | `replay.ts:109-113` (`PAGE_LIMIT_MAX`, `domains.ts:148`)                | **Delete** (F5)                         | Whole chat                                                                                                                                                                                                                                                           |
| Environment snapshot = newest 100 sessions                                                                                                                    | `replay.ts:90`                                                          | **Delete** (F5)                         | Whole environment                                                                                                                                                                                                                                                    |
| Reasoning 384 KiB with a "not loaded" note                                                                                                                    | `db/session-store.ts:379-418`, applied at `:306`                        | **Delete** (F5)                         | A marker                                                                                                                                                                                                                                                             |
| `session.list` page budget 256 KiB                                                                                                                            | `session-pagination.ts:11-28`, used at `session-store.ts:192`           | **Delete** (F5)                         | Exists for the 1 MiB frame (`:10`)                                                                                                                                                                                                                                   |
| `PAGE_LIMIT_*` for `session.history`/`session.list`                                                                                                           | `domains.ts:146-149`                                                    | **Delete** with the commands (F5)       | —                                                                                                                                                                                                                                                                    |
| Client transient ring of 4096                                                                                                                                 | `environment-client/src/websocket.ts:633`                               | **Delete** (F4)                         | Positioned transients                                                                                                                                                                                                                                                |
| #212 tool caps (output 16 KiB with head/tail/omission, input 4 KiB, string 2 KiB, 16 locations, name 256, page payload 256 KiB, 896 KiB page, 8 KiB envelope) | `#212: protocol/src/tool-output.ts:13-32`; `session-store.ts:439-453`   | **Not ported** (F6)                     | Payload caps and markers                                                                                                                                                                                                                                             |
| #213 notice caps (50 / 32 KiB per page and the marker; `TURN_NOTICE_TEXT_MAX` 2000; `TURN_FAILURE_DETAIL_MAX` 500)                                            | `#213: session-store.ts:463-519`; `protocol/src/domains.ts:194`, `:296` | **Not ported** (F7)                     | A display length is UI truncation, not a protocol cap                                                                                                                                                                                                                |
| Liveness timeouts: server 30 s without any inbound frame; browser 45 s without any received frame                                                             | `protocol/src/heartbeat.ts` (rewritten, §7.3)                           | **Keep, redefined**                     | They define a dead (silent) peer. The server's has no throughput floor. The browser's implies about 12 B/s in steady state, and about 182 B/s for frames already in flight when the rate suddenly drops (8 KiB cap), because a browser sees only whole frames (§7.2) |
| Send window (256 KiB, auto-tuned to 2× the bandwidth-delay product, up to 4 MiB) and the 1 MiB live backlog bound                                             | `FLOW_POLICY`, §7.3                                                     | **Keep (new)**                          | Transport flow control, not a content limit. Past the bound, nothing is lost: the scope catches up from the log. They bound memory per connection                                                                                                                    |
| Inbound `maxPayload` 64 KiB                                                                                                                                   | `websocket.ts:56`, `:117`                                               | **Keep**                                | It bounds what an untrusted peer can make the server buffer. Uploads go over HTTP                                                                                                                                                                                    |
| `maxConnections`/`maxSubscriptions` 128, `maxCommands` 1024, handshake 10 s, close 1 s                                                                        | `websocket.ts:51-55`                                                    | **Keep**                                | Bounds on peers' resources, not on delivery                                                                                                                                                                                                                          |
| Rate limits                                                                                                                                                   | `websocket.ts:434-451`, `rate-limit.ts`                                 | **Keep**                                | Security                                                                                                                                                                                                                                                             |
| Batcher 128 events / 16 KiB / 100 ms                                                                                                                          | `db/event-batcher.ts:9-11`                                              | **Keep**                                | It bounds a write batch and does not change order                                                                                                                                                                                                                    |
| Retention 7 days / 10,000 per scope, tombstones 30 days                                                                                                       | `db/event-retention.ts:10-14`                                           | **Keep**                                | Storage policy; the snapshot covers the gap                                                                                                                                                                                                                          |
| `BACKGROUND_TASKS_MAX` 64                                                                                                                                     | `protocol/src/domains.ts:101`, sliced at `thread-service.ts:944`        | **Keep for now**                        | A display bound on a provider roster; it is not there for the frame                                                                                                                                                                                                  |
| `BROWSE_MAX_BYTES` 512 KiB, workspace icon sizes                                                                                                              | `filesystem.ts:131`, `workspace-icons.ts:30-40`, `domains.ts:81`        | **Outside the sync path; keep for now** | Their reasoning came from the 1 MiB close; relax them once fragments land                                                                                                                                                                                            |

### 7.2 Liveness and flow control

Revision 3 separates two jobs that revision 2 had merged into one acknowledgement stream.
gpt-6.1's confirmation pass showed the merge failed at both jobs:

- **Liveness.** It must answer "is the peer still there?" without any minimum transfer rate. At
  300 B/s, 4 KiB fragments arrive about 13.7 s apart, so a healthy slow download was killed.
- **Flow control.** It must bound what the server holds for a connection. A client acking at
  10 KiB/s while the stream adds 100 KiB/s kept the heartbeat happy while the backlog grew
  forever.

This is the standard split: TCP, HTTP/2 and SSH all pair keepalives with a send window.

#### (a) Today

- **Server:** a ping every 15 s. The pong is due 10 s after the ping was _queued_
  (`protocol/src/heartbeat.ts:12-16`, `:121-131`; `websocket.ts:259-273`). Only the matching pong
  counts (`heartbeat.ts:136-152`, `websocket.ts:331-343`).
- **Client:** it disconnects after 45 s without a whole parsed message
  (`environment-client/src/websocket.ts:545`).
- **Flow control:** none, except the 1 MiB `slow_consumer` close (`websocket.ts:248-251`), which
  is rule 5's target.
- **Failure modes:**
  1. The ping waits behind earlier data. If those bytes need more than 10 s to reach the browser,
     the server closes.
  2. A message that needs more than 45 s to arrive trips the client's timer, because a browser
     only surfaces whole messages.
  3. A slow consumer either trips the 1 MiB close or, before it, lets buffers grow.

#### (b) Options considered

- **Start the pong deadline when `ws` reports the ping flushed, or pause it while
  `bufferedAmount > 0`.** Rejected. Both observe only the first hop. Remote clients come through
  cloudflared on loopback (`docs/cloudflare-tunnel.md`), which takes the bytes at once.
- **Liveness from delivery-progress acks** (revision 2). Rejected: it imposes a throughput floor on
  healthy links, and it does not bound memory anyway (above).
- **Semantic chunks** (gpt-6.1's alternative: application messages staged until a final marker).
  - Revision 2 said they need a read transaction held for the whole download. That is
    overstated: chunks can be **materialized first**, exactly as this design materializes its one
    answer, so they need no long-lived SQLite snapshot.
  - The accurate reasons to prefer byte fragments:
    1. **One mechanism for every message.** A single large live event (a multi-megabyte
       `tool.updated` after F6) or a large command response needs splitting too. Semantic chunks
       need a chunker and a reassembly rule per message type, and a lone huge event cannot be
       chunked semantically at all.
    2. **No re-encoding.** Fragments are raw UTF-8 slices. Chunks either nest JSON in JSON (escaped)
       or define per-type partial schemas.
    3. **The fragment is also the pacing unit** of the send window below, and it bounds the gap
       between frames the browser can see.
  - What semantic chunks would add, incremental parsing, stays available inside the chosen framing
    (a newline-delimited answer body parsed per fragment) if a measurement ever needs it.

#### (b) Target

**1. Liveness: upstream beats and a client watchdog.**

- **Client → server beat.** The browser sends `{type:'beat'}` every **10 s** from a timer.
  Upstream frames travel the opposite direction from downstream data, so a slow or full download
  cannot delay them. Acks and commands count as beats too.
- **Server rule.** A connection is dead when **no inbound frame** (beat, ack or command) has
  arrived for **30 s**, which tolerates two lost beats. There is no server ping/pong deadline any
  more, and **no throughput floor on the server side**: the rule does not look at downstream bytes
  at all.
  - The machine-sleep check at the top of the message handler (`websocket.ts:296-299`) becomes
    "if `now − lastInbound ≥ 30 s` when a frame finally arrives, close". The timer may have been
    starved.
- **Server → client keepalive.** When the connection's send window is open and nothing is queued,
  the server sends a tiny `{type:'keepalive'}` frame every **15 s**. It replaces today's ping, and
  needs no answer.
- **Client watchdog.** The browser treats the server as dead after **45 s with no frame received**.
  It resets on every received frame: text, binary fragment or keepalive, before any parsing (today
  it resets after a parse, `websocket.ts:545`).
- **The one remaining floor, and why it cannot go.** A browser surfaces a WebSocket frame only
  when the whole frame has arrived, so between two frames it sees nothing. The watchdog therefore
  needs each frame to arrive within 45 s. The server keeps that true on slow links by sizing
  fragments to the measured delivery rate:
  - **fragment size** = `clamp(measuredRate × 2 s, 512 B, 8 KiB)`. It starts at **1 KiB** until
    the first acks give a rate;
  - **why an absolute cap.** Adaptation only sizes fragments not yet sent. Every fragment already
    handed to the socket (up to a whole window of them) drains at whatever rate the link drops
    to. Without a cap, a 64 KiB fragment in flight when a fast link falls to 1 KiB/s would take
    about 64 s and trip the 45 s watchdog. The cap bounds that worst case;
  - **two floors, stated honestly:**
    - **steady state, after adaptation:** a 512 B fragment plus 5 B of headers within 45 s,
      about **12 B/s** (≈0.1 kbit/s); about 23 B/s for the very first 1 KiB fragment. At 12 B/s,
      today's typical 20 KB chat takes almost half an hour;
    - **sudden drop:** an in-flight fragment at the 8 KiB cap within 45 s, about **182 B/s**
      (≈1.5 kbit/s). This holds for each frame already in flight while they drain; new
      fragments are then sized down to the new rate, so the steady-state floor applies again;
    - at 1 KiB/s an 8 KiB fragment takes about 8 s, far inside the watchdog. No usable link is
      below either floor;
  - both floors are properties of what a browser can observe, not delivery limits. The only way to
    lower them is a longer watchdog, which would detect a truly dead server more slowly;
  - **cost:**
    - on a fast link, fragments are 8 KiB, so the 5 B per frame (a 4-byte WebSocket header plus
      the flag) is about 0.06%;
    - a 5 MB answer is about 640 frames, which is negligible handling time on either side, and F5a
      measures it;
    - on a 300 B/s link, fragments are about 600 B, so the overhead is about 1%, and frames arrive
      every 2 s.
- **Processing time.** Beats come from a timer, so a long parse or apply on the main thread only
  delays them. The server tolerates 30 s, against tens of milliseconds measured for a 5 MB JSON
  parse; F5 measures parse, validation and apply on a copy of the real database.

**2. Flow control: a send window of unacknowledged bytes.**

- **Acks are flow control only.** The client sends `{type:'ack', received}`, its cumulative
  received payload bytes, when at least 1/8 of the window has arrived since the last ack, or
  250 ms after the last frame while anything is unacknowledged.
- **Window.** Each connection has an outbound queue. The writer hands frames to `ws` only while
  `sent − acked < window`. It never cuts a message: a fragmented message's fragments may straddle
  window openings, but nothing is interleaved inside it.
  - The window starts at **256 KiB**.
  - It grows to twice the measured bandwidth-delay product (bytes acked per round trip), up to
    **4 MiB**.
  - The ceiling limits throughput only when the bandwidth-delay product exceeds 2 MiB, about
    20 MB/s at a 100 ms round trip, which is beyond this app's path through Cloudflare.
- **Backlog bound and lagging scopes.** Frames waiting for the window are bounded too:
  - **Bound:** when the queued, not-yet-written bytes of scoped live frames for a connection would
    exceed **1 MiB**, the server cuts every scope with frames in that queue.
  - **What is dropped:** the scope's queued live durable records and positioned transients.
  - **What is never dropped:** the message currently being written; command responses (including
    replay answers); unscoped readings. Readings (provider health, the device list) are coalesced
    to the latest per key instead.
  - **What is recorded:** the subscription is marked **lagging** at the last cursor whose frame
    was actually handed to `ws`.
  - **What the client hears:** the server enqueues `subscription.lagging {subscriptionId, cursor}`.
    It is a few dozen bytes, exempt from the bound, and goes behind what is already written.
  - **While lagging,** nothing more is queued for the scope.
- **Catch-up.** When the queue drains below half the bound and the window is open, the server
  takes each lagging scope in turn:
  - it materializes a **catch-up answer** from the lagging cursor, in one tick, by the D9 rule:
    replay if the log still has it and it is not larger than the snapshot, else snapshot;
  - it resumes live delivery for the scope **in that same tick**, so nothing falls between;
  - it sends `subscription.catchup {subscriptionId, …replay or snapshot payload…}`. The payload has
    the same shape as a replay answer, and the frame goes through the window like any other.

  If the scope overflows again while its catch-up is still being written, it goes lagging again,
  from the catch-up's cursor.

- **Nothing is lost.** The event log is the truth. Dropping queued frames only moves their
  delivery to the catch-up answer.
- **Memory per connection** is bounded by:
  - the window (bytes in flight, at most 4 MiB);
  - plus the backlog bound (1 MiB);
  - plus at most one materialized answer per lagging scope, and only while that answer is being
    written;
  - plus pending command responses, already bounded by `maxCommands`.

**3. How this fits the rest of the design.**

- **The ordered FIFO (§5).** The process-wide delivery queue still decides order. Each
  connection's outbound queue receives frames in that order and writes them in that order. Within
  a scope, order is exact: what was written, then the catch-up answer from the last written
  cursor, then live frames after the answer's cursor.
  - A lagging scope is a **server-initiated recovery of that scope**. As with a client reconnect
    (each scope recovers on its own), the catch-up is the boundary at which order across scopes
    restarts.
  - Other scopes keep flowing in commit order while one scope lags.
  - I4 is restated accordingly (§2).
- **Positioned transients (§5.2)** of a lagging scope are dropped, which is acceptable for
  transients. After the catch-up, new transients carry `after` equal to the new cursor and apply
  normally.
- **The client's held-frame logic.** `subscription.lagging` puts the scope into the same holding
  state as a client-initiated recovery, without sending a request. No frames should arrive for it,
  and any that do are held.
  - `subscription.catchup` is applied exactly like a replay answer. A replay's `from` must equal
    the client's cursor; if it does not, the client starts its own `subscription.replay` from its
    cursor. Then held frames go through §5.2's tables.
  - If the socket closes while lagging, the normal reconnect replays from the bookmark.

**4. A half-dead downstream** (beats still arrive, but data stops reaching the browser). Timeline
from t0, when the downstream stalls:

| Time                                                                                      | What happens                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| t0                                                                                        | Bytes in flight stop being delivered, so no acks come back                                                                                                        |
| t0 + seconds                                                                              | `sent − acked` reaches the window, and the server stops writing. Server buffering stops growing at the window                                                     |
| t0 + whenever ≥ 1 MiB more queues up (immediately on a busy thread, never on an idle one) | The affected scopes go lagging, their queued frames are dropped, and memory is bounded by window + 1 MiB                                                          |
| t0 + ≤ 45 s                                                                               | The browser's watchdog has seen no frame, closes the socket and reconnects. It replays from its bookmark, and the old connection's catch-up state is discarded    |
| —                                                                                         | The server keeps the old connection only until its close arrives. If upstream is dead too, no beats arrive and the server closes at its last inbound frame + 30 s |

**5. The `slow_consumer` close is deleted.** The window and the lagging rule bound memory without
closing a live connection or losing content.

#### (e) Edge cases

- **A tunnel client and a loopback server.** Flow control works on what the browser acknowledges,
  so cloudflared's buffering is irrelevant to it.
- **A huge single message on a slow link,** for example a 5 MB snapshot at 300 B/s, takes about
  4.6 hours. It is delivered intact: beats keep the server's side alive, about 600 B fragments
  every 2 s keep the watchdog alive, and the window paces it.
- **Old clients:** none; the version must match exactly.
- **Compression** (`perMessageDeflate` is off, `websocket.ts:118`) is a possible measured
  follow-up, orthogonal to this.
- **Memory:** answers are held as one string or `Buffer`; fragments are `subarray` views.
- **Test seams:**
  - the client's `WebSocketLike` (`environment-client/src/websocket.ts:92-100`) needs
    `binaryType = 'arraybuffer'`, and the fakes need binary frames;
  - the server exposes per-connection queued and in-flight byte counts to tests (S15).

**As built (F5a, protocol v19).** Decisions the design above left open:

- **Small messages stay text.** A message that fits in one fragment (at the current rate) is an
  ordinary text frame; only a larger one is cut into binary fragments `[flag][UTF-8 slice]`. Acks
  count a text frame's UTF-8 length and a binary frame's byte length, flag included; the server
  never re-encodes to count.
- **Acks** go every 32 KiB (1/8 of the initial window; the client does not know the current one)
  or 250 ms after the last frame while anything is unacknowledged.
- **Keepalives** go when nothing has been written for 15 s and no message is half-written. They do
  not wait for the window: a few bytes, and what tells the browser the server lives while acks lag.
- **The lagging cursor** is the newest cursor the connection was sure to deliver: the last record
  written, or a queued replay answer's cursor (answers are never dropped).
- **The window** follows twice the delivery rate times the minimum delivery delay seen over the last
  10 s (the minimum, so a queue in a proxy does not inflate it).
- **Server code:** `apps/server/src/connection-writer.ts` (queue, window, fragments, backlog,
  lagging) and `websocket.ts` (liveness, catch-up through the replay reader). Until F5b removes the
  replay caps, a catch-up past 500 events or 256 KiB is a `gap_expired` snapshot.
- **S15** is checked with the link healed once the producer stops: delivering ~6 MB at 10 KiB/s
  takes ten minutes whatever the protocol does.

### 7.3 (c) Protocol (F5)

- **Client messages:** `beat`; `ack {received}`. `pong` is removed.
- **Server messages:**
  - `keepalive`, which replaces `ping`;
  - binary fragments, 1-byte flag plus a UTF-8 slice;
  - `subscription.lagging {subscriptionId, cursor}`;
  - `subscription.catchup {subscriptionId, mode, …}`, the same payload union as a replay answer.
- **`heartbeat.ts` is rewritten:**
  - server state `{lastInboundAtMs, nextKeepaliveAtMs}`;
  - client state `{lastFrameAtMs, nextBeatAtMs}`;
  - `HEARTBEAT_POLICY = {clientBeatIntervalMs: 10_000, serverInboundTimeoutMs: 30_000, serverKeepaliveIntervalMs: 15_000, clientIdleTimeoutMs: 45_000}`.
- **New `FLOW_POLICY`:**
  `{initialWindowBytes: 256 KiB, maxWindowBytes: 4 MiB, backlogBytes: 1 MiB, minFragmentBytes: 512, initialFragmentBytes: 1 KiB, maxFragmentBytes: 8 KiB}`.
  These are transport parameters, to be measured in F5a.
- `packages/protocol/docs/heartbeat.md` is rewritten.
- Bumped with §6.3.

---

## 8. Rule 6: the convergence harness (F2)

### 8.1 The property

After any sequence of operations, once the link is healthy and the server has been quiet for more
than the batcher window, `normalize(clientUnderTest) == normalize(freshClient)`.

- **`freshClient`** is a new `environment-client` with an empty store, on a clean link. It opens
  the same active session and waits for `ready`. On main it then walks all older history pages,
  so whole chats are compared.
- **`normalize`** keeps the server-owned state:
  - workspaces;
  - session summaries in `selectSessionList` order (status, title, titleSource, updatedAt,
    settledAt, doneAt, backgroundTasks, composer, threadIds, #219's `waitingOn` and
    `inBackground`);
  - per thread: turns, messages, reasoning, tools, order, pending interactions, and failures (on
    main) or `Turn.failure` (after F3).

  It drops the client-owned state and **transient notices**.

- **A third check** compares with the server's own read (`readThreadState`; on main,
  `listSessionHistory` walked to the start).
- **"Equal" is eventual:** poll every 50 ms, up to 10 s. On timeout, fail with a structural diff.

### 8.2 The rig

- **Where.** `apps/server/tests/convergence/`, with `@openmanager/environment-client` as a
  devDependency of `@openmanager/server`.
  - Risk: the package is source-only, with extensionless imports. vitest resolves those; Node
    alone does not.
  - Fallback: a small workspace package, `tests/convergence`.
- **Server child.** `server-child.ts` runs the real `startServer` on a temp `dataDir`:
  - `generateTitles: false` and no `titleGenerator` (`config.ts:46-48`; the CLI default is `true`,
    `:222`), because a title CLI would make runs nondeterministic;
  - health probes off;
  - `runtimeOptions.connections = new FakeConnectionFactory(...)`
    (`packages/agent-runtime/src/session/test-connection.ts:123-143`), driven over IPC:
    `emitText`, `emitThought`, `openTool`, `updateTool`, `finishTool`, `askPermission`
    (`requestPermission`), `completeTurn(stopReason)`, `crashProvider` (`.crash()`), and a
    configurable `newSession` delay;
  - a **restart** is `SIGTERM` and a respawn on the same `dataDir`; a **crash** is `SIGKILL`.
- **Link proxy.** A `net` proxy gives a stable URL across respawns. Per direction it can
  `throttle(bytesPerSecond, bufferBytes)`. It reads from the server into a buffer of at most
  `bufferBytes` and then stops reading, so TCP backpressure reaches the server, as cloudflared's
  flow-controlled path does. A large buffer models cloudflared absorbing bytes. It can also add
  `latency(ms)`, `blackhole()` (stop forwarding but keep the sockets) and `cut()`, and record frame
  order (the S5 probe).
- **Server metrics seam.** The server child reports per-connection queued, in-flight and buffered
  bytes over IPC (§7.2 (e)), for S15.
- **Clients.** `createWebSocketEnvironmentClient` with `ws`'s `WebSocket`.
  - **Reload** disposes the client and seeds a new store with `cacheState(oldState)`. F2 exports
    that pure function from `apps/web/src/lib/environment-cache.ts:17-40`.
  - Commands go through the real client API.

### 8.3 Generation

- **Scripted scenarios** (§8.4).
- **Model-based runs:** a seeded PRNG picks 20–40 operations from a weighted alphabet, with
  preconditions checked against a tiny model. The property is checked after every `waitQuiet` and
  at the end.
- CI runs a fixed seed set; a nightly job runs more. A failing seed prints its operations, so it
  can be replayed as a scripted test.

### 8.4 Scenarios, and the exact construction of each failure on main

- **The gate is a demonstration, not a count.** F2 runs each "fails on main" scenario as
  `it.fails`, and records the structural diff it produced. A reviewer checks the diff shows the
  stated cause.
- **A construction that does not fail on main** is reported as such, kept as a regression guard,
  and not counted as evidence.
- When a later phase makes one pass, `it.fails` errors and the phase flips it to `it`.

| #          | Construction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Expected on main                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Green in                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| S1         | Start a turn. `openTool` (left in progress), `emitThought` (no text after it), `askPermission`. Client A holds a thread cursor. `SIGKILL` the server child, respawn, and let A reconnect with its cursor                                                                                                                                                                                                                                                                                              | The replay is empty. A shows the turn running, the tool `in_progress`, the thought open and the permission pending; the fresh load shows the turn `interrupted`, no pending permission and the session `error` (W1)                                                                                                                                                                                                                                                                                        | F3                                     |
| S2         | `emitThought`, then `emitText`, then `completeTurn('end_turn')`, connected throughout                                                                                                                                                                                                                                                                                                                                                                                                                 | A has the thought at `phase:'stop'` (fold closed it); the fresh load's row says `delta`                                                                                                                                                                                                                                                                                                                                                                                                                    | F3                                     |
| S3         | `openTool`, then `completeTurn` without finishing the tool                                                                                                                                                                                                                                                                                                                                                                                                                                            | Both sides show `in_progress`, so it passes on main. A regression guard: after F3 both must show `cancelled`                                                                                                                                                                                                                                                                                                                                                                                               | —                                      |
| S4         | Build a thread with **more than 100 messages**, whose early turns include thoughts and tools. A walks every history page. `cut` A, produce **more than 500 events or 256 KiB** in that thread, and reconnect                                                                                                                                                                                                                                                                                          | A `gap_expired` snapshot drops A's older reasoning and tools and rebuilds the older order from messages. A's history cursor is null, so they never return. The fresh load (all pages walked) has them (W2)                                                                                                                                                                                                                                                                                                 | F5                                     |
| S5         | `emitText`, then a recoverable runtime error that the server turns into `turn.notice`, then `emitText`, while recording wire order. F2 must first confirm which fake hook yields a recoverable `rpc_error`; the fallback is a failed generated-image store (`thread-service.ts:874-876`) with the artifact store made to throw                                                                                                                                                                        | The notice reaches the client before the first text, which is still in the batcher (W3)                                                                                                                                                                                                                                                                                                                                                                                                                    | F4                                     |
| S6         | `emitText` totalling **1.2 MB** in one message; a fresh client opens the thread. A second variant: thoughts totalling **more than 384 KiB**                                                                                                                                                                                                                                                                                                                                                           | (a) The fresh client's snapshot frame exceeds 1 MiB and the socket closes with `slow_consumer`; it loops, and the property cannot be evaluated. (b) The fresh load shows the "not loaded" note while A holds the full text                                                                                                                                                                                                                                                                                 | F5                                     |
| S7         | `throttle(10 KB/s, 256 KiB)`. Right after the handshake, open a thread whose snapshot is **about 600 KB**: under 1 MiB, so `slow_consumer` cannot fire, and about 60 s to deliver                                                                                                                                                                                                                                                                                                                     | **On main:** the ping queued at about 15 s sits behind about 450 KB still to deliver, so the server closes at about 25 s with `heartbeat_timeout`. Independently, the client's 45 s idle timer would fire. It reconnects and loops. (A 300 KB transfer at 20 KB/s ends at about 15 s and does **not** fail; that was the first draft's mistake.) **After F5a:** beats keep the server side alive, 8 KiB fragments (the cap) arrive about every 0.8 s, and the answer completes at about 60 s and converges | F5                                     |
| S8         | A **second** client B is connected. The fake provider's `newSession` is delayed **500 ms**. A creates a session. A second variant: register a child session through `subtask_update`                                                                                                                                                                                                                                                                                                                  | `persistRuntimeSession` (`thread-service.ts:1833`; child: `:1348`) bumps `updated_at` after `session.created` committed. B's `updatedAt` (the event time) and B's sidebar order differ from a fresh listing. Resume does **not** trigger it: `restoreSession` (`:712`) does not stamp                                                                                                                                                                                                                      | F3                                     |
| S9         | Delete a parent session with a child while B is `cut`, then create a gap that leaves the replay window. With fewer than 500 events, B replays `session.deleted` and today's cascade handles it, so pass; the scenario must exceed it, for example by 501 renames of another session. Have **more than 100 sessions**, so the catalog walk is multi-page. Keep updating sessions **while B's walk runs**, so none of `reconcileCachedSessions`' three passes fits on one page (`websocket.ts:977-993`) | The environment snapshot only upserts, and reconciliation never settles, so B keeps the deleted sessions. **If F2 cannot make this fail deterministically, it becomes a regression guard** (gpt-6.1 notes the reread often settles on its first page)                                                                                                                                                                                                                                                      | F3 (events) and F5 (whole environment) |
| S10        | A thread with **more than 100 messages** and thoughts and tools in early turns. A walks all pages, then `reload`s with the cache seeded                                                                                                                                                                                                                                                                                                                                                               | No cursor, so an `initial` snapshot of the newest 100. `applySnapshot` keeps the cached older messages and the null history cursor, but drops their reasoning and tools. The fresh load (all pages walked) has them                                                                                                                                                                                                                                                                                        | F5                                     |
| S11        | `blackhole(30 s)` while idle                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Sanity check, must pass on main: the heartbeat closes, then a reconnect and convergence                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                      |
| S12        | Streaming, then a short `cut`, then fewer than 500 events of gap                                                                                                                                                                                                                                                                                                                                                                                                                                      | Sanity check, must pass on main: an incremental replay                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —                                      |
| S13 (F4)   | The delivery-queue seam drops one durable record for A, then a notice for the same scope is published (§5.5)                                                                                                                                                                                                                                                                                                                                                                                          | Not run on main, because the seam does not exist there                                                                                                                                                                                                                                                                                                                                                                                                                                                     | F4                                     |
| S14 (F5a)  | **A slow but healthy link:** `throttle(300 B/s, 64 KiB)`, then open a thread with an answer of **about 30 KB** (about 100 s; the nightly variant uses 300 KB, about 17 min)                                                                                                                                                                                                                                                                                                                           | **On main:** fails, closed by the heartbeat at about 25 s and looping. **After F5a:** it must complete and converge with no reconnect, and the harness asserts zero heartbeat closes                                                                                                                                                                                                                                                                                                                       | F5a                                    |
| S16 (F5a)  | **A sudden rate drop mid-answer:** start a large answer (about 2 MB) on a fast link (`throttle(5 MB/s, 256 KiB)`), and once about 1 MB has been delivered switch the proxy to `throttle(1 KiB/s, 256 KiB)`                                                                                                                                                                                                                                                                                            | **After F5a:** every fragment already in flight (≤ 8 KiB each) arrives within about 8 s, the browser watchdog never fires, the following fragments shrink to about 2 KiB, and the answer completes with no reconnect. The harness asserts zero watchdog closes. The run is long, so it is nightly, with a CI variant that drops to 1 KiB/s with only about 64 KiB left                                                                                                                                     | F5a                                    |
| S15 (F5a)  | **Fast producer, slow consumer:** the provider emits about **100 KiB/s** of text into A's open thread for 60 s, while A's link is `throttle(10 KiB/s, 256 KiB)`. Sample the server's per-connection queued plus in-flight bytes every second                                                                                                                                                                                                                                                          | **On main:** the server's `bufferedAmount` passes 1 MiB, it closes with `slow_consumer`, and it loops; or, with a large proxy buffer, the backlog grows without bound. **After F5a:** the sampled bytes never exceed window + backlog bound + one materialized answer; A sees `subscription.lagging` and then `subscription.catchup`; after the producer stops, A converges                                                                                                                                | F5a                                    |
| W1–W7 (F3) | **Crash windows**, one per former row-then-event pair (§4.4): kill the child between the two operations, through the `beforeCommit` seam                                                                                                                                                                                                                                                                                                                                                              | On main a row without its event, or an event without its row, after the restart                                                                                                                                                                                                                                                                                                                                                                                                                            | F3                                     |

---

## 9. Protocol and schema summary

| Phase        | Protocol                                             | Migration                                                                                                                                                               | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #219 (first) | none (additive)                                      | **20**: `turns_thread_state_idx`                                                                                                                                        | `waitingOn`, `inBackground`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| F2           | none                                                 | none                                                                                                                                                                    | tests; the `cacheState` export                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F3           | **v17** (or the next free number)                    | **21** (A): `turns.failure_message`, `turns.interrupted_by`, `event_streams.replay_floor`; **22** (B): `workspaces.git_json`, `workspace_composer_preferences.revision` | `cancelled` tool status; `interaction.cancelled`; `turn_ended` and `server_restarted` reasons; `turnState`; `turn.interrupted.reason`; `Turn.commandId`/`.failure`/`.interruptedBy`; `startedAt` always set; `session.updated.updatedAt`; workspace events for every workspace write, plus derived recency; `capabilities.providers` replaced by health `available`; preference `revision`; cascade `session.deleted`/`draft.deleted`; boot recovery and the legacy repair (events, not migrations) |
| F4           | **v18**                                              | none                                                                                                                                                                    | `subscription.transient {after}`; close-on-send-failure                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| F5           | **v19** (v19 and v20 if F5a and F5b ship separately) | none                                                                                                                                                                    | fragments, `beat`, `keepalive`, `ack`, the send window, `subscription.lagging`/`subscription.catchup`, `pong` removed; `snapshot_smaller`; whole snapshots (environment with preferences); `session.history`, `composer.preferences.get` and probably `session.list` deleted; `SessionSummary` in `session.created`                                                                                                                                                                                 |
| F6           | next                                                 | **22**: tool payload columns (from #212's 20)                                                                                                                           | tool payload fields, `declined`; no caps                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| F7           | next                                                 | **23**: #213's notices table                                                                                                                                            | durable notices; typed failure `detail`; transient retry notices through F4                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## 10. Phase plan

The process rules apply: one phase at a time; Opus builds; gpt-6.1 and Fable or Opus review; the
user merges; every agent summarizes only what it did.

### 10.1 Phases

**F2: the convergence harness** (tests only).

- **Files:**
  - new `apps/server/tests/convergence/{harness.ts, server-child.ts, link-proxy.ts, normalize.ts, scenarios.test.ts, model.test.ts}`;
  - `apps/server/package.json`;
  - `apps/web/src/lib/environment-cache.ts` (export `cacheState`).
- **Risks:** package resolution (fallback in §8.2); timing (wait on conditions, never sleep;
  `waitQuiet` is 300 ms); Windows child processes (explicit stdio; the Windows CI temp directory is an 8.3 short name).
- **Verified by:** the §8.4 demonstrations, each with its diff. Independent of #219.

**F3: server truth** (rules 1 and 2). After #219.

- **Files:**
  - `apps/server/src/db/{database.ts, event-repository.ts, event-projection.ts, migrations.ts, session-store.ts, queries.ts}`;
  - new `db/turn-closure.ts` and `db/boot-reconcile.ts` (recovery and repair);
  - `apps/server/src/{event-service.ts, server.ts, thread-service.ts, workspaces.ts, composer-store.ts, composer-service.ts, provider-service.ts}`;
  - `packages/protocol/src/{domains.ts, events.ts, providers.ts, negotiation.ts}` and fixtures;
  - `foldProtocolEvent.ts`;
  - `packages/environment-client/src/{state.ts, websocket.ts, settle.ts, mock.ts, types.ts}`;
  - `packages/app-core` (readers of `failures` and of workspace `capabilities.providers`);
  - `apps/desktop/...` (the isolated legacy contract, §3.5);
  - docs: `session-status.md`, `history-replay.md`, `proof-slice.md`.
- **Order inside F3:**
  1. responses stop writing state, and the overlays land;
  2. then `confirmTurnStart` goes;
  3. explicit child events and recovery;
  4. the repair;
  5. workspace and composer projections.
- **Risks:**
  - the new assertions may reject event streams that are tolerated today. Run the live-provider
    suites, and a boot on a copy of the user's database;
  - repair volume on that copy;
  - in-memory-mode drift;
  - the composer and workspace refactor touches routing (`resolve`, `get`).
- **Verified by:**
  - S1, S2 and S8 go green, and S9 partly;
  - the crash-window tests;
  - unit tests for `turn-closure` (each child kind, deterministic ids, re-publish), recovery (same
    epoch, continuing sequences, one transaction per turn, a failing turn logged and skipped), the
    repair (idempotent, close-only accepted, other late events rejected), and the per-transaction
    derived status;
  - **desktop typecheck and adapter tests** as a gate.

**F4: one ordered queue** (rule 3). After F3.

- **Files:** `apps/server/src/{event-delivery.ts (from #213), event-service.ts, server.ts, websocket.ts, thread-service.ts}`;
  `packages/protocol/src/{replay.ts, negotiation.ts}`; `packages/environment-client/src/websocket.ts`.
- **Risks:** removing the `workspace.*` bypass; close-on-send-failure turning a latent bug into
  reconnects (log loudly).
- **Verified by:** S5 and S13 go green; unit tests for the FIFO, the transient table and the
  record table (§5.2).

**F5: catch-up and limits** (rules 4 and 5), in two PRs in sequence.

- **F5a, transport:**
  - rate-sized binary fragments;
  - liveness: upstream beats, the 30 s server inbound timeout, idle keepalives, and the per-frame
    browser watchdog, replacing ping/pong;
  - flow control: acks, the send window, the backlog bound, `subscription.lagging` and
    `subscription.catchup`;
  - the deletion of `slow_consumer`;
  - the catch-up uses the existing replay reader; F5b then removes that reader's caps.
  - Files: `apps/server/src/websocket.ts`, `packages/protocol/src/{heartbeat.ts, clients.ts or envelopes.ts, negotiation.ts}`,
    `packages/protocol/docs/heartbeat.md`, `packages/environment-client/src/websocket.ts`, the test
    fakes.
  - Verified by: S6(a), S7, S14, S15 and S16 go green. Unit tests:
    - no fragment exceeds 8 KiB, whatever the measured rate;
    - beats keep a connection whose downstream is slow;
    - 30 s of inbound silence closes;
    - the browser watchdog resets on fragments and keepalives;
    - the window never exceeds its size;
    - the backlog bound triggers lagging, then the catch-up equals the log;
    - the half-dead-downstream timeline (§7.2 point 4);
    - measured frame, ack and catch-up CPU.
  - Risks: tuning the window and the backlog bound (measure on the tunnel); catch-up storms on a
    connection that keeps overflowing (each catch-up is one answer, and its size follows the D9
    rule).
- **F5b, semantics:** exact sizing and `snapshot_smaller`, whole snapshots (thread and
  environment, with preferences), the client replace, and deleting `session.history`, the catalog
  walk and every merge helper (§6.2).
  - Files: `apps/server/src/db/{replay.ts, session-store.ts}`, `session-pagination.ts`,
    `thread-service.ts`, `packages/protocol/src/{replay.ts, commands.ts, domains.ts, pagination.ts}`,
    `packages/environment-client/src/{state.ts, websocket.ts, types.ts, wire.ts}`,
    `environment-application.tsx`, and the transcript's scroll and "load older" UI.
  - Verified by: S4, S6(b), S9 and S10 go green; model seeds pass; the replay-size formula equals
    real serialization; measured snapshot, replay, parse and apply times on a copy of the real
    database; **desktop typecheck as a gate**.
- **Risks:** client CPU on big replays; the scroll anchor; removing `session.list` while something
  uses it.

**F6: rebuild #212 (tool output).**

- **Keep:**
  - **A1** (OpenCode `patchText` stripped), **A2** (ACP `rawOutput.{output,error}`), **A11** (Claude
    edit-result bodies), **A17** (the projection-side cut);
  - the shared `applyToolUpdate`;
  - the `toolName`/`input`/`output`/`locations`/`lineChanges`/`startedAt`/`finishedAt` fields, the
    `declined` status, and the `toolCallId` on generated images.
- **A5** only applies if some byte bound remains; confirm, do not port blindly.
- The "no diffs in chat" policy stays (a content rule).
- **Not ported:** every cap, budget, marker, merge and walk (§6.2, §7.1), the epoch bump and the
  legacy-settle migration.
- **Re-measure** with `measure.mjs` on a database **copy**.
- **Decide after measuring, not before:**
  - **Tool output by reference, as artifacts,** fetched over HTTP like images, with only a
    reference in the event and snapshot. This would keep large outputs out of the socket and out of
    head-of-line blocking. **The open problem:** output grows while a tool streams, but artifacts
    are immutable. That needs an appendable artifact, a final artifact written at completion with
    inline deltas until then, or chunked artifacts.
  - **Per-scope delivery lanes,** if head-of-line blocking (§5.5) shows in the measurements.
  - Neither is a limit. Both are options that a measurement must justify.
- Migration 22 and the next protocol number.

**F7: rebuild #213 (notices and failures).**

- **Keep:**
  - **B5** (resendable), **B6** (dedupe with `resetsAt`), **B15** (Claude error text);
  - **B16** (translator reset at `openTurn`), plus the `usage` and drop-counter hole.
- **Durable notices** become events and rows in whole snapshots, with no caps or markers.
- **Transient retry notices** go through F4, with a server-stated lifetime (for example a transient
  `turn.notice.cleared`), not `settleLiveNotice`.
- **Re-review B3, B11, B13, B17** as client-owned state. B13 is superseded by `pending.sends`.
  B17's capability sniffing (`#213: packages/app-core/src/components/chat/MessageInput.tsx:365`)
  must not break desktop.
- Migration 23.

### 10.2 Where #219 touches the same code

| #219 change                                                                                 | Where                                                                   | Interaction                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readStatus` with `readSessionActivity`; status events when only the activity fields change | `#219: apps/server/src/db/event-repository.ts:108-113`, `:192-229`      | F3 replaces the per-event comparison with a per-transaction one. It keeps #219's activity fields, comparing them once per session per transaction |
| `db/session-activity.ts`, `waitingKind`                                                     | `#219`                                                                  | `interaction.cancelled` must count in `changesSessionStatus` (`event-repository.ts:321-329`)                                                      |
| `sessionRowToSummary(database, row)`                                                        | `#219: session-store.ts:169`, `:192`, `:219`                            | F5's whole environment snapshot calls it for every session; measure                                                                               |
| `pendingInteractions` as a map                                                              | `#219: thread-service.ts:126`                                           | F3's `turnState` source; compatible                                                                                                               |
| `touch()` and `activityOf` in-memory                                                        | `#219: thread-service.ts:1047-1090`                                     | In-memory mode only; keep it consistent or retire it                                                                                              |
| Client `activityOf` and the `session.updated` fold                                          | `#219: environment-client/src/state.ts:177-184`, `:236-245`, `:437-466` | F5 deletes the `upsertSession` merge but keeps the semantics. The server states them                                                              |
| Mock derivation                                                                             | `#219: mock.ts:286-334`                                                 | The mock emits the new events too                                                                                                                 |
| Protocol fields; migration 20                                                               | `#219: domains.ts`, `events.ts`, `migrations.ts:765-777`                | No bump from #219; F3 takes v17 and migration 21                                                                                                  |
| Test edits (`recovery-migrations`, `event-repository`, `background-work`)                   | `#219`                                                                  | F3 rebases on them                                                                                                                                |

### 10.3 What survives from #212 and #213

| Id                             | Survives?                       | Phase        |
| ------------------------------ | ------------------------------- | ------------ |
| A1, A2, A11, A17               | yes                             | F6           |
| A5                             | only where a byte bound remains | F6 (confirm) |
| A3, A6–A10, A12–A16            | no                              | —            |
| A4                             | replaced by §4.1 and §4.2       | F3           |
| B5, B6, B15, B16               | yes (B16 plus the `usage` hole) | F7           |
| B3, B11, B13, B17              | re-review as client-owned state | F7           |
| B2, B7, B9, B10, B12, B14, B18 | no                              | —            |
| B4, B8                         | replaced by F4                  | F4           |
| B1                             | moot                            | —            |

---

## 11. Open questions

**Q2. Should the sidebar be in F5?** Rule 1 applies to the sidebar as it does to chats (§3.6
rows 16–19, 23). The whole environment snapshot and deleting the catalog walk and
`reconcileCachedSessions` cost about one more PR.

**Recommendation: include it,** in F5b or as an F5c straight after. It is what makes S9 green, and
the environment snapshot already has to carry preferences (§6.2).

**Decided (user, 2026-10-18): included.** The sidebar work (§3.6 rows 16–19, 23, 26–27; §6.2's
whole environment snapshot) is part of F5 and is not optional or deferrable.

Resolved in this revision:

- **Q1** (legacy open children) is now decision D3, as a boot repair (§4.2).
- **Q3** (the slow-link floor) is resolved by D13 in revision 3. The server has no throughput
  floor. The browser's watchdog implies about 12 B/s in steady state, and about 182 B/s for frames in
  flight during a sudden drop (8 KiB cap), because a browser sees only whole frames. Both are
  below any usable link, so no user decision remains.

---

## Appendix A. Reference index (606e2cc)

**Server write path:**

- `apps/server/src/db/database.ts:17-34`, `:42-105`
- `apps/server/src/db/event-repository.ts:27-28`, `:81-87`, `:107-242`, `:244-269`, `:274-291`, `:321-329`
- `apps/server/src/db/event-projection.ts:46-59`, `:105-114`, `:129-132`, `:326-364`, `:388-397`, `:433-461`, `:483-570`
- `apps/server/src/db/event-batcher.ts:9-11`, `:27-35`, `:53-93`, `:99-150`
- `apps/server/src/event-service.ts:60-98`
- `apps/server/src/workspaces.ts:128-182`, `:221-253`, `:298-315`, `:397-424`, `:517-527`
- `apps/server/src/composer-store.ts:33-75`, `apps/server/src/composer-service.ts:111`, `:137`, `:222-224`
- `apps/server/src/thread-service.ts:419-426`, `:458-556`, `:693-736`, `:812-925`, `:1055-1083`, `:1338-1352`, `:1414-1424`, `:1460-1547`, `:1564-1591`, `:1820-1834`, `:2231-2363`, `:2578-2714`

**Server delivery and catch-up:**

- `apps/server/src/server.ts:161`, `:166`, `:205-222`, `:247-251`, `:259-310`, `:448-454`, `:724`, `:756-757`
- `apps/server/src/websocket.ts:50-58`, `:115-120`, `:245-273`, `:293-343`, `:364-380`, `:476-537`, `:588-624`
- `apps/server/src/db/replay.ts:25-41`, `:84-131`, `:144-177`
- `apps/server/src/db/session-store.ts:175-197`, `:257-366`, `:379-418`
- `apps/server/src/session-pagination.ts:11-28`
- `apps/server/src/db/event-retention.ts:10-14`

**Protocol:**

- `packages/protocol/src/replay.ts:30-37`, `:95-100`, `:147-196`, `:219-267`, `:281-350`
- `packages/protocol/src/heartbeat.ts:12-16`, `:93-166`
- `packages/protocol/src/events.ts:104-108`, `:126-197`
- `packages/protocol/src/commands.ts:141-142`, `:207`, `:251-273`
- `packages/protocol/src/domains.ts:101`, `:146-182`, `:209-247`, `:280-341`
- `packages/protocol/src/negotiation.ts:58`, `:131`

**Client:**

- `packages/environment-client/src/state.ts` (see §3.6, §6.2)
- `packages/environment-client/src/websocket.ts:92-100`, `:336-381`, `:536-636`, `:804-901`, `:946-1087`, `:1089-1130`, `:1180-1427`
- `packages/environment-client/src/settle.ts:20-80`
- `packages/environment-client/src/types.ts:443-449`
- `packages/agent-view/src/fold/foldProtocolEvent.ts:80-217`
- `packages/app-core/src/providers/environment-application.tsx:471`, `:733-742`, `:1471-1475`, `:1664-1712`
- `apps/web/src/lib/environment-cache.ts:17-40`
- `apps/desktop/src/renderer/src/environment/convex-environment-client.ts:8-24`, `:192`, `:941`

---

## Appendix B. Review responses

Every point was re-checked against 606e2cc. The Fable findings were available as the
coordinator's summary rather than the full text, and were checked against the code as summarized.

### gpt-6.1 (verdict: rework)

| #   | Finding                                                                                                                            | Response                                                     | Note                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Workspace register, rename, availability and recency commit rows before their events; `list()` writes during snapshot construction | **Accepted**                                                 | Verified at `workspaces.ts:166`, `:179`, `:309`, `:398`, `:523`, and at `:417-423` via `server.ts:306`. Extended: composer preferences and profiles have the same pattern, and `capabilities.providers` is a live reading inside a durable record (§4.4)                                                                                                                                                  |
| G2  | Responses are not safe upserts; a retried `turn.send` can rewind; rename invents provenance; preference ordering is client-issued  | **Accepted, with a narrower mechanism**                      | Verified: cached answer at `thread-service.ts:1414-1419`, guard at `state.ts:777-785`, `titleSource` invented at `websocket.ts:1346-1355` (the response is a bare `Session`, `commands.ts:251`), tickets at `:1089-1130`. Mutation responses never write state (I10, refined in §4.7.10). Durable-record responses are specified but not needed on the chat path. Preferences get a server revision in F3 |
| G3a | Use periodic client beats independent of bytes                                                                                     | **Changed (revision 3: adopted)**                            | Revision 2 rejected beats because they do not bound buffering. Revision 3 bounds buffering with a separate send window and the lagging rule, so beats are now right for liveness (§7.2)                                                                                                                                                                                                                   |
| G3b | The throughput floor is an artificial limit                                                                                        | **Changed (revision 3)**                                     | The server no longer has one. The browser's is about 12 B/s in steady state and about 182 B/s during a sudden drop, set by rate-sized fragments capped at 8 KiB and a 45 s watchdog over whole frames. Both are physically unavoidable and stated (§7.2)                                                                                                                                                  |
| G3c | Use application chunks with SQLite snapshot isolation instead of binary reassembly                                                 | **Considered, not adopted (reason corrected in revision 3)** | Chunks could be materialized first, so they need no long transaction. They are not adopted because byte fragments serve every message type (including one huge live event) without per-type chunkers or re-encoding, and they double as the pacing unit (§7.2)                                                                                                                                            |
| G3d | Watchdog during assembly and processing                                                                                            | **Accepted**                                                 | The browser watchdog resets per frame. Beats come from timers, so processing only delays them (the server tolerates 30 s) (§7.2)                                                                                                                                                                                                                                                                          |
| G4  | A transient ahead of the cursor must trigger recovery                                                                              | **Accepted**                                                 | Apply only at `after == cursor`; behind → drop; ahead or another epoch → recover (§5.2). The test "final durable record lost, then only a transient" is S13. Also: send failures close the connection                                                                                                                                                                                                     |
| G5  | The size estimator misses interaction bodies and its constants have no error bound                                                 | **Accepted**                                                 | Exact replay bytes. The snapshot is serialized when replay exceeds an exact lower bound (§6.1)                                                                                                                                                                                                                                                                                                            |
| G6  | The legacy epoch migration is an unnecessary exception                                                                             | **Accepted**                                                 | Boot repair with close-only transitions (§4.2). I1 has no migration exception                                                                                                                                                                                                                                                                                                                             |
| G7a | S8: resume does not call `persistRuntimeSession`                                                                                   | **Accepted**                                                 | Verified: `restoreSession` (`:712`) does not stamp; the stamp is in `session.create` (`:1833`) and child registration (`:1348`). S8 now uses a delayed `newSession`                                                                                                                                                                                                                                       |
| G7b | S7: 300 KB at 20 KB/s need not fail                                                                                                | **Accepted**                                                 | Verified against `heartbeat.ts:12-16`. Now about 600 KB at 10 KB/s                                                                                                                                                                                                                                                                                                                                        |
| G7c | S9: a multi-page walk does not prevent reconciliation; retained deletions cascade                                                  | **Accepted**                                                 | Verified at `websocket.ts:977-993` and `state.ts:353-391`, `:912-931`. S9 now states the gap, size and concurrency conditions, and becomes a regression guard if it cannot be made to fail                                                                                                                                                                                                                |
| G8  | Desktop depends on contracts, not just reducers                                                                                    | **Accepted**                                                 | Verified at `convex-environment-client.ts:192`, `:941` and `types.ts:443-449`. The legacy contract is isolated in desktop; typecheck is a gate (§3.5)                                                                                                                                                                                                                                                     |

### Fable (verdict: approve with changes)

| #   | Finding                                                                                     | Response                     | Note                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Progress acks are right _because_ `slow_consumer` is gone                                   | **Changed (revision 3)**     | The concern (unbounded buffering behind a live-looking peer) is kept, and answered by flow control, not by liveness. Acks now drive the send window only (§7.2) |
| F2  | Overlay lifetime: entries must outlive a successful answer (`interaction.respond` flickers) | **Accepted**                 | Until failure, or until server state no longer shows the item pending; `conflict` is not a failure (§3.2)                                                       |
| F3  | Recovery failure must not crash-loop                                                        | **Accepted**                 | One transaction per turn; log, leave, retry next boot, continue. Added the consequences for `turn.send`/`turn.interrupt` on such a thread (§4.1)                |
| F4  | The transitional state between F3 and F5b (the legacy settle)                               | **Moot**                     | The repair ships in F3 (§4.2)                                                                                                                                   |
| F5  | Large tool output by reference (artifacts)                                                  | **Recorded as an F6 option** | Decided after measurement, together with head-of-line lanes; output growing while it streams vs immutable artifacts is the open problem (§10.1)                 |
| F6  | S7, S9 and S10 preconditions                                                                | **Accepted**                 | S10 needs more than 100 messages, all pages walked, and older activity (§8.4)                                                                                   |
| F7  | S8 stamp at `:1833` after `session.open`                                                    | **Changed**                  | `:1833` is in `session.create`, not `session.open`; resume does not stamp (`:712`). Scenario rebuilt on create (plus child registration, `:1348`)               |
| F8  | Desktop contracts                                                                           | **Accepted**                 | See G8                                                                                                                                                          |
| F9  | Derived `session.updated` once per scope per transaction                                    | **Accepted**                 | Verified the per-event derivation at `event-repository.ts:183-222`; now per session per transaction (§4.3)                                                      |
| F10 | Workspace recency as a server-derived `workspace.updated`                                   | **Accepted**                 | Same transaction, built from rows (requires `git_json`); the client selector is dropped (§4.4)                                                                  |
| F11 | "Response-before-event holds for all events" overstated                                     | **Accepted**                 | Async replies are sent after their promise (`websocket.ts:374-376`); it no longer matters under I10 (§3.5, §5.1)                                                |
| F12 | Write-failure policy                                                                        | **Accepted**                 | Rows are the truth; memory follows commits (D14, I11, §4.4)                                                                                                     |
| F13 | Reference slips                                                                             | **Accepted**                 | `migrations.ts:452` → `:84-85` (`:452` is attachments); `websocket.ts:618-631` → `:618-624`                                                                     |
| F14 | The harness must disable title generation                                                   | **Accepted**                 | `generateTitles: false` (`config.ts:46-48`)                                                                                                                     |

### gpt-6.1 confirmation pass (revision 3)

| #   | Finding                                                                                                                      | Response     | Note                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Acks still impose a throughput floor (300 B/s → 4 KiB fragments 13.7 s apart → closed at 25 s)                               | **Accepted** | Verified against revision 2's §7.2. Liveness now uses upstream beats with no server throughput floor; fragments are rate-sized; S14 tests 300 B/s                          |
| C2  | Progress acks do not bound buffering; extending deadlines on any frame contradicts the case against beats                    | **Accepted** | Added a send window, a backlog bound and lagging scopes with catch-up answers. The pong deadline and its extension are removed; S15 measures memory                        |
| C3  | Semantic chunks do not necessarily need a download-long transaction                                                          | **Accepted** | The rejection reason is restated (G3c, §7.2)                                                                                                                               |
| C4  | An in-flight 64 KiB fragment can trip the 45 s watchdog when the rate suddenly drops to 1 KiB/s; adaptation cannot resize it | **Accepted** | Absolute fragment cap of 8 KiB (about 0.06% overhead). Two floors stated: about 12 B/s steady, about 182 B/s for in-flight frames after a sudden drop. S16 tests it (§7.2) |
