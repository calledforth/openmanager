# Composer drafts

Status: accepted (2026-10-01)

The environment keeps every unsent composer draft, so a draft survives a
reload and reaches every paired device. Until now the text lived in one
browser's localStorage and a new-session draft's model, mode and settings only
lived in the open tab.

## Two kinds of draft, one record each

| Kind          | Draft id             | Belongs to                  |
| ------------- | -------------------- | --------------------------- |
| `session`     | the session's id     | that session's composer     |
| `new_session` | minted by the client | a project, until it is sent |

- A session's draft is named by the session id, so every device writes the
  same record and a session never has two. It holds text and images only: the
  session runs on its own model selection (`live-composer-state.md`). It goes
  when the session is deleted.
- A new-session draft carries its project and the id its session will get,
  minted with the draft. A retried first send therefore creates the same
  session id. The draft holds the text, images and the picks made in it:
  provider, model, mode and settings. Only explicit picks are stored. What
  the composer seeds from the project's "last used" is resolved again each
  time the draft is shown.
- When its project is removed, a new-session draft is kept with no project
  (`workspace_id` is `SET NULL`), so nothing typed is lost. The composer only
  shows a project's drafts, so such a draft is not reachable from the UI until
  draft pages land (CAL-213), where the user picks another project for it.

Today a project has one current new-session draft: the composer on the new-session
page writes to the newest one. Draft pages, any number of drafts and sidebar cards
are later work (CAL-213, CAL-214), and need no schema change.

## Storage and events

`drafts` (migration 17) replaces the unused v2 table that was keyed by an
existing session. It has one row per draft, a `revision` that increases with
every save and delete, the writer's client id, and `deleted_at`.

Every write is a durable environment event, and its projection writes the row
in the same transaction:

- `draft.saved` carries the whole draft, so applying it twice is safe and the
  newest revision wins.
- `draft.deleted` carries the deletion's revision.

Clients follow both events live, and a reconnect replays what it missed.
Snapshots do not carry drafts, so after one a client lists them again
(`draft.list`). Reads need `read`; saving and deleting need `operate`. Typing
is not running the agent: a draft only reaches the agent when it is sent, and
sending needs `agent`.

## Last write wins, except over a send or a discard

A save names the revision it was edited from (`baseRevision`). The rules:

1. The environment keeps the newest save whatever its base. Two devices
   typing in the same draft end with whichever saved last. Nobody is asked to
   choose.
2. A deleted draft keeps its row, emptied, as a tombstone. A save based on a
   revision older than the deletion is refused with `conflict`, and the
   details name the deletion's revision. A late autosave from before a send
   or a discard therefore never brings the text back.
3. A save based on the deletion's revision or a later one is accepted. That
   is how a session's next draft starts after a send. The row remembers the
   deletion's revision (`deleted_revision`), so a save from before it is
   still refused once the next draft exists.
4. A delete names its base revision too, and is refused the same way: a
   clear made offline must not delete the draft written since the send.
5. A delete of a draft the environment never saw still writes a tombstone,
   because its first save may be on the wire behind the delete.

`draft.list` returns live drafts plus the tombstones of session drafts, so a
client knows what to save on top of. Tombstones of new-session drafts are
never listed. One comes back only through a save based on its deletion or
later: a failed send's restore, or text put back by the client that sent it.
Tombstones of both kinds are pruned 30 days after deletion (at start, then at
most hourly from `draft.list`), so the listing holds recent activity, not every
session ever sent from. A client offline for longer than that could bring a
draft back. A save on top of a pruned tombstone continues from the base it
names, so no client sees a revision go backwards. Clients forget a
new-session tombstone at the next listing once no edit of theirs needs it.

## Sending

`session.create` takes `draftId` and `sessionId`. The draft's deletion is
appended in the same `appendAtomic` write that announces the session, so no
save still in flight can outlive the send. If the session is rolled back (its
provider fails to start, or the first message is refused), the environment
saves the draft again at the next revision, as it was sent: the first message,
the provider and the picks. The send may have beaten the draft's last
autosave, so the saved row is not used. The retry then starts from what was
written. An id that is already taken is refused with `conflict`, and a draft
can only be sent as the session it was minted for, in its own project (or any
project once its own was removed).

A session draft is cleared, not consumed: sending empties the composer, and
the emptied draft is deleted like any other.

## The client

`EnvironmentState` holds:

- `drafts`: the environment's copies;
- `draftTombstones`;
- `draftEdits`: edits not saved yet;
- `draftsListed`.

`EnvironmentClient.drafts` (`createDraftSync`) does the saving:

- **Edit.** An edit lands in the state at once. The web host caches the whole
  state per environment in IndexedDB, so the edit survives a reload. It is
  saved after a pause in typing (`DRAFT_SAVE_DEBOUNCE_MS`, 1 s), or right away
  when the composer unmounts, the draft changes, or the page is hidden. A
  sentence costs one write, not one per key.
- **Ordering.** Each draft has one request in flight at a time, so a later
  edit can never overtake an earlier one. An edit made during a request is
  rebased on its answer.
- **Display.** A draft shows its waiting edit, otherwise the environment's
  copy. A remote save is shown live unless the user has an unsaved edit in
  that draft; the user's next save then wins.
- **Remote deletion.** An edit from before a remote send or discard is
  dropped. The environment would refuse it anyway.
- **Sending.** The composer sets the draft aside when send is pressed, before
  any image uploads, so what is typed meanwhile goes to the project's next
  draft. The sync holds the draft's saves while it is being sent. If the send
  fails, the restored text is kept even when the environment later announces
  the deletion and restore it made, and it is saved on top of them. A send
  that stops before it asks (a failed upload) is no deletion of its own, so
  another device's send of the same draft still takes it. A reload during a
  send forgets the held edit, and the environment's copy stands.
- **Clearing.** The environment announces a deletion before it answers it.
  Text typed while this client's own delete is on the wire is kept through
  that announcement and saved as the draft's next text.
- **Offline.** Edits wait in the state while offline, and are saved once the
  client is connected and has listed the drafts. A listing that fails on a
  live connection is retried, backing off up to 30 s.
- **Size.** A save must fit in one message to the environment (64 KiB), so a
  draft over `DRAFT_SAVE_MAX_BYTES` encoded is kept on the device that has it,
  and saved once it is short enough again.

`ComposerDraftStore` is the composer's view of this: synchronous text by draft
key, so a restored draft is on screen at first paint. Hosts without an
environment that keeps drafts fall back to localStorage. On first connect,
old localStorage drafts are imported once their session or project is known,
then removed.

## Not yet

- Images still upload at send time and are not kept with a draft (CAL-215).
  `artifactIds` is already part of the content.
- No offline or unsynced indicator (CAL-85).
- If a send's response is lost after the session was created, the restored
  draft can come back next to the new session. Sending it again is refused,
  because the session id is taken.
