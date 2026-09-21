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
- A draft's picks are held in the client until the first prompt. At launch they are filed as the workspace preference, because that is what the server seeds a new session from, and then `session.create` runs. A failed write stops the launch. Once the draft has become a session its picks are dropped, so the next draft follows what the workspace remembers by then.
- Each composer command is negotiated on its own. A draft pick the environment could not file (`composer.preferences.set`) or apply (`composer.mode.set`) is refused in the composer, and a remembered mode is not shown, so a draft never displays something it cannot launch with.
- Mode is the exception, since the server does not apply a remembered mode. A draft whose mode is not the provider's default launches as `session.create` (no first message), `composer.mode.set`, `turn.send`. If the switch fails the session is deleted and the draft stays open: prompting in agent mode when plan was asked for is not a fallback.
- A provider whose health blocks the composer is listed in the draft picker but cannot be chosen.

## Not covered here

Writing a draft pick to the preference as it is made, and remembering the last provider per workspace, are CAL-180.
