# OpenCode Session Titles – Research Report

**Purpose:** Understand how OpenCode sets session titles and when they become available, so the OpenManager client can display proper titles instead of only slugs/IDs.

**Sources:** OpenCode (anomalyco/opencode) GitHub, SDK types, OpenAPI schema, GitHub issues.

---

## 1. Session Model

**Where defined:** OpenCode SDK `packages/sdk/js/src/gen/types.gen.ts` (from OpenAPI)

**Fields (from OpenAPI schema):**

| Field      | Type   | Required | Notes                                              |
|------------|--------|----------|----------------------------------------------------|
| `id`       | string | ✓        | Session ID (e.g. `ses_xxx`)                        |
| `slug`     | string | ✓        | Short identifier (OpenAPI schema)                  |
| `projectID`| string | ✓        | Project reference                                  |
| `directory`| string | ✓        | Workspace directory                                |
| `title`    | string | ✓        | Display title                                      |
| `version`  | string | ✓        | Schema version                                     |
| `time`     | object | ✓        | `{ created, updated, compacting? }`                |
| `parentID` | string | ○        | Parent session (for forks)                         |
| `summary`  | object | ○        | `{ additions, deletions, files, diffs? }` – diff stats |
| `share`    | object | ○        | `{ url }` when shared                              |
| `revert`   | object | ○        | Revert state                                       |

**Note:** The SDK TypeScript types (`Session`) do not include `slug`; the OpenAPI schema does. Your SSE bridge uses `info.slug ?? info.title`, which covers both.

---

## 2. When Is Title Set?

**Title is not set at creation time in a meaningful way.** It is filled later by AI.

| Phase                    | Title value                                           |
|--------------------------|--------------------------------------------------------|
| Session creation         | User-provided (if given), else default `"New session - [timestamp]"` |
| After first AI response  | AI-generated from the first user message and assistant reply |

**How it works:**

1. **Creation:**  
   - `POST /session` accepts optional `{ title }`.  
   - If omitted, OpenCode uses `"New session - [timestamp]"`.

2. **Auto-generation:**  
   - Implemented in `packages/opencode/src/session/llm.ts` and related summary logic.  
   - Uses `small_model` (e.g. `gpt-5-nano` via Zen) for the “title” agent.  
   - Runs when the session becomes idle after the first assistant response.  
   - Depends on LLM; can fail silently (e.g. model provider, quota, etc.).

**Known issues:**  
- [#7262](https://github.com/anomalyco/opencode/issues/7262) – title stuck on “New session - timestamp” (fixed for Google models).  
- [#6819](https://github.com/anomalyco/opencode/issues/6819) – model-dependent; some models do not set title.  
- [#6819 comment](https://github.com/anomalyco/opencode/issues/6819) – Zen `small_model` / GPT-5-nano used for titles; insufficient quota blocks title generation.

---

## 3. `session.updated` Event

**When emitted:** After session data changes, including when the AI-generated title is saved.

**Typical sequence:**

1. `session.created` → initial session, title = default or user-provided.
2. User sends first message.
3. Assistant responds.
4. Session becomes idle.
5. Title agent runs (if configured and successful).
6. `session.updated` → session with new AI-generated title.

**Triggers:** Any update to session metadata: title, status, share, etc.

**Delays:** Title can lag by several seconds (or more) after the first response, and may never appear if title generation fails.

---

## 4. `session.created` Payload

**Content:** Full `Session` object in `properties.info`:

```json
{
  "directory": "/path/to/project",
  "payload": {
    "type": "session.created",
    "properties": {
      "info": {
        "id": "ses_xxx",
        "slug": "...",
        "projectID": "...",
        "directory": "...",
        "title": "New session - 1737845123456",
        "version": "...",
        "time": { "created": 1737845123456, "updated": 1737845123456 }
      }
    }
  }
}
```

**Includes:** `slug` and `title`. `title` is always present (required); it may be the default `"New session - [timestamp]"` until AI updates it.

---

## 5. Message Summary and Session Title

**User messages** (`UserMessage`) can have a summary:

```ts
summary?: {
  title?: string
  body?: string
  diffs: Array<...>
}
```

- `summary.title` is an AI-generated title for the user message.
- It is used in `message.updated` events.
- Your SSE bridge uses `info.summary?.title` as a fallback for empty message content, not for session title.
- Session title is only set via `session.created` / `session.updated`.

**Flow:** The first user message gets summarized; that summary can influence or feed into the session title via OpenCode’s internal logic, but session title is carried only in session events.

---

## 6. API / SSE Payload Structure

**SSE endpoint:** `GET /global/event`

**Envelope:**

```ts
{
  directory: string
  payload: {
    type: "session.created" | "session.updated" | ...
    properties: {
      info: Session   // for session events
    }
  }
}
```

**Session fields used for display:**

- `info.id` – session ID (used as `externalId`)
- `info.slug` – short identifier (OpenAPI)
- `info.title` – display title

**Current OpenManager handling (sse-bridge.ts:144):**

```ts
title: info.slug ?? info.title
```

Prefer `title` when present; fall back to `slug` only if `title` is null/undefined.

---

## 7. Fallback if OpenCode Does Not Send a Good Title

| Option | Approach | Pros / cons |
|--------|----------|-------------|
| **A. First user message (truncated)** | Take first user message text, truncate (e.g. 50 chars) | Simple; works without extra API calls. May be noisy or empty. |
| **B. Poll `GET /session/{id}`** | After creation or on focus, fetch full session | Always fresh, uses OpenCode as source of truth. Adds latency and extra requests. |
| **C. Use `message.updated` + first user message** | When first user message completes, use `info.summary?.title` or raw text for display | Can give a reasonable title before `session.updated`. Needs to map message → session and handle edge cases. |
| **D. Pass-through existing title** | Keep using `info.slug ?? info.title` | Minimal change. If OpenCode never sends a better `title`, you stay with default or slug. |

**Recommended combination:**

1. Continue using `info.title ?? info.slug` from session events.
2. If a session has no useful title (empty, default, or slug-only):
   - Optionally use the first user message content (truncated) as a local display title.
   - Optionally call `GET /session/{id}` on session focus or after a short delay to pick up late-updated titles.

---

## Summary for Your Client

### (a) When / how OpenCode sets title

- On creation: user-provided or `"New session - [timestamp]"`.
- Later: AI-generated when the session is idle after the first assistant response.
- Title can be delayed or missing if the title agent fails or is not configured (model, quota, etc.).

### (b) Whether you miss an event or field

- You consume `session.created` and `session.updated`.
- You use `info.slug` and `info.title` correctly.
- `session.updated` may arrive late or not at all when title generation fails; you are not missing a different event for the title itself.

### (c) What to do if OpenCode never sends a good title

1. Keep `info.title ?? info.slug` as primary.
2. Add a fallback when title is empty or still the default:
   - First user message (truncated), or
   - Fetch `GET /session/{id}` on demand.
3. Optionally show something like `"Untitled"` instead of raw slug when no better title is available.

---

## References

- [OpenCode GitHub](https://github.com/anomalyco/opencode)
- [Issue #7262 – Session titles stuck](https://github.com/anomalyco/opencode/issues/7262)
- [Issue #6819 – Session titles not set](https://github.com/anomalyco/opencode/issues/6819)
- OpenCode SDK: `packages/sdk/js/src/gen/types.gen.ts`
- OpenCode OpenAPI: `packages/sdk/openapi.json`
