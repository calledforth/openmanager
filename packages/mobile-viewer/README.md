# Mobile Viewer Client — Integration Guide

This directory is reserved for a future mobile/remote viewer client (React PWA, React Native, or any web framework).

## Architecture

All clients — including this one — connect to the same Convex backend. The desktop Electron app acts as the local worker that bridges Convex and the OpenCode sidecar. This client only needs Convex.

```
[This client] ──WebSocket──► [Convex] ◄──WebSocket── [Electron main process]
                                                              │
                                                       [opencode acp]
```

## Convex Queries (read — subscribe for real-time updates)

| Function | Args | Returns | Use for |
|---|---|---|---|
| `api.sessions.listByWorkspace` | `{ workspacePath: string }` | Session[] | Session list sidebar |
| `api.sessions.getByExternalId` | `{ externalId: string }` | Session \| null | Session detail |
| `api.messages.listMetadata` | `{ sessionExternalId: string }` | Message metadata[] | Chat timeline metadata (ordered by sequenceNum) |
| `api.messages.getContent` | `{ externalId: string }` | Message content | Message body content |
| `api.workspaces.list` | `{}` | Workspace[] | Workspace picker |
| `api.jobs.listPending` | `{ clientId: string }` | PendingJob[] | Queue status indicator |

All queries are reactive — subscribe via `useQuery()` (React) or `client.onUpdate()` (vanilla JS) for live updates including streaming tokens.

## Convex Mutations (write — submit actions)

| Function | Args | Use for |
|---|---|---|
| `api.jobs.submitMessage` | `{ workspacePath, sessionExternalId, content }` | Send message (creates user msg + pending job atomically) |
| `api.jobs.submit` | `{ workspacePath, type, payload }` | Generic job (create_session, abort, delete_session, resolve_permission) |
| `api.workspaces.create` | `{ name, path, machineId }` | Register workspace |

### Job types for `api.jobs.submit`

| type | payload (JSON string) |
|---|---|
| `create_session` | `{ workspacePath, title? }` |
| `abort` | `{ workspacePath, sessionExternalId }` |
| `delete_session` | `{ workspacePath, sessionExternalId }` |
| `resolve_permission` | `{ workspacePath, sessionExternalId, permissionId, approved }` |

## Message shape

```typescript
{
  externalId: string       // unique ID
  role: string             // "user" | "assistant" | "system" | "tool" | "permission"
  content: string          // text content (or JSON for permission role)
  isFinal?: boolean        // false = still streaming, true = complete
  sequenceNum: number      // ordering within session
  createdAt: number        // timestamp
}
```

Messages with `role: "permission"` have JSON content:
```json
{ "type": "permission_request", "permissionId": "...", "toolName": "...", "description": "..." }
```

## Setup

1. Install `convex` package
2. Use the same `CONVEX_URL` from the workspace root `.env.local`
3. Create a `ConvexReactClient` (React) or `ConvexClient` (vanilla) with that URL
4. Subscribe to queries above for real-time data
5. Call mutations above to submit actions

## Phase 3 limitations (viewer-only)

- Sending messages and submitting jobs works but requires the desktop app to be running (it's the worker that executes against OpenCode)
- If desktop is offline, jobs remain `pending` until it reconnects
