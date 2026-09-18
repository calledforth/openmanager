# @openmanager/environment-client

The interface React talks to. Visual components request data and send commands
through an `EnvironmentClient` and nothing else: no Convex hooks, no Electron
IPC, no raw sockets.

```ts
interface EnvironmentClient {
  commands: EnvironmentCommands // send, interrupt, respond, CRUD sessions/workspaces
  getState(): EnvironmentState // normalized, immutable
  subscribe(listener): Unsubscribe // external-store contract for useSyncExternalStore
  supports(command): boolean // advertised by the environment's handshake
  setActiveSession / setActiveThread // local selection
  connect / disconnect / dispose
}
```

Selectors (`selectSessionList`, `selectActiveThread`, `selectPendingInteractions`,
…) are pure functions over `EnvironmentState`. React bindings live in
`@openmanager/app-core/providers/environment-client`.

## Implementations

| Implementation                     | Use                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `createWebSocketEnvironmentClient` | Browser and desktop against the environment server                                                                               |
| `createMockEnvironmentClient`      | Tests and Storybook; canned sessions, scripted streaming, and `reconnect()` that rehydrates without duplicates                   |
| `createConvexEnvironmentClient`    | Desktop during migration; temporary, lives in `apps/desktop/src/renderer/src/environment` (see `docs/compatibility-adapters.md`) |

All implementations feed the same reducers (`applyEvent`, `applySnapshot`,
`applySessionOpen`, `applySessionHistory`), so behaviour verified against the mock holds on the wire.
Every reducer is idempotent by resource ID: replayed or duplicated events
cannot double-apply.

## Interface ahead of the wire

The interface deliberately covers more than the server implements today.
`WIRE_COMMANDS` maps each client command to its wire name; the WebSocket client
rejects a command with `capability_missing` before sending anything when the
handshake did not advertise it. Provisional names (`workspace.add`,
`workspace.remove`, `session.rename`, `session.delete`) become real when the
protocol adds them (CAL-50, CAL-58); replay-based hydration replaces
`session.open` + `session.history` when CAL-71 lands. The mock advertises everything by default and
can be narrowed with `capabilities` to exercise the gated paths.

## Composer

Six commands back the composer pickers, each gated on its own capability:

| Command                                           | Wire name                                  |
| ------------------------------------------------- | ------------------------------------------ |
| `getProviderCatalog`                              | `provider.catalog.get`                     |
| `getComposerPreference` / `setComposerPreference` | `composer.preferences.get` / `.set`        |
| `setSessionModel` / `setSessionMode`              | `composer.model.set` / `composer.mode.set` |
| `setSessionConfigOption`                          | `composer.config_option.set`               |

The catalog (providers plus their models, modes and defaults) lands in
`state.providers`; the WebSocket client reads it after every handshake, and
`getProviderCatalog` refreshes it. Preferences land in
`state.composerPreferences[workspaceId][providerId]` whenever a composer
command answers. A missing entry means "not loaded yet", which is different
from a loaded, empty preference. `setComposerPreference` is a patch, and the
session setters change the live session and answer with the remembered
preference for that session's workspace and provider. Read with
`selectProviderCatalog` and `selectComposerPreference`.

## Browser safety

The package depends only on `@openmanager/protocol` and `zod`. ESLint applies
the same restricted-import rules as `app-core`; Node built-ins, Electron,
Convex and the agent runtime are rejected at lint time.
