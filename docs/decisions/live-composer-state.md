# Live composer state: dedicated events, selection per session

Status: Accepted, 2026-09-19. Recorded from [CAL-178](https://linear.app/calledforth/issue/CAL-178/keep-catalog-and-session-composer-state-live-across-clients).

## Decision

The environment server owns composer state and pushes every change to every client as a durable environment-scoped event. Clients never refetch to find out what another client, or the agent, changed.

| Event                          | Payload                                 | Meaning                                                             |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------- |
| `session.composer.updated`     | `sessionId`, whole `composer` selection | One session's model, mode, config values, options, commands, usage. |
| `composer.preferences.updated` | `workspaceId`, `providerId`, preference | The "last used" selection a new draft in that workspace opens with. |
| `provider.catalog.updated`     | whole provider `profile`                | Models, modes and defaults the environment last learned.            |

Each payload is the whole current value, not a patch, so a replayed or repeated event is harmless. Session summaries (`session.list`, the environment snapshot) carry the same `composer` selection. A server that does all of this advertises `composer.events`.

**The selection belongs to the session.** Two sessions in one workspace can run different models. `composer.model.set`, `composer.mode.set` and `composer.config_option.set` change that session only. They also update the workspace preference, but that preference is only "last used": it seeds the next draft and never reaches into a session that already has a selection. A session with no selection yet (one that predates this change) takes the preference the first time its runtime reports, and owns it from then on.

Within a selection the fields do not behave alike:

- `modelId` and `configValues` are the user's choice. The server re-applies them before every prompt (`HostDeps.desiredSessionConfig` is asked per thread), so a provider reporting a different model replaces the choice only when the chosen model is no longer offered.
- `modeId` follows the provider. Agents switch modes on their own (plan to build), so a `current_mode_update`, or a plan build the host starts in a given mode, always wins. A plan build's mode is reported once the provider has started the prompt, so a launch that fails leaves every composer where it was. Mode is still not enforced on respawn.
- `configOptions` is the provider's latest listing for that session. Options the protocol cannot express are dropped rather than hiding the rest.
- `availableCommands` is the provider's latest slash-command listing, held the same way. A command is invoked as ordinary prompt text (`/name …`), so the listing is the whole feature: there is no command to run one. Providers list their commands again when a session loads, so an empty listing replaces the old one.
- `usage` is the provider's latest context-window reading (`used`, `size`, optional cumulative `cost`). It is not a choice, but it rides the selection because it needs the same delivery: providers do not report usage again when a session loads, so only the persisted selection lets the meter survive a restart. A reading without a window size is ignored, and a provider that reports none (Cursor) leaves `usage` absent, so no meter renders.

## Alternatives considered

| Alternative                                           | Assessment                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refetch on `session.updated` / provider health change | `composer.preferences.get` answers for the workspace, not the session, so an agent-initiated mode switch is invisible to it. Neither trigger fires for a catalog change, and a refetch cannot be replayed after a reconnect. |
| Keep the model global to a workspace and provider     | What desktop did when one provider process served every session. With one runtime per session it is simply wrong: picking a model in one chat would silently change it in another.                                           |
| Ephemeral broadcast outside the event log             | Simpler to emit, but a client that was offline would need a second recovery path. Riding the sequenced log makes reconnect replay work with no composer-specific code.                                                       |

## Persistence and recovery

- The session selection is projected from `session.composer.updated` into `sessions.composer_json` in the same transaction as the event, so the log and the row cannot disagree. It does not touch `updated_at`; changing a model must not reorder the sidebar.
- If that write fails, the command still succeeds (the provider has already switched) and the server keeps the selection in memory, so reads and the next prompt stay on it until a later write lands. Other clients catch up with that write.
- Preferences and profiles already live in the composer store's own tables. Their events are carriers only and project nothing.
- Reconnect with a cursor replays the missed events. Reconnect without one (or across a gap) reads the selection from the session summaries, refetches the catalog, and marks held preferences as not loaded, because the snapshot does not carry them.
- On the client a pushed preference counts as a landed write: the answer to a read issued before it is dropped.

## How the pickers use it

The environment composer provider (`packages/app-core/src/providers/environment-composer.tsx`) reads all of the above and keeps no copy of it.

- An open session shows `session.composer` first. `resolveSessionComposerRuntime` takes `modelOwner: 'session'` for this; the workspace preference only stands in for a session that has no model yet. Desktop's Convex path keeps the default (`'workspace'`).
- Session setters are the three commands and nothing else. A failure is shown in the composer; success arrives as the pushed event.
- A draft's picks are held in the client until the first prompt. The launch is one `session.create` carrying them as `preference`. The server files them as the workspace preference before it starts the provider, because that is what a new session is seeded from, and refuses the create if the write fails. Once the draft has become a session its picks are dropped, so the next draft follows what the workspace remembers by then.
- Each composer command is negotiated on its own. A draft pick the environment could not file (`composer.preferences.set`) or apply (`composer.mode.set`) is refused in the composer, and a remembered mode is not shown, so a draft never displays something it cannot launch with.
- Mode is the exception, since the server does not apply a remembered mode. A draft whose mode is not the provider's default names it as the create's `modeId`, and the server runs the first message in it the way a plan build runs: the mode is set on the live session before the prompt, and a mode that cannot be set fails that turn rather than prompting in the default one. The session's composer shows the mode once the provider has accepted it. Before protocol version 6 (CAL-197) the client ran this as `session.create` with no first message, then `composer.mode.set`, then `turn.send`, and deleted the session if the switch failed.
- A provider whose health blocks the composer is listed in the draft picker but cannot be chosen.

## What a provider and its models accept in a prompt

Added 2026-09-23 for [CAL-196](https://linear.app/calledforth/issue/CAL-196/tell-the-web-composer-which-providers-and-models-accept-images). The composer refuses an image until it knows the provider takes image prompts and the model can read them. Desktop learned both through Electron; the web composer had no source and waited forever.

Both answers are learned facts, so both ride the provider profile and `provider.catalog.updated`, not the static provider capabilities. The profile is what the environment last learned from a real process; the capabilities object is copied from config and never changes after boot. Putting a learned value there would have needed a second update path and a second broadcast for something the profile already persists, deduplicates and replays. Protocol version 5 carries the two fields.

- `profile.promptCapabilities` is the handshake's answer: `image`, `audio`, `embeddedContext`, all required. The runtime normalises every ACP `initialize` response so an omitted capability is recorded as `false` (as ACP defines it) rather than forwarded as "nobody said", which is what left the composer checking forever. Every process of a provider answers it, probe or live session, so the health monitor's boot sweep fills it in for every installed provider before anyone opens a composer, and it survives restarts in `provider_profiles.prompt_capabilities_json`.
- `availableModels[].supportsImageInput` is per model and tri-state: `true`, `false`, or absent for "nobody could say". Absent lets the image through, exactly as desktop treats every provider it cannot ask; only `false` blocks. ACP catalogs carry no such flag, so the server asks the provider's own CLI out of band (`opencode models <provider> --verbose --pure`, the lookup desktop ran from Electron, now shared from the runtime package) after any catalog write, one listing per upstream provider prefix, cached for the life of the server. The answer is merged into the profile as it is *by then*, by model id, because a session may have relisted the catalog while the CLI ran; a write that lands mid-lookup marks the pass dirty so it repeats. A relisting keeps the flags its ids already had, since the flag describes the model and no session listing ever carries it. The lookup tells "asked, nobody can say" (`null`, kept) apart from "could not ask right now" (the id is left out: the CLI failed or is held after a failure); the server retries the latter after the hold, independently of catalog writes, so a stable catalog listed while the CLI was down does not stay unresolved.
- The composer reads the model answer off the model row first, so on web it is reactive by construction, and only asks the host's own lookup (desktop's IPC) when the row is silent. No web-specific hook: a function answering from the catalog would go stale the moment an enrichment landed after render.

## Not covered here

Writing a draft pick to the preference as it is made, and remembering the last provider per workspace, are CAL-180.
