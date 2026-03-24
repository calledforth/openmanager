# Convex `listBySession` Bandwidth Problem — The Full Picture

## Your 2MB Database vs 4.5GB Reads: How That Happens

Convex's **1 GiB free tier** counts every byte **read from the database** — not stored. A reactive subscription doesn't "cache" on the server; every time it re-fires, it **re-reads all matching rows** and sends them over the wire.

Here's the multiplier chain:

```
2 MB stored  ×  re-reads per stream  ×  streams per month  =  total read bandwidth
```

### The math for one streaming exchange

| Variable | Current value | Notes |
|---|---|---|
| Messages in session | ~20 | Grows over time |
| Avg message size | ~5 KB | Content + metadata/parts |
| Session payload per read | ~100 KB | 20 × 5KB |
| Flushes per 60s stream | **~400** | 150ms timer + `message.updated` double-fire |
| **Reads per exchange** | **~40 MB** | 100KB × 400 re-fires |

Now scale:

| Monthly usage | Exchanges | Stream duration | Read bandwidth |
|---|---|---|---|
| Light (5 sessions/mo) | ~25 exchanges | ~30s avg | **~500 MB** |
| Moderate (15 sessions/mo) | ~75 exchanges | ~45s avg | **~2–3 GB** |
| Heavy (30+ sessions/mo) | ~150+ exchanges | ~60s avg | **~6+ GB** |

> [!CAUTION]
> With your current architecture, even **light usage** eats half the free tier. Moderate usage **blows through it entirely**. The ratio of stored data to read bandwidth is roughly **1:2000** — every MB stored can generate 2GB of reads.

---

## What "Ideal" Should Look Like

In a perfectly optimized system:

| Action | Data transferred |
|---|---|
| Open a session (load history) | 1× full read: ~100 KB |
| Stream a new response (60s) | Only the **delta** per flush: ~0.5–2 KB × ~6 flushes/min = ~12 KB |
| Switch sessions | 1× full read of new session: ~100 KB |
| Browse old sessions | 1× per session viewed: ~100 KB |

**Monthly ideal for moderate use:** ~75 exchanges × ~120 KB ≈ **~9 MB**. Orders of magnitude less.

The gap between **9 MB ideal** and **3 GB actual** is your optimization opportunity.

---

## The Three Independent Problems (and solutions)

### Problem 1: Double-firing writes (→ 2× more subscription invalidations)

`message.updated` events call `flushMessageBatch` directly **AND** the 150ms timer also flushes the same data. Same mutation fires twice → `listBySession` re-fires twice as often.

**Fix:** Remove the direct call from `message.updated`. Let the buffer + timer be the only write path.

### Problem 2: Action-wrapping (→ 2× function calls, more latency)

Every write goes: SSE → `action` → `internalMutation`. The action does nothing but forward. Each pair counts as 2 function calls.

**Fix:** Expose mutations directly (or use `internalMutation` called from a single action). Eliminate `streaming.ts`.

### Problem 3: `listBySession` returns everything on every re-fire

This is the **real killer**. Even if you fix problems 1 and 2, every mutation still invalidates the subscription, and every re-fire still returns **all messages × all fields**.

This is where architecture matters, and you have real choices to make.

---

## The Architecture Options for Solving Problem 3

### Option A: Desktop reads SSE directly, Convex is write-only

```
SSE Stream ──► Renderer (direct)     ← live streaming
           └─► Convex (write-only)   ← persistence for mobile/other clients
```

- Desktop `ChatView` reads tokens straight from the SSE stream, not from Convex
- Convex subscription only used for initial history load (on session open) and by mobile clients
- During streaming, **zero reactive reads** from Convex on the desktop
- When stream completes (`isFinal`), do a single read to sync final state

**Pros:** Almost zero Convex bandwidth during streaming. Simple to implement — you already have the SSE bridge.
**Cons:** Desktop and mobile have different read paths. If you close and reopen the app mid-stream, you miss tokens until the next full read.

### Option B: Delta-based writes + accumulated read

Instead of upsert-the-whole-content on every flush:

```
Flush 1: insert delta "Hello, "
Flush 2: insert delta "how are "  
Flush 3: insert delta "you?"
Final:   write assembled content to messages table
```

- Use a lightweight `streaming_deltas` table for in-progress tokens
- `listBySession` only reads from `messages` (finalized content) — it never re-fires during streaming
- A separate small query watches `streaming_deltas` for the **current** streaming message only
- On `isFinal`, assemble deltas into final message row, delete deltas

**Pros:** `listBySession` is never invalidated during streaming. Delta reads are tiny.
**Cons:** More complex. Two tables to manage. Need to handle assembly correctly.

### Option C: Increase flush interval + return only changed message

The pragmatic middle ground:

1. Increase `BATCH_FLUSH_MS` to **500ms–1s** (from 150ms)
2. Fix double-firing (problem 1)
3. Only flush on `isFinal` the final assembled content; during streaming, flush a **lightweight status** (just the streaming message's ID + content length or a hash)
4. Have `listBySession` return slim messages: `{ externalId, role, sequenceNum, isFinal }` — no content
5. Add a separate `getMessageContent` query that returns full content for **one** message by ID
6. `ChatView` calls `getMessageContent` only for the actively streaming message

**Pros:** Works for all clients (desktop + mobile). Keeps Convex as the single source of truth.
**Cons:** More queries (one per visible message for content), but each is tiny and targeted.

### Option D: Convex Persistent Text Streaming component

Convex has an official [Persistent Text Streaming](https://www.convex.dev/components/persistent-text-streaming) component that handles exactly this pattern — delta-based writes with configurable `throttleMs` and client-side reconstruction.

**Pros:** Battle-tested, handles edge cases.
**Cons:** May not fit your parts/metadata structure. Need to evaluate if it supports structured data (tool calls, reasoning blocks) or just plain text.

---

## What I'd Recommend Investigating

For **your specific case** (desktop app + future mobile, Convex as shared backend):

| Step | What | Impact |
|---|---|---|
| **1** | Fix double-firing + remove action wrappers | Immediate 50-75% reduction in writes and re-fires |
| **2** | Increase flush to 500ms | Another 3× reduction in mutations |
| **3** | Option A for desktop (direct SSE → ChatView) | Near-zero read bandwidth during streaming on desktop |
| **4** | Option B or C for mobile/multi-client | Efficient streaming for any Convex-connected client |

After steps 1-2 alone, your 400 re-fires/minute drops to ~60. After step 3, desktop streaming reads drop to **zero**. Step 4 brings mobile reads down to the same ideal range.

**Realistic bandwidth after all optimizations:**
- Desktop: ~50–100 MB/month (history loads only)
- Mobile: ~100–300 MB/month (depending on how you implement streaming reads)
- Combined: **comfortably within the 1 GiB free tier** for moderate use
