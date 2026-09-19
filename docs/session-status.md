# Server-owned session status

`SessionStatusSchema` defines `idle | running | waiting | error`. The environment
owns this value in SQLite `sessions.status`; session lists and open responses
include it in `SessionSummary`. A newly created session starts `idle`.

| Trigger                                         | Status    |
| ----------------------------------------------- | --------- |
| Accepted prompt, before provider execution      | `running` |
| Permission, question, or plan review request    | `waiting` |
| Last pending interaction resolved or expired    | `running` |
| Completed or interrupted turn                   | `idle`    |
| Failed turn or unexpected provider process exit | `error`   |
| New prompt after an error                       | `running` |

Resolving or expiring one of several pending interactions leaves the session `waiting`.
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

## Pending interaction lifecycle

The server owns permission, question and plan requests in the SQLite `interactions`
table. `interaction.requested` creates the pending row and moves its turn and
session to waiting in the same transaction. Requests carry optional `lifecycle`
metadata (state, creation time, settlement time and resolver client ID); new
servers always populate it. History and replay snapshots reconstruct metadata
from the row, including for requests created before this metadata was exposed.
Reloading a client preserves pending requests without relying on dialog state.

`interaction.resolved` records the response, settlement time and the authenticated
client that answered. A client-supplied resolver is ignored. Provider cancellations
have no client resolver. Broker deadlines emit `interaction.expired` with a
cancelled/timeout response and persist the distinct expired state. Both events
remove the pending request on subscribed clients. Plan history retains the final
state and metadata. Expiring or resolving the last request resumes running;
other open requests keep the turn and session waiting.

Turn finalization and server startup recovery cancel abandoned requests; a client
refresh is not a server restart and does not cancel the live provider continuation.
No schema migration is needed: the existing interaction table already includes
creation time, settlement time, state and the resolver foreign key. Deploy the
server and clients together so clients understand the new expiry event.
