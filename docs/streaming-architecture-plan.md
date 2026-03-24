# Streaming Architecture Overhaul — Consolidated Plan

> Final consolidated plan from all discussions. Covers schema, queries, SSE bridge, driven pattern, and addressed Q&A.

---

## Problem Summary

Current architecture sends **all messages with full content** to all clients on **every 150ms flush** — ~200 MB per stream, ~3 GB/day. Root causes:

1. `listBySession` returns all messages × all fields (`.collect()`) on every re-fire
2. SSE bridge double-fires: `message.updated` direct call + 150ms timer flush
3. `streaming.ts` wraps every mutation in an action (2× function calls for zero benefit)
4. Single React Context re-renders sidebar/input on every message change

---

## Findings Status

This plan is the **streaming-core fix**, not the full closure of every issue in the earlier analysis docs.

### Closed by this plan

- Full-session reactive message reads during streaming
  - SSE bridge double-firing
- Action-wrapper overhead in `convex/streaming.ts`
- 150ms time-based flush churn
- Wrong per-workspace `driven` model

### Partially addressed by this plan

- Single React Context re-render pressure
  - Streaming message churn is removed from the hot path, but the broader store/context split is still Phase 2 work.
- Session status write churn
  - Action overhead is removed, but status-event coalescing/debouncing is still separate work.

### Still open after this plan

- Duplicate `sessions.listByWorkspace` subscriptions in the sidebar (tracked in `docs/frontend-renderer-phase2-plan.md`)
- `jobs.listPending` global subscription scope/cleanup
- Completed/failed job retention

---

## New Architecture

### Data Flow

```
SSE token → sse-bridge
    ├── IPC to renderer (every token)        → desktop local state (smooth, token-by-token)
    ├── stream_cursors MUTATION (sentence     → remote clients (sentence-level updates)
    │   boundary only)
    └── messages.finalize MUTATION            → permanent storage (on isFinal only)
        (on isFinal only)
```

`stream_cursors` writes happen whether or not a remote client is currently watching. That's intentional. The extra ~10 sentence-boundary mutations per stream are negligible compared to the complexity of tracking active viewers.

### Key Principles

- **No time-based flushing.** No 150ms interval, no safety nets. Flush only on sentence boundaries + `isFinal`.
- **No cleanup watchdog** for orphaned cursors. Deferred — too many edge cases (slow networks, long tool executions).
- **`driven` is session-owned, not per-workspace.** A session belongs to one stable local `clientId`, and `driven = (session.clientId === currentClientId)`.
- **`bodyUpToHere` stays in the cursor row, but not in the reactive payload.** The reactive cursor query returns only delta fields (`chunkIndex`, `chunkText`). Late joiners use a one-off snapshot query to fetch `bodyUpToHere` / `partsUpToHere` once.

---

## `driven` Pattern — Corrected

> [!IMPORTANT]
> The existing `driven-behavior-design.md` incorrectly uses `sidecarStatus === 'connected'`. That's per-workspace, not per-session. The corrected pattern uses **session ownership** via a stable local `clientId` persisted in Electron `userData`.

```tsx
const isDriven = session.clientId === currentClientId;

const displayMessages = messages.map((dbMsg) => {
  const localMsg = streamingMessages.get(dbMsg.externalId);
  if (isDriven && localMsg && !dbMsg.isFinal) {
    return { ...dbMsg, content: localMsg.content, parts: localMsg.parts };
  }
  return dbMsg;
});
```

**Why this works for all scenarios:**

- Laptop A streams Session 1 → `session.clientId === currentClientId` → driven via IPC
- Laptop A views Session 2 (owned by Laptop B) → `session.clientId !== currentClientId` → reads from Convex
- Mobile → never receives IPC → always reads from Convex
- Same account on two laptops → both can view the session, but only the owner laptop executes jobs / finalizes the stream

Sessions are tied to their origin client. A remote client can still send messages into that session, but execution is routed back to the owner client via targeted pending jobs. Other clients observe through Convex only; they do not become "driven" for that session.

---

## Schema Changes

### [MODIFY] `convex/schema.ts`

Add session/job ownership fields:

- `sessions.clientId` — stable owner client for the session
- `pending_jobs.targetClientId` — explicit routing so only the owning desktop executes jobs

