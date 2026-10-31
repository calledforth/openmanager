# Phone mockups

Phone-frame HTML mockups (390×844, dark and light) for the native OpenManager
client. Open any file in a browser; the frames marked _interactive_ respond to
taps. The frames use web's token names (`--bg`, `--fg`, `--muted`, `--faint`,
`--hover`, `--active`, the `--status-*` set and the float-shadow recipe) with
values copied by hand from `packages/app-core/src/styles/globals.css` and
`fluid.css` for the Neutral family. They are a design reference, not the
pipeline's output: the generated token map (CAL-306) is the source of truth on
the phone, and the six families on the Settings frame are the ones
`theme-families.ts` declares.

| File                                  | Frames                                                                                                                                                                                                                                                                                         | Screen issues             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `01-home-and-session.html`            | Sessions home (dark, light); session page working (dark) and needing you (light)                                                                                                                                                                                                               | CAL-307, CAL-308          |
| `02-composer-and-pickers.html`        | Four placements for the model/mode/effort picks (A header chips, **B composer picks row — interactive**, C one summary chip, D pulled-up composer); model sheet; effort and mode popovers; full-screen composer with tray and keyboard                                                         | CAL-309                   |
| `03-environments-pairing-drafts.html` | Settings home; environment detail; pairing (**interactive**: scan QR or paste a link → connecting → paired); drafts tab; project picker sheet                                                                                                                                                  | CAL-310, CAL-311, CAL-313 |
| `04-inbox-and-search.html`            | Inbox (dark: needs you grouped by permissions, questions and plans, the first row answerable inline; done-unseen with swipe to mark seen; failed), inbox all clear (light); search with a typed query and highlighted matches (dark); search with an empty field, recents and projects (light) | CAL-307, CAL-303          |

## Decisions

Reactions recorded from the owner's review, 2026-10-20/21.

### Liked as-is

- The whole of file 01 ("I love everything"): the floating pill nav, big title
  with segmented tabs, inbox-style session rows with a status mark on the left
  and age on the right, the session page with a docked composer, user bubbles
  as fills, work groups that fold tool calls, and the composer that _becomes
  the prompt_ when a permission or question is pending (Allow / Always / Deny
  inside the composer, nothing modal).
- Glass. Every floating surface (pill nav, search button, icon buttons, the
  docked composer, sheets, popovers, the jump-to-latest button) is translucent
  with a backdrop blur, and content runs under it with a soft fade. Recipe:
  `--glass` / `--glass-strong` / `--glass-sheet` per scheme, blur 18–32 px,
  saturate 1.5–1.7, plus the float shadow. On the phone this is a BlurView fed
  by the same colours; it is the one piece of the design that is a
  per-platform recipe rather than a token.

### Changed from the first draft

- **Picks moved out of the header.** The first draft (frame A in file 02) put
  provider, model, mode and effort as chips under the session title. The owner
  wants the top as clear as possible, so the header is back to title + project
  only. The picks live in the composer: **B at rest** (a picks row under the
  text field: provider icon, model ▾, mode, effort, context meter), **folding
  to C while a turn runs** (one summary chip inside the field so the row of
  controls doesn't sit beside a stop button). Tapping a pick opens the same
  bottom sheet (model, project) or popover (mode, effort) from the dock or the
  new-session page. Rarer settings (config options, titles) go under the
  session's ⋯ menu.
- **No full-screen composer** (2026-10-31; supersedes frame D and the
  full-screen frame in file 02). In a chat you write in the dock: the keyboard
  lifts it, the field grows to six lines, and the transcript stays in view. A
  new session's page _is_ the composer: header, "Let's build in" project picker
  and environment on top, the text filling the page, the picks and send as a
  tray above the keyboard.
- **Pill nav is Sessions · Inbox · Settings**, with search as a detached
  button beside it and _compose_ top-right in the header, after Linear iOS.
  The project issue said "sessions, new, settings"; Inbox (everything waiting
  on you, with a badge) earned the slot instead because that is what you open
  the phone for.
- **Home tabs are All · Active · Drafts** rather than Active · Settled ·
  Drafts; settled sessions are the long tail of All, grouped by day.
- **Status marks** are one small glyph per state, not coloured text: working
  (violet spinner), background (blue, slower spinner), needs you (amber "!"),
  question (pink "?"), done (green tick), error (red ×), idle (hollow ring).
  Colours are `--status-*`.
- **Inbox answers in place.** A permission or a question in the inbox
  expands to its Allow / Always / Deny (or the question's choices) on the row
  itself; a plan or a finished session opens the session. A done row is
  swiped to mark it seen, and the pill badge is the needs-you count.
- **Search is a layer, not a tab.** The detached search button opens it over
  whatever you were on; results reuse the session and project rows with the
  match highlighted. Title and project only, which is what the environment
  indexes; transcript search waits for server support.

### Still open

- Tool-row detail (inputs, outputs, outcomes) waits for the server-side work
  on tool payloads and notices (CAL-315).
- Whether the drafts tab shows other environments' drafts inline or behind a
  row (file 03 shows a row).

## Conventions these frames fix

- Fills, not borders: selection and grouping are colour fills (`--hover`,
  `--active`); rules only where a list needs one.
- Provider identity is the icon, never a word.
- Server-owned facts are shown, never inferred: routes and their health, which
  one is in use, pending interactions, session status.
- Pairing has two doors and nothing else: scan a QR code or paste a link.
  Both end on the same "paired with …" sheet naming the route it landed on.
- Drafts are a tab on the sessions home, scoped to the current environment,
  with a "Not synced" chip when the server has not accepted a save.
