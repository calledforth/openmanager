# Composer drafts

Status: accepted (2026-10-01)

The environment keeps every unsent composer draft, so a draft survives a
reload and reaches every paired device. Until now the text lived in one
browser's localStorage and a new-session draft's model, mode and settings only
lived in the open tab.

## Two kinds of draft, one record each

| Kind          | Draft id             | Belongs to                            |
| ------------- | -------------------- | ------------------------------------- |
| `session`     | the session's id     | that session's composer               |
| `new_session` | minted by the client | a page in a project, until it is sent |

- A session's draft is named by the session id, so every device writes the
  same record and a session never has two. It holds text and images only: the
  session runs on its own model selection (`live-composer-state.md`). It goes
  when the session is deleted.
- A new-session draft carries its project and the id its session will get,
  minted with the draft. A retried first send therefore creates the same
  session id. The draft holds the text, images and the picks made in it:
  provider, model, mode and settings. Only explicit picks are stored (see
  "Picks" below). Its project can change: the draft is saved again with the
  new `workspace_id`.
- When its project is removed, a new-session draft is kept with no project
  (`workspace_id` is `SET NULL`), so nothing typed is lost. Its page says the
  project is gone, and the user picks another one for it.

## Draft pages

Each new-session draft has a page, `/drafts/<id>`, and a project can have any
number of drafts. Reload, back, forward and bookmarks return to the draft. This
needed no schema or protocol change.

- **`/` is blank.** It holds one draft, not one per project, and opens in the
  most recently used project that is available. Its ids (draft and session)
  are minted when the page opens, but nothing is saved and the address stays
  `/`. `/` never reopens an older draft of the project: older drafts are
  reached by their address (and by their sidebar cards).
- **The first character, or the first image, makes it a draft.** The text
  is saved, and the address becomes `/drafts/<id>` by replacing the history
  entry. On the web every chat page is a child of one pathless layout, so the
  composer is not rebuilt and keeps its focus and caret. A model or mode
  pick alone saves nothing and does not change the address: the page holds
  it until the first save, which takes it along.
- **New agent opens a blank page** in the project asked for. An empty page
  was never saved, so opening another leaves nothing behind; one that has
  text stays a draft at its address.
- **The project picker on the page moves the draft.** Text, images and
  explicit picks stay. Seeded values follow the new project.
- **An unknown address** (deleted, sent, or not listed yet) waits for the
  environment's listing; until then the page says it is opening rather than
  showing a blank composer that the draft would replace. A draft sent from
  this browser leads to its session (the browser remembers which session a
  sent draft became). Anything else replaces the address with `/`.
  A sent draft's session need not be loaded yet. A session's address opens
  a session the client has not loaded (one past the session list's first
  page) by asking the environment for it, and replaces the address with `/`
  when the environment does not have it (deleted since). A loaded session
  is gone to at once; otherwise the listing of drafts is waited for, because
  a draft sent elsewhere can come back (see "Other devices").
- **Sending** uses the session id minted with the draft. The session's
  address replaces the draft's in the history, since the draft is gone; a
  failed send leaves the draft and its address as they were. A draft being
  sent is the send's: it is never discarded meanwhile, and if the user opened
  another page while its images uploaded, the session is created without
  taking that page or the view.
- **Other devices.** The page follows the environment's copy of its draft,
  so a move made elsewhere stands even after the text is cleared here. A
  draft sent elsewhere (its minted session exists, and this client is not
  sending it) retires its page, which leads to that session. The session is
  announced before its provider starts, and no event says when the start can
  no longer fail. If it fails, the environment deletes the session and saves
  the draft back as sent; the page then takes its address back, from the
  session's or from `/` where that dead address fell back to. Not if the
  user has moved on meanwhile: to another session or draft, to New agent,
  off the session while it stood, or off that `/` (to Settings, say) before
  the draft came back.

## Picks

A draft stores only what the user explicitly picked. Seeded values (the
provider the project last ran, its last-used model, mode and settings) are
resolved again each time the draft is shown, so a session's model change
shows in the next blank draft at once, and a draft moved to another project
follows that project.

A pick in a draft never writes the workspace's last-used preference. Only
sessions do: the launch, which files the draft's explicit picks as the new
session's seed (`session.create` with `preference`), and model, mode or
setting changes made inside a session. A provider's settings are one value
that the environment replaces whole, so a launch with a settings pick files
every setting the draft shows: the seeded ones with the picks over them. A
pick belongs to the provider it was made for. When that provider is down, the
draft keeps the pick and holds the send with the reason until it is back or
another is picked.

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
6. A delete may also name `ifRevision` (protocol v15): delete only the draft
   as it was at that revision. If the draft has a later revision, the delete
   is refused with `conflict` and `DraftChangedDetails` (`changed: true`,
   and the revision it has now), and the draft is untouched. Without it, a
   delete takes whatever the draft holds, as a clear and a send need. A
   sidebar discard always names it.

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
can only be sent as the session it was minted for. It starts in the project it
is sent from: the project is the user's to change, and a send can beat the
save that moved the draft.

