# Chat history and reconnect replay

On the WebSocket path, `session.open` resolves the session and thread identities. Each thread then requests `subscription.replay` with a null cursor. The server reads the newest persisted page and its event cursor and registers live delivery in the same synchronous handler. The snapshot is applied before events beyond that cursor; there is no history-read-to-subscribe window.

A thread snapshot carries `nextCursor`, the exclusive message-ordinal boundary for older pages. The chat offers **Load older messages** until that cursor is null. Older pages prepend unseen message IDs and cannot overwrite live message bodies, turn status, or pending interactions. Loading is serialized per thread, and page responses from a previous selection or connection are discarded. The viewport keeps its position when rows are prepended.

After reconnect, existing subscriptions recover directly from their last applied cursor. A successful replay does not reload `session.history` over the live state. Records arriving while recovery is pending are buffered, then applied after the replay/snapshot; scope and epoch cursors discard duplicates. Even an empty replay advances to the returned cursor. When replay fails, the transcript shows a retry action instead of subscribing past the missing events.

A snapshot fallback retains loaded older messages only when they overlap the newest page, proving continuity. Otherwise it starts a fresh page and pagination boundary rather than displaying disconnected ranges as a continuous transcript. Reopening a cached thread preserves the pagination boundary of any retained prefix, including an exhausted cursor.

The browser projects this single environment-client state into the shared chat stores. It does not listen to `stream:token` or `acp:event`, query Convex, or decide between local IPC and remote history based on ownership. `activeThreadDriven` is hardcoded true on this path so ChatView reads that one projection; there is no remote `stream_chunks` store. Desktop drops the IPC overlay at thin-shell cutover rather than reintroducing `driven` (see [driven-behavior-design.md](./driven-behavior-design.md)).

Compatibility: servers without replay retain the legacy history/subscribe path. The atomic recovery guarantee requires `subscription.replay`. The optional snapshot `nextCursor` field permits older clients to consume new servers; pagination from snapshots requires an updated server. The snapshot keeps the existing persisted text/interaction contract; richer reasoning/tool persistence is outside this change.