Stable `clientId` should be generated once on first app launch and persisted locally in Electron `userData`. Do **not** use the current random per-process worker ID for this purpose.

Add `stream_cursors` table:

```typescript
stream_cursors: defineTable({
  messageId: v.id('messages'),
  messageExternalId: v.string(),
  sessionExternalId: v.string(),
  chunkIndex: v.number(),
  chunkText: v.string(),
  bodyUpToHere: v.string(),
  partsUpToHere: v.optional(v.any()),
  updatedAt: v.number(),
})
  .index('by_messageExternalId', ['messageExternalId'])
  .index('by_sessionExternalId', ['sessionExternalId']),
```


| Field               | Purpose                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `messageExternalId` | Subscription scoping — one query per streaming message                |
| `chunkIndex`        | Monotonically increasing — client detects gaps from coalesced updates |
| `chunkText`         | Delta text for this sentence — normal-case small payload              |
| `bodyUpToHere`      | Full accumulated text — fallback for gaps + late joiners              |
| `partsUpToHere`     | Full accumulated parts array — fallback for structured data           |


**Lifecycle:** One row per actively streaming message. **PATCHED** at each sentence boundary (not inserted). **DELETED** when `isFinal`.

**Important:** the row may store both delta fields and snapshot fields, but the reactive query should only project the delta fields. Convex pushes query results, not raw documents, so late-join snapshot recovery can be handled by a separate one-off query.

---

## Convex Function Changes

### [MODIFY] `convex/messages.ts`

ListMetadata is a good name, but we have to consider possibly renaming other functions such as getContent and upsertContent.

**Replace `listBySession` with `listMetadata`** — metadata only, no content:

```typescript
export const listMetadata = query({
  args: { sessionExternalId: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db.query('sessions')
      .withIndex('by_externalId', q => q.eq('externalId', args.sessionExternalId))
      .first()
    if (!session) return []
    const msgs = await ctx.db.query('messages')
      .withIndex('by_session_seq', q => q.eq('sessionId', session._id))
      .collect()
    return msgs.map(m => ({
      _id: m._id, externalId: m.externalId, role: m.role,
      sequenceNum: m.sequenceNum, isFinal: m.isFinal,
    }))
  },
})
```

**New `getContent`** — one message's full content:

```typescript
export const getContent = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const msg = await ctx.db.query('messages')
      .withIndex('by_externalId', q => q.eq('externalId', args.externalId))
      .first()
    if (!msg) return null
    return { content: msg.content, metadata: msg.metadata }
  },
})
```

**Replace `upsertContent` with two mutations:**

- `insertPlaceholder` — called once when message first appears. Creates row with `isFinal: false`, empty content.
- `finalize` — called once when stream completes. Writes full `content` + `metadata`, sets `isFinal: true`.

When session metadata updates, only metadata is returned, not content. Content queries remain independent and don't re-run unless that specific message row changes. This avoids re-fetching entire message histories on every session table change.

### [MODIFY] `convex/sessions.ts`

- Persist `clientId` on session create/upsert
- Return `clientId` in session list/get queries so the renderer can derive `driven`

### [NEW] `convex/streamCursors.ts`

```typescript
// Mutation: create/patch cursor on sentence boundary
export const upsert = mutation({ ... })

// Query: remote clients subscribe per-message (delta-only projection)
export const get = query({
  args: { messageExternalId: v.string() },
  handler: async (ctx, args) => {
    const cursor = await ctx.db.query('stream_cursors')
      .withIndex('by_messageExternalId', q =>
        q.eq('messageExternalId', args.messageExternalId))
      .first()
    if (!cursor) return null
    return {
      chunkIndex: cursor.chunkIndex,
      chunkText: cursor.chunkText,
    }
  },
})

// Query: one-off fallback for late joiners / gap recovery
export const getSnapshot = query({ ... })

// Mutation: delete cursor when streaming completes
export const remove = mutation({ ... })
```

`getSnapshot` should be called as a one-off `convex.query(...)`, not a persistent `useQuery(...)` subscription.

### [MODIFY] `convex/jobs.ts`

- Add `targetClientId` to each pending job
- `submitMessage` resolves the session owner and stamps `targetClientId`
- `listPending` becomes client-scoped instead of global
- Worker on each desktop subscribes only to jobs targeted to its own local `clientId`