A session draft is cleared, not consumed: sending empties the composer, and
the emptied draft is deleted like any other.

## Images

A draft's images are kept with it, like its text: they survive a reload,
follow the draft to another project, and show on every device. The
environment decides how long an image lives, from the drafts table, in the
same synchronous step as the write that changes it. No client releases an
image.

- **Upload on attach.** The composer uploads an image the moment it is
  attached, then names it in the draft's `artifactIds` (in attach order). Send
  waits until every image has landed. A new-session draft's image is uploaded
  for the draft's project and held there (no session yet). A session draft's
  image is uploaded for the session and is the session's from the start, like
  anything sent in it.
- **Lifetime.** A held image no launch claimed expires after a day
  (`HELD_UPLOAD_TTL_MS`), unless a saved draft names it. The held-upload
  sweep skips any image a live draft names, so an image lives exactly as long
  as some draft wants it. An image taken out of a draft is not freed on the
  spot: it is simply no longer named, and expires.
- **Project move.** Saving a new-session draft with another project moves its
  held images to that project, in the save's own transaction (the
  `draft.saved` projection). An image a session has taken never moves.
- **Project removal.** Removing a project keeps the held images a draft
  names. `attachments.workspace_id` is nullable and `SET NULL` on removal
  (migration 19, which rebuilds the table). A session's images still go with
  the session. A held image nothing names expires as usual.
- **Sending** claims the images as before, all or none. The client that
  uploaded an image may claim it, and so may any client sending the draft
  that names it: the draft's images are read before the send deletes it.
  Claiming moves an image to the session's project, because a draft can be
  sent from the project it was just moved to before the save that moved it
  lands. A rolled-back launch hands its images back before the session is
  deleted, and the draft it restores names them again.
- **Discarding** frees the draft's held images in the `draft.delete` that
  deletes it, once its tombstone is written: what the undo window ends with.
  An image another live draft names, or a session took, stays. A refused
  delete (a conditional discard of a draft written since, or one from before
  a deletion) frees nothing. A send's deletion frees nothing either: its
  session claims the images.
- **Reading back.** A device that did not upload an image reads it through the
  draft, at `GET /draft-artifacts/<draft-id>/<artifact-id>`. It answers only
  while that draft names the image, to a client with `read`, like
  `draft.list`. A session draft's images use the session's route. Bytes are
  never cached by the browser (`no-store`); the client keeps its own object
  URLs, and the composer shows its own preview of what it uploaded.
- **Protocol v16.** A v15 environment has no read route, refuses another
  device's images at launch, and expires a draft's images after a day.
- **Hosts without kept drafts** (desktop, the localStorage fallback) keep
  images in the composer and upload them when sent, as before.

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
  any image uploads, so what is typed meanwhile goes to a draft of its own in
  the same project. The sync holds the draft's saves while it is being sent. If the send
  fails, the restored text is kept even when the environment later announces
  the deletion and restore it made, and it is saved on top of them. A send
  that stops before it asks (a failed upload) is no deletion of its own, so
  another device's send of the same draft still takes it. A reload during a
  send forgets the held edit, and the environment's copy stands.
- **Clearing.** The environment announces a deletion before it answers it.
  Text typed while this client's own delete is on the wire is kept through
  that announcement and saved as the draft's next text.
- **Offline.** Edits wait in the state while offline, and are saved once the
  client is connected and has listed the drafts, the least recently
  edited draft first. That
  includes new drafts started offline: a draft id is minted on the client, so
  nothing needs the environment to begin one. A listing that fails on a live
  connection is retried, backing off up to 30 s.
- **Unsynced.** `selectDraftSyncStatus` says whether the environment has a
  draft's latest edit: `synced`, `saving` (waiting out the pause in typing,
  or on the wire), or why not: `offline`, `unsupported`, `too_large` or `failed`. An edit
  made while the environment cannot be reached reads as `offline` at once. A
  save that could not go marks the edit (`DraftEdit.stalled`); the mark is
  kept through later typing, including typing during the save that
  reconnects it, and cleared only when a write carrying that edit is
  answered, so a reconnect does not clear it before the environment has the
  text. A save that fails on a live connection is tried again, backing off up
  to 30 s; one cut off by a dropped connection waits for the reconnect. The
  composer shows "Not synced" for the stuck states and nothing while an
  edit is merely saving. Only a refusal drops an edit: a deletion it is older
  than (the rules above), or a session that no longer exists.
