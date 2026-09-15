# Server-owned session status

`SessionStatusSchema` defines `idle | running | waiting | error`. The environment
owns this value in SQLite `sessions.status`; session lists and open responses
include it in `SessionSummary`. A newly created session starts `idle`.

| Trigger                                         | Status    |
| ----------------------------------------------- | --------- |
| Accepted prompt, before provider execution      | `running` |
| Permission, question, or plan review request    | `waiting` |
| Last pending interaction resolved               | `running` |
| Completed or interrupted turn                   | `idle`    |
| Failed turn or unexpected provider process exit | `error`   |
| New prompt after an error                       | `running` |

Resolving one of several pending interactions leaves the session `waiting`.
Finalizing a turn cancels its remaining pending interactions. An expected idle
process exit (reaping or shutdown) leaves status unchanged. Startup recovery
marks abandoned active turns interrupted and their sessions idle.

For turn and interaction transitions, the event repository compares the session
row before and after projection. On a change it appends an environment-scoped
`session.updated` event with `{ sessionId, status }` in the **same transaction**
as the triggering event, session row, and stream cursors. Publication happens
only after commit. Retrying an event returns its retained status event cursor;
token deltas do not create status events or extra status queries. Idle process
crashes use a direct server-owned `session.updated` event.

Every connected sidebar subscribes to the environment stream, so status updates
do not require opening sessions or downloading their transcripts. Clients take
status from summaries and these events; thread events, optimistic commands,
history pages, and thread snapshots never infer or overwrite it. The mock server
emits the same explicit status updates for tests and stories.

The shared sidebar shows idle as ready (green), running as working (animated,
respecting reduced motion), waiting as needing attention (gold), and error as
failed (red). Opening a server-backed session does not acknowledge or change
its lifecycle status. Legacy desktop `busy` and `done` values remain supported
by the glyph component while that host migrates to the environment client.
The environment adapter maps server `idle` to the display-only `ready` alias;
legacy desktop `idle` still clears the unread-completion glyph.
The temporary IPC/Convex adapter retains its local turn projection at that
adapter boundary until the desktop switches to an environment server.

Deploy the updated environment server with the updated client: older servers
provide summary status but do not broadcast changes to sidebar-only subscribers.