This is what makes multi-device behavior coherent: remote/mobile clients may submit work into an existing session, but execution still occurs only on the desktop that owns that session.

### [DELETE] `convex/streaming.ts`

All 4 action wrappers eliminated. `sessions.upsertStatus` and `sessions.remove` become public mutations. SSE bridge calls mutations directly.  
(gotta verify this with convex-best-practices once, I don't think there is anything concerning here. Honestly, verification can be done later on after implementation too. )

---

## SSE Bridge Refactor

### [MODIFY] `src/main/sse-bridge.ts`

1. **Remove double-firing** — delete direct `flushMessageBatch` in `message.updated` handler ( clarity on what message.updated is needed.)
2. **Replace actions with mutations** — `this.convex.action()` → `this.convex.mutation()`
3. **Sentence-boundary flushing only** — no interval timer, flush on delimiter (`[.!?\n]` + whitespace) or `isFinal`
4. **IPC token forwarding** — `mainWindow.webContents.send('stream:token', { delta })` on every token for driven:true clients.
5. **Write to `stream_cursors`** during streaming, `messages.finalize` + `streamCursors.remove` on completion
6. **Constructor** needs `mainWindow` (BrowserWindow) reference for IPC
7. **Session ownership** — stamp/propagate stable local `clientId` when sessions are created/upserted

---

## Renderer Changes (Phase 1 minimal)

### [MODIFY] `src/renderer/src/stores/session-store.tsx`

Swap `listBySession` → `listMetadata`. Full context refactor is Phase 2; see `docs/frontend-renderer-phase2-plan.md`.

Renderer derives `driven` from `session.clientId === currentClientId`, not from sidecar connectivity.

### [MODIFY] `docs/driven-behavior-design.md`

Update to the session-ownership model. Do **not** use `sidecarStatus === 'connected'` as the `driven` signal. The signal is `session.clientId === currentClientId`.

Remote/mobile clients remain non-driven observers, but they may still enqueue messages into an existing owned session; execution is routed via `pending_jobs.targetClientId`.

---

## Step-by-Step Workflows

### Desktop Client (driven — reads from IPC)


| Step | What happens                                         | Convex?                                               |
| ---- | ---------------------------------------------------- | ----------------------------------------------------- |
| 1    | User sends message                                   | `submitMessage` mutation                              |
| 2    | Sidecar sends to OpenCode                            | —                                                     |
| 3    | OpenCode echoes user message via SSE                 | `messages.upsertFinalized` (user msg, `isFinal: true`) |
| 4    | `listMetadata` fires                                 | Returns updated metadata array (~2.5 KB)              |
| 5    | OpenCode streams assistant response                  | `insertPlaceholder` (assistant msg, `isFinal: false`) |
| 6    | `listMetadata` fires again                           | Now includes assistant placeholder                    |
| 7    | Tokens keep arriving → forwarded via IPC driven=true | **No Convex writes.** Renderer appends to local state |
| 8    | Sentence boundary → `streamCursors.upsert`           | Patches cursor row (for remote clients)               |
| 9    | Repeat 7-8                                           | IPC per token, Convex per sentence                    |
| 10   | `isFinal`                                            | `messages.finalize` + `streamCursors.remove`          |
| 11   | `listMetadata` fires (`isFinal` changed)             | Client drops local state, falls back to DB            |
| 12   | `getContent` fetches final body                      | One-time fetch for the finalized row                  |


### Remote Client (not driven — reads from Convex)


| Step | What happens                            | Convex?                                                      |
| ---- | --------------------------------------- | ------------------------------------------------------------ |
| 1-6  | Same as desktop                         | Same — `listMetadata` fires twice                            |
| 7    | No IPC tokens → `driven=false`          | —                                                            |
| 8    | Subscribe to `streamCursors.get`        | Returns delta only: `{ chunkIndex, chunkText }`              |
| 9    | Late join / gap detected                | One-off `streamCursors.getSnapshot` fetch for bootstrap      |
| 10   | Each sentence boundary → cursor patched | Client appends `chunkText` locally                           |
| 11   | `isFinal` via `listMetadata`            | Drop cursor subscription                                     |
| 12   | `getContent` fetches final body         | One-time fetch for the finalized row                         |


---

## Q&A — Addressed Doubts

### Does `listMetadata` re-fetch ALL messages when a new one is inserted?

**Yes**, Convex re-runs the query and returns the full metadata array. But the payload is ~25 bytes per message (metadata only). 100 messages = ~2.5 KB. And it only fires a few times during streaming lifecycle (user insert, assistant placeholder insert, `isFinal` flip). During the actual assistant stream, the `messages` table is NOT touched — only `stream_cursors` is patched. So `listMetadata` stays silent on the hot path.

### 4 concurrent sessions = 4 cursor rows — is that a problem?

**No.** Each remote client subscribes with `streamCursors.get({ messageExternalId: "msg-X" })`. That query sees exactly ONE row. The other 3 are invisible. Changes to other cursors don't trigger re-fires. When all streams complete, all rows are deleted.

### What happens when a mobile client joins mid-stream (chunkIndex already at 9)?

Client subscribes to `streamCursors.get`, gets the cursor with `chunkIndex: 9`. Its `lastSeenIndex` is `undefined` (first time). Gap detected → does a one-off `streamCursors.getSnapshot` fetch for `bodyUpToHere` / `partsUpToHere`, then sets `lastSeenIndex = 9`. From chunk 10 onward, it appends `chunkText` normally.

### Are old messages ever re-fetched?

**No.** `getContent` subscriptions for finalized messages stay subscribed but are silent — the rows never change after finalization. Zero bandwidth. Only the actively streaming message generates cursor pushes.

### What about close/reopen of a session?

Full rehydration from Convex: `listMetadata` returns all metadata, `getContent` runs for finalized messages as needed. One-time cost. After that, silent again. The new data shape makes reopen cheap enough for Phase 1; any extra warm-cache/LRU strategy is optional Phase 2 work.

### How does the body accumulate if we keep PATCHing one cursor row?

The **SSE bridge's in-memory buffer** holds the real accumulated body. `stream_cursors` is the remote-notification channel. The row stores both the latest delta and a fallback snapshot, but remote subscriptions only receive the delta projection. On finalize, the owner client's bridge writes `buf.content` to the message row via `messages.finalize`.

Finalization is naturally owner-gated: only the client running the SSE bridge for that session receives the stream completion event and calls `messages.finalize`. Remote clients never finalize; they only observe `isFinal` and switch data sources.

### `bodyUpToHere` is in every cursor push — isn't that the same growing-body problem?

Not on the reactive path. The cursor row still stores `bodyUpToHere`, but `streamCursors.get` projects only `{ chunkIndex, chunkText }`, so Convex pushes only the delta query result to subscribed clients. `bodyUpToHere` / `partsUpToHere` are fetched only through the one-off snapshot query when a late joiner or gap recovery actually needs them.

### Why no time-based safety net?

It reintroduces the same problem. If the safety net fires every 2 seconds, it flushes even when no sentence boundary was reached. This means unnecessary writes + unnecessary subscription fires. If the stream dies mid-sentence without `isFinal`, the partial text sits in the bridge buffer. Recovery should hook to authoritative lifecycle events such as `session.status` / `session.error`, not a timer. That cleanup path is valid, but can be implemented after the core streaming refactor lands.

---

## Bandwidth Comparison


| Metric                             | Current                       | New                                           |
| ---------------------------------- | ----------------------------- | --------------------------------------------- |
| `listMetadata` payload per re-fire | ~500 KB (full content)        | ~2.5 KB (metadata only)                       |
| Times it fires during streaming    | ~400 (every 150ms)            | **2** (insert + isFinal)                      |
| Streaming message push per update  | ~500 KB (all messages)        | ~~50 bytes delta-only reactive payload        |
| Streaming push frequency           | Every 150ms                   | Every sentence boundary (~10/stream)          |
| Total bandwidth per stream         | **~200 MB**                   | **~50 KB worst-case, usually lower**          |
| Function calls per stream          | ~200 actions + ~200 mutations | ~10 mutations                                 |




From my observance, critical findings 1, 2, 3, and 4 are all addressed in this document. Critical findings 5 and 6 are yet to be addressed, but can be covered later.

