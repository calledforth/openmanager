# Application providers

The renderer's application state is split into four providers, each owning one
domain. The contracts (context, value type, hook, and pure helpers) live in
`packages/app-core/src/providers/` so any host can implement them; the desktop
implementations in `apps/desktop/src/renderer/src/providers/` bind them to
Convex and the Electron bridge. Views only ever import the app-core hooks.

## Tree

```
ConvexProvider
└─ DesktopEnvironmentClientProvider   useEnvironmentClient and the hooks built on it
   (Convex adapter or WebSocket client, per flag; docs/compatibility-adapters.md)
   └─ ThemeProvider
      └─ PlatformCapabilitiesProvider     usePlatformCapabilities
         └─ SessionStateProvider          useSessionState
            └─ ComposerStateProvider      useComposerState
               └─ SidebarDataProvider     (desktop only)
                  └─ ActiveThreadStateProvider   useActiveThreadState, useStreamingMessage
                     └─ Permission / Question / Plan state providers
                        └─ DesktopViewActions
```

The environment client sits above the domain providers but is independent of
them: the domain providers still bind to Convex directly, and views migrate to
the environment-client hooks one at a time. Once they all have, the domain
providers and the Convex adapter are deleted together.

Each provider may read the ones above it and nothing below it.

## Domains

| Provider | Owns | Does not own |
| --- | --- | --- |
| **Platform capabilities** (`platform-provider`) | Provider registry and metadata, health and derived UI status, handshake agent info and prompt capabilities, client identity, `ensureProvider` / `retryProvider`. | Anything tied to a workspace or session. |
| **Session state** (`session-provider`) | Active workspace and session, draft open/pending flags, local turn status, adopted draft session, default provider, provider-per-session registry, workspace/session navigation commands, and the turn lifecycle (`beginDraftTurn`, `beginSessionTurn`, `attachTurnJob`, `failTurn`). Publishes a `draftRequest` when a draft opens. | Composer selection, message data. |
| **Composer state** (`composer-provider`) | Per-session ACP runtime (models, modes, config options, commands), per-provider profiles, per-workspace preferences, the resolved `acpSessionState` / `draftSessionState`, the low-frequency `agentEvents` fed to `deriveSessionChrome`, and the `setDraft*` / `setSession*` commands. Seeds a draft when `draftRequest` changes and answers `draftLaunchPreferences` / `sessionLaunchPreferences` for prompt submission. | Navigation, prompt submission. |
| **Active thread** (`active-thread-provider`) | The persisted session record on screen, message metadata with optimistic user messages, the `StreamingMessagesStore`, and every turn command: `sendMessage`, `abortSession`, `resolvePermission`, `resolveQuestion`, `resolvePlan`, `buildPlan`. | Which session is active (read from session state). |

ACP events are consumed independently by each provider for its own event
types. High-frequency stream events go only to the `StreamingMessagesStore`
(`packages/app-core/src/lib/streaming-messages-store.ts`), never into React
state.

## Cross-domain seams

- **Sending a prompt.** The active thread provider asks the composer for the
  draft's launch preferences, tells session state the turn began, starts the
  provider through platform capabilities, submits the job, and attaches the job
  id so session state can unlock the composer when the job finishes.
- **Opening a draft.** Session state resets navigation and publishes a
  `draftRequest`; the composer seeds that workspace's selection from the
  previous session, the workspace's last pick, or the default provider, then
  starts the provider and hydrates the catalog.
- **Provider per session.** Session state keeps the registry; the composer's
  runtime state also carries `providerId` because the runtime is keyed by it.

## Tests

- `packages/app-core/tests/composer-provider.test.ts` covers the draft and
  session resolvers, connection coordination, and composer gating.
- `packages/app-core/tests/active-thread-provider.test.ts` covers optimistic
  message merging and the draft handoff.
- `apps/desktop/src/renderer/src/providers/agent-stream-regression.test.ts`
  covers the streaming store against the agent runtime.