- **Size.** A save must fit in one message to the environment (64 KiB), so a
  draft over `DRAFT_SAVE_MAX_BYTES` encoded is kept on the device that has it,
  and saved once it is short enough again.

`ComposerDraftStore` is the composer's view of this: synchronous text and
images by draft key (`session:<id>`, or `new:<draftId>` for a new-session
draft), so a restored draft is on screen at first paint. The key is the draft's id, not its
project, so moving a draft keeps what the composer holds for it. Hosts without
an environment that keeps drafts fall back to localStorage and one draft per
project (`draft:<workspaceId>`), with no draft pages. On first connect, old
localStorage drafts are imported once their session or project is known, then
removed; a project's old landing text becomes a draft of its own.

Session state names the draft on screen (`newSessionDraftId`), and
`selectNewSessionDraftIds` lists every new-session draft with text or images,
newest first, whatever its project.

## Sidebar draft cards

Every new-session draft with text or an image is a card at the top of the
sidebar's Active list, newest edit first, on every device, live. Picks alone
never make one. A card looks like a session's (project, first line, provider
and branch), filled with the draft tint and labelled Draft where a session
shows its status. The provider is the one the draft's composer will run,
chosen by the same rule (`resolveDraftProvider` in
`providers/draft-provider.ts`): the pick, else the project's last-run
provider, else the default, and of those only one the project still offers
and is not known to be broken. The open draft's card takes the selection fill a session
card takes (`bg-active`) instead of a deeper tint, so selection reads the
same whatever the card is; its Draft label still says what it is. Cards only show where the environment keeps drafts and the
host gives each its own page (`navigateDraft`); elsewhere (desktop, the
localStorage fallback) `useSidebarDrafts` is null and nothing shows.

- **The draft on screen.** A draft that had a card when it was opened keeps
  it, selected, as a snapshot taken at that moment: typing does not repaint
  or reorder it, and it updates (and moves to the top) when the draft is
  left. A draft first written on this page has no card until it is left.
  Clicking a card therefore never makes it vanish. Once the draft on screen
  is a session, or is gone (deleted on another device, or emptied here), the
  snapshot is dropped: typing there again starts a draft that gets a card
  when it is left.
- **Order** compares an edit waiting on this client (its clock) with saved
  copies (the environment's clock). A skewed clock can misorder two drafts
  edited moments apart on different devices; nothing worse, so no shared
  clock is kept for it.
- **Opening** a card goes to `/drafts/<id>` through the host, everything as
  it was left, as picking a session does.
- **Sending** swaps the card for the session's. Cards are keyed by the session
  id minted with the draft, and a draft is no card from the update that lists
  its session, so the same row turns from draft to session in one frame,
  with nothing folding away or growing in. As drafts sit above sessions, that
  row then slides (a `layout="position"` animation on every Active row,
  in one `LayoutGroup`) below the drafts still waiting, instead of jumping.
  A draft being sent keeps its card meanwhile, and offers no discard: no ✕,
  no menu, and `discardDraft` does nothing. It becomes a session or comes
  back whole. The draft on screen, while it is sent, shows what is being sent
  in its snapshot's place, not the snapshot. The composer empties the box
  before the send is held, so the text is taken as the send begins
  (`beginSend(key, sentText)` → `DraftEdit.sent`), not read back from the
  emptied edit or the last autosave. Whether a draft is being sent is its own
  fact, apart from whether there is a card to show: with nothing to show of
  what is sent, the snapshot stays, still with no discard.
- **Discarding** (✕ on hover and always on touch, or the card's menu, by
  right click or the menu key) hides the card at once and shows an undo
  notice. The draft is deleted only when the notice goes (6 s, held while the
  pointer or focus is on it, each counted apart), is dismissed (✕ or Escape),
  another draft is discarded, or the page goes (`pagehide`, or `freeze`).
  Hiding the page is not going: a tab switch keeps the undo, and the 6 s run
  on meanwhile. The flush listens in the capture phase, so the deletion is in
  the state before the host's own `pagehide` files it away for the next
  load. Undo just shows the card again. Discarding the draft on screen takes
  the page to a blank `/`, pushed rather than replacing the draft's
  address: Back returns to the draft, and returning to it before the
  deletion cancels it.
- **A double click discards one draft.** After a pointer discard the next
  card slides up under the pointer, its action showing: another draft's ✕, or
  the Settle of the session below the last draft. Until the pointer moves
  away (more than 4 px, or 1.5 s pass, for touch), every card's action is
  hidden and a pointer click on one at the same spot is ignored. Keypresses
  are never held back. A discard is let go in one place (`releaseDraft` in
  `environment-sidebar-drafts.tsx`). Its images go with the draft, freed by
  the environment in the delete itself (see "Images").
- **A discard is of what the user saw, and the environment judges it.** The
  delete a discard sends is conditional (`draft.delete` with `ifRevision`,
  protocol v15): it names the revision the discard was made on, raised by the
  answers to this page's own saves since (a closing save of the last
  keystrokes, one on the wire when the user typed on, one queued ahead of the
  delete). If the draft has a later revision when the delete arrives, written
  by anyone else (more text, another model or mode alone, a restore after a
  failed send, another tab of the same browser), the environment refuses it
  with `DraftChangedDetails`; the draft stays as written, the page drops its
  delete, and the card comes back. No unconditional delete (a clear, a send)
  changes.

  The page never guesses who wrote a revision. Only answers raise the
  revision a delete names, never announcements, so a revision the page cannot
  account for (another device's, or its own whose answer was lost with the
  connection) makes the environment refuse the delete: at worst the card comes
  back, and text written elsewhere is never deleted. An edit the page holds
  and never writes (stalled as too large) protects nothing either, as the
  delete still names only answered revisions. The same holds offline: the
  delete reaches the environment on reconnect and is judged against the draft
  as it is then. One case deletes text written elsewhere, by design: another
  client saved exactly what this page saved, the environment answered this
  page's save with that revision (an identical save is a no-op), and the
  discard then deletes identical content.

  During the window the notice goes at once only if the draft is gone (sent,
  or deleted elsewhere): there is nothing left to take. A draft written
  elsewhere meanwhile keeps its notice until the window ends; the refusal then
  brings its card back.
