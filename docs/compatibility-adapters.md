# Compatibility adapters (temporary)

During the Convex-to-environment-server migration the desktop must keep
working while views move from the Convex-backed domain providers to the shared
environment-client hooks. This document describes the temporary adapter that
makes that possible, how the backend flag works, what the adapter does not
cover, and how to delete it when Convex is retired.

Everything described here is scheduled for deletion. Do not build on it.

## What exists

| File                                                                             | Role                                                                                                                                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/renderer/src/environment/convex-environment-client.ts`         | `createConvexEnvironmentClient`: an `EnvironmentClient` over Convex queries/mutations, `pending_jobs`, and the Electron `acp:event` / `stream:token` channels. |
| `apps/desktop/src/renderer/src/environment/agent-event-translator.ts`            | Pure mapping from `AgentEvent` (what the main process pushes over IPC) to protocol `ProofEvent`s, so the shared reducers apply unchanged.                      |
| `apps/desktop/src/renderer/src/environment/convex-gateway.ts`                    | Adapts the renderer's `ConvexReactClient` to the three operations the adapter needs.                                                                           |
| `apps/desktop/src/renderer/src/environment/select-backend.ts`                    | Backend flag resolution and the WebSocket URL derivation.                                                                                                      |
| `apps/desktop/src/renderer/src/environment/DesktopEnvironmentClientProvider.tsx` | Mounts either the adapter or `createWebSocketEnvironmentClient` behind the flag.                                                                               |
| `apps/desktop/src/main/environment-client-config.ts`                             | Reads the flag and server settings from the main process environment into `RuntimeConfig.environmentClient`.                                                   |

The provider is mounted in `apps/desktop/src/renderer/src/main.tsx` inside
`ConvexProvider`, so both backends are available to everything under `<App />`.
Visual components only ever import `@openmanager/app-core/providers/environment-client`;
nothing under `environment/` is imported by a view, and the app-core lint
boundary rejects any attempt to import it from the shared package.

## The flag

| Setting                                                     | Values                                                            | Default                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------ |
| `OPENMANAGER_ENVIRONMENT_CLIENT` (main process env)         | `convex`, `websocket`                                             | `convex`                 |
| `OPENMANAGER_ENVIRONMENT_URL`                               | HTTP origin of the environment server                             | `http://127.0.0.1:43120` |
| `OPENMANAGER_CLIENT_TOKEN`                                  | the server's development client token (`<data-dir>/client-token`) | empty                    |
| `localStorage['openmanager.environment-client']` (renderer) | `convex`, `websocket`                                             | unset                    |

The local-storage override wins over the environment variable so the backend
can be flipped from devtools and a reload, without relaunching Electron:

```js
localStorage.setItem('openmanager.environment-client', 'websocket')
location.reload()
```

With `websocket`, the renderer connects to the environment server directly and
the Convex deployment is untouched by the environment client. The legacy
domain providers (`SessionStateProvider`, `ActiveThreadStateProvider`, …) still
run against Convex in both modes until the views consume the environment
client; the flag only decides what `useEnvironmentClient()` and the hooks built
on it talk to.

## How the Convex adapter maps things

| Environment client                 | Convex / Electron path                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace catalog                  | `workspaces.list` subscription; `workspaceId` is the workspace path                                                                                                                                                                         |
| Session catalog                    | `sessions.listForSidebar` subscription, child sessions hidden; `sessionId` is the session external ID; one thread per session with `threadId === sessionId`                                                                                 |
| `openSession`                      | `sessions.getByExternalId` + `messages.listMetadata` + `messages.getContent` per message + pending permission/question/plan rows, folded through `applySessionOpen`                                                                         |
| Live turn state                    | `acp:event` and `stream:token` listeners, translated to `turn.*`, `message.delta`, `message.reasoning`, `tool.updated`, `interaction.*`; events are de-duplicated by ID because the main process sends stream-class events on both channels |
| `createSession`                    | `create_session` job, resolved by the `session_created` IPC event for that workspace                                                                                                                                                        |
| `sendTurn`                         | `send_message` job, resolved by the `prompt_started` IPC event for the generated `userMessageId`; the job's `failed` status rejects the command                                                                                             |
| `interruptTurn`                    | `abort` job                                                                                                                                                                                                                                 |
| `respondToInteraction`             | `resolve_permission`, `resolve_question`, `resolve_plan` jobs; resolves when the job reports `done`, and the interaction stays pending until the provider's own settlement event clears it                                                  |
| `renameSession`                    | `sessions.upsertTitle` with `source: 'user'`                                                                                                                                                                                                |
| `deleteSession`                    | `delete_session` job                                                                                                                                                                                                                        |
| `addWorkspace` / `removeWorkspace` | `workspaces.ensureByPath` / `workspaces.remove`                                                                                                                                                                                             |

Turn identity follows the Convex projector: the turn ID is the assistant
message ID the host stamps on every event of a turn (`event.messageId`), which
is also the persisted assistant message's external ID. Hydrated history and the
live tail therefore agree on turn IDs.

## Known gaps

These are accepted for the migration window and disappear with the adapter:

- **Sessions driven by another host** get no live events; only the catalog
  updates. The legacy remote-streaming path (`streamChunks`) is not mirrored.
- **Session status in the sidebar** is derived from turns this renderer has
  seen; a session running elsewhere reads as idle until it is opened.
- **Attachments** are not sent by `sendTurn` (text only); hydrated image parts
  appear as `resource_link` blocks.
- **Plan feedback messages** written by the legacy `resolvePlan` are not
  persisted by `respondToInteraction`.
- **Clearing a title** (`renameSession(id, null)`) is rejected; Convex has no
  such operation.
- **Composer state** (models, modes, config options, commands, usage) has no
  protocol events yet; it stays with `ComposerStateProvider`.
- `workspaceId` is the filesystem path, which can contain spaces the protocol's
  entity-ID schema would reject on the wire. The adapter never validates its
  own events; workspace identity on the wire is CAL-51's job.

## How to delete it

Do this as part of Convex retirement, once every view reads through the
environment-client hooks and the desktop no longer mounts the legacy domain
providers.

1. Delete `apps/desktop/src/renderer/src/environment/convex-environment-client.ts`,
   `agent-event-translator.ts`, `convex-gateway.ts`, and their tests.
2. In `DesktopEnvironmentClientProvider.tsx`, remove the `convex` prop and the
   Convex branch of the effect; keep the WebSocket branch. Consider moving the
   file next to the web shell's `WebEnvironmentClientProvider` if the two are
   now identical.
3. Delete `EnvironmentClientBackend`, the `backend` field, and
   `resolveEnvironmentClientSelection` / `readStoredBackendOverride` from
   `select-backend.ts` and `runtime-config.ts`; delete the
   `OPENMANAGER_ENVIRONMENT_CLIENT` handling in `main/environment-client-config.ts`.
   The server URL and credential settings stay.
4. Remove `ConvexProvider` and the `convex` argument from `main.tsx`; the
   provider then mounts unconditionally.
5. Remove `@openmanager/convex` and `convex` from `apps/desktop/package.json`
   once the legacy providers are gone too.
6. Remove this document and the "Convex/Electron compatibility" row from
   `packages/environment-client/README.md`.

Nothing in `packages/environment-client` or `packages/app-core` references the
adapter, so those packages need no changes when it goes.
