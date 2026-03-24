# Frontend Renderer Phase 2 — Implementation Map

> Follow-on plan for renderer/store cleanup after the streaming-core Convex changes land.

---

## Purpose

Phase 1 fixes the Convex bandwidth problem in the streaming path.

Phase 2 fixes the renderer-side waste that remains even after streaming writes are reduced:
- duplicate subscriptions
- one shared "god context"
- message churn re-rendering unrelated UI
- permission prompt derived by scanning transcript messages

This plan is intentionally aligned with the architecture direction used by the official OpenCode app: scoped providers, normalized data ownership, and dedicated permission state.

---

## Design Principles

1. Keep Convex as the source of truth for persisted backend data.
2. Keep local UI state separate from Convex query results.
3. Colocate reactive queries with the subtree that renders them.
4. Avoid one app-wide object that mixes workspaces, sessions, messages, and operations.
5. Treat permissions as operational state, not transcript state.
6. Add lightweight diagnostics so reactive fanout is visible during development.

---

## What We Keep

Keep one thin app-level store for low-frequency local state and commands:
- `activeWorkspacePath`
- `activeSessionId`
- `sidecarStatuses`
- `selectSession`
- `createSession`
- `deleteSession`
- `sendMessage`
- `abortSession`
- `resolvePermission`

This can remain React Context or move to Zustand. If moved, Zustand should still stay UI-focused and must not become a dumping ground for all Convex query results.

---

## What We Remove From `session-store`

`session-store` should no longer own these query results:
- `workspaces.list`
- `sessions.listByWorkspace`
- `messages.listBySession`
- any future `listMetadata` or `getContent` result

Reason: once query results sit in one shared provider value, any update to one domain can fan out across unrelated consumers.

---

## Target Ownership Split

### App UI Store

Owns only local app state and imperative commands.

Consumers:
- app shell
- sidebar selection logic
- composer enable/disable state
- session commands

### Sidebar Data

Owned by `WorkspaceSidebar` or a sidebar-scoped hook/provider.

Queries:
- `workspaces.list`
- one sidebar session query

Preferred future query:
- `sessions.listForSidebar`

This should replace the current pattern where each `WorkspaceGroup` owns its own `sessions.listByWorkspace` subscription while the global store also owns a session query.

### Active Session Scope

Owns active-session chat data only.

Queries/state:
- `messages.listMetadata(activeSessionId)`
- per-message `getContent(externalId)`
- local IPC-driven `streamingMessages`
- merged `displayMessages`
- chat-local derived state

Consumers:
- `ChatView`
- `PermissionPrompt` only if permission state is still session-scoped in this layer
- any future timeline/review panel

### Permission State

Owns pending permission requests separately from transcript messages.

Queries/state:
- `permissions.getPendingForSession(activeSessionId)` or equivalent
- optional permission history/audit records if needed later

Consumers:
- `PermissionPrompt`
- optional badges/indicators in session header

---

## Permission Redesign

### Current problem

Today the app stores `permission.asked` as a synthetic message and the prompt scans the full message array for a JSON payload.

That creates three problems:
- transcript state is mixed with operational state
- permission UI depends on message-array churn
- prompt visibility depends on scanning/parsing unrelated chat data

### Target model

Use dedicated permission state.

OpenCode already models permissions as their own request/reply flow. Our renderer should mirror that separation.

Suggested shape:

`pending_permissions`
- `sessionExternalId`
- `requestId`
- `permission`
- `toolName`
- `description`
- `input`
- `patterns`
- `alwaysPatterns`
- `createdAt`

Event flow:
- `permission.asked` -> upsert pending request
- `permission.replied` -> remove or mark resolved
- `PermissionPrompt` -> subscribe directly to pending permission state
- approve/deny -> existing command path stays the same

If audit/history is desired later, add a separate permission history log. Do not use transcript messages to drive modal state.

---

## Component Tree Target

```tsx
<AppShell>
  <WorkspaceSidebar />
  <MainPanel>
    <ActiveSessionScope sessionId={activeSessionId}>
      <ChatView />
      <PermissionPrompt />
    </ActiveSessionScope>
    <MessageInput />
  </MainPanel>
</AppShell>
```

Effects of this split:
- message updates stay inside the active-session subtree
- sidebar does not re-render on chat message changes
- input does not re-render on transcript updates
- permission prompt reacts only to permission state changes

---

## Recommended Migration Sequence

### Step 1

Shrink `session-store` to app UI state + commands only.

### Step 2

Move sidebar queries into `WorkspaceSidebar` and remove duplicate session subscriptions.

### Step 3

Introduce `ActiveSessionScope` for active-session data.

### Step 4

Implement chat state with:
- `listMetadata`
- per-message `getContent`
- local IPC streaming overlay

### Step 5

Replace synthetic permission messages with dedicated permission state.

### Step 6

Update `PermissionPrompt` to subscribe directly to pending permissions.

### Step 7

Add diagnostics for subscriptions, event counts, and render frequency.

---

## Diagnostics Plan

Add a lightweight dev-only diagnostics layer.

### Console logging

Use stable prefixes:
- `[convex]`
- `[stream]`
- `[render]`
- `[permission]`

Log:
- query subscribe/unsubscribe
- query update counts
- stream cursor updates per message
- permission request lifecycle
- component render counts in development

### Optional dev panel

Small floating panel or drawer showing:
- active subscriptions
- update count per query
- update count per streaming message
- pending permission requests
- active local streaming message ids

This is intentionally simple. The goal is visibility, not observability platform complexity.

---

## What We Learned From Official OpenCode

These are the main useful architectural signals from the official app/codebase:

1. The desktop app is a thin native shell around a shared app package, not one monolithic desktop-only renderer.
2. The shared app uses many focused providers (`ServerProvider`, `GlobalSDKProvider`, `SDKProvider`, `SyncProvider`, `PermissionProvider`, etc.) instead of one giant context.
3. Their global event stream is batched and coalesced before UI delivery.
4. Message/part state is normalized rather than repeatedly rebuilding one giant transcript object for the whole app.
5. Permissions are a dedicated subsystem in the app shell, and in OpenCode itself permissions are modeled as request/reply events, not ordinary chat content.

We should copy those traits, not the exact implementation details.

---

## Notes Against Overengineering

This plan is the best-fit architecture, not unnecessary complexity.

It is intentionally narrower than a Redux-style "everything in one store" design:
- Convex data stays near its consumers.
- Local UI state stays in a thin store.
- Permissions become operational state.
- Chat streaming stays isolated to the active-session subtree.

That gives us better render behavior without introducing an abstract state-management framework for its own sake.
