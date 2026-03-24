# Architecture TODO — Convex & Streaming Overhaul

Tracked changes from analysis sessions. Each item is a discrete, implementable change.

---

## 🔴 Critical (do first — biggest bandwidth/cost impact)

- [ ] **Remove action wrappers** — Eliminate `streaming.ts` entirely. Replace all `this.convex.action(api.streaming.*)` calls in `sse-bridge.ts` with direct mutation calls. Halves function call count immediately.

- [ ] **Fix SSE bridge double-firing** — Remove the direct `flushMessageBatch` call from the `message.updated` handler (line 204 of `sse-bridge.ts`). Let the buffer + timer be the sole write path.

- [ ] **Increase flush interval** — Change `BATCH_FLUSH_MS` from 150ms to 500ms–1000ms. Better: switch to content-aware flushing (sentence boundaries, new parts, tool call events, `isFinal`) instead of dumb time-based interval.

- [ ] **Implement driven pattern for desktop** — Forward SSE tokens directly to the renderer via IPC. Desktop reads from local state during streaming, falls back to `useQuery` after `isFinal`. Zero Convex reads during streaming on desktop.

---

## 🟠 Important (significant improvement)

- [ ] **Split SessionProvider context** — Break the single "god context" into separate contexts (or use a state manager like Zustand) so that message changes don't re-render `WorkspaceSidebar` and `MessageInput`. Only `ChatView` and `PermissionPrompt` should re-render on message changes.

- [ ] **Remove duplicate session subscriptions** — `WorkspaceGroup` in `WorkspaceSidebar.tsx` has its own `useQuery(sessions.listByWorkspace)` that duplicates the one in `SessionProvider`. Remove it; pass data down from context instead.

- [ ] **Slim down `listBySession` response** — Return only `{ externalId, role, sequenceNum, isFinal }` for the list. Add a separate `getMessageContent(externalId)` query for full content. Or paginate with `.paginate()`.

- [ ] **Skip no-op flushes** — Before calling `upsertContent`, compare content length/hash. If nothing changed since last flush (e.g., during tool execution pauses), skip the write entirely.

---

## 🟡 Improvements (nice to have, lower priority)

- [ ] **Scope and clean up jobs** — Add workspace filtering to `jobs.listPending` query. Delete completed/failed jobs after processing so the table doesn't grow forever.

- [ ] **Debounce session status updates** — Coalesce rapid `session.status` events (idle→running→waiting happens in milliseconds). Only write the latest status after a 500ms debounce.

- [ ] **Drop redundant `content` field** — The `content` field on messages is just concatenated text parts. It's stored twice (once in `content`, once inside `metadata.parts`). Derive it at query time or in the renderer instead.

- [ ] **Type the metadata field** — Replace `metadata: v.any()` with a proper typed validator for the parts array. Better validation, better debugging.

- [ ] **Fix `sequenceNum` stability** — Assign `sequenceNum` only on first insert, not on every update. The in-memory counter in `sse-bridge.ts` resets on restart.

- [ ] **Consider local persistence for desktop** — Cache session history locally (SQLite, JSON, etc.) so reopening a session doesn't re-fetch everything from Convex. Reduces read bandwidth for session browsing.

---

## 📊 Expected Impact Summary

| Change | Bandwidth savings | Function call savings |
|---|---|---|
| Remove action wrappers | — | ~50% actions eliminated |
| Fix double-firing | ~30-50% reads | ~50% mutations |
| Increase flush interval | ~60-70% reads | ~60-70% mutations |
| Driven pattern (desktop) | ~90%+ reads during streaming | — |
| Split context | — (UI perf only) | — |
| Remove duplicate subscriptions | ~5-10% reads | ~2-3× fewer session queries |
| Slim `listBySession` | ~60-80% per re-read | — |

**Combined target: from ~3 GB/month to ~50-100 MB/month for moderate desktop use.**