- **The undo notice** is mounted by the host at the shell, beside the sidebar
  rather than in it: on a phone the sidebar is a modal sheet that closes, and
  would unmount the notice, on the very tap that reaches for Undo. The
  notice's own root takes the pointer through the sheet's inert page. With
  the sidebar open on a wide screen it rests just above the sidebar's footer
  (Settings and the like stay uncovered); on a phone, or with the sidebar
  folded away, it floats just above the composer, clear of its corners. The
  composer and the footer register themselves (`noticeAnchorRef` in
  `lib/notice-anchors.ts`) and are measured through resize observers, so a
  composer that mounts after the notice (back from a child transcript)
  moves it. Every mounted element of a kind stays registered, newest in use:
  the phone's sheet mounts a second sidebar footer, and when it goes the wide
  screen's footer is the one to clear again. Its `role="status"` region is always mounted and the notice is
  swapped inside it, so each discard is announced. A discard made from the
  keyboard puts focus on Undo; one made with the pointer leaves focus alone.
  On a phone that discard was made in the sidebar's sheet, a modal that
  traps focus, so the sheet closes first and focus moves once it has let go.
  Closing it is safe now the notice lives beside the sheet, and it is what a
  tap on the notice does anyway; keeping focus in the sheet would leave Undo
  out of the keyboard's reach. A notice replaced by the next discard plays
  its way out inert (no pointer, focus or screen reader), and its actions
  name its own discard's key, so a click mid-fade acts on nothing.
  Closed from inside with focus on it, focus goes to the first of these the
  user can see (`checkVisibility`: the wide screen's sidebar stays mounted,
  hidden, below its breakpoint): the card that came back (Undo), the card
  that was beside the discarded one, the card list, the control that opens
  the sidebar (on a phone, where the sheet closed for the notice; it is not
  reopened), the composer. Never the page body.
- **The card's menu** hangs from a hidden point, so on close focus goes back
  to the card, not to that point (where Enter would reopen the menu). The
  card does not claim `aria-haspopup`: its own action is opening the draft.
- **A removed project** (`workspaceId` null, or no longer listed) shows "No
  project"; a missing or inaccessible folder is struck through with its badge,
  as on session cards. Both open normally, and the page offers another
  project.
- **Not synced** shows as a quiet cloud mark, with the composer's reason on
  hover (`selectDraftSyncStatus`; nothing while merely saving).

A session whose composer holds unsent text or an image gets a pen in the
draft accent beside its provider, on every device, settled rows included. No
fill: a tinted session card read as one more draft. Sending or
clearing the text removes it. The session on screen never shows it: its
composer is the one being typed in, and a mark that came and went with each
emptied line would flicker, just as the open draft's card stays frozen.

Typing never re-renders the sidebar. The cards are read with an equality that
ignores the draft on screen (its card is the snapshot), the unsent marks are a
sorted list of session ids that ignores the session on screen, and both change
only when a card's content or a draft's has-text fact does.

## Not yet

- An image taken out of a session's draft stays with the session until the
  session is deleted: nothing frees a session's own unsent uploads yet.
- A draft's address leads to its session only when this browser sent it, or
  had its page open when another device did. Otherwise its old address opens
  a blank page.
- If a send's response is lost after the session was created, the restored
  draft can come back next to the new session. Sending it again is refused,
  because the session id is taken.
