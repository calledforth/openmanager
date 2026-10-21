# @openmanager/mobile

Expo (React Native) client for OpenManager. A **Convex-only** controller for OpenCode
agent sessions: it subscribes to reactive Convex queries for all data and writes
`pending_jobs` for every action. It never talks to OpenCode directly — the desktop app
remains the sole worker that bridges Convex and the OpenCode sidecar.

Android-first (the project owner develops on Windows); iOS works too via Expo Go / EAS but
is untested.

## Setup

```bash
# From the repo root — installs the whole workspace (pnpm only)
pnpm install

# Configure the deployment URL (see Environment below)
cp apps/mobile/.env.example apps/mobile/.env
# then edit apps/mobile/.env and set EXPO_PUBLIC_CONVEX_URL

# Start the Metro dev server
pnpm mobile
```

### Environment

Configuration is a single public env var, read at bundle time by Expo:

| Variable                 | Where              | Value                                             |
| ------------------------ | ------------------ | ------------------------------------------------- |
| `EXPO_PUBLIC_CONVEX_URL` | `apps/mobile/.env` | The Convex deployment URL (same one desktop uses) |

- `.env.example` is committed as a template; the real `.env` is git-ignored.
- The URL is the only deployment coupling. There is **no** hardcoded deployment URL in the
  source — everything reads `process.env.EXPO_PUBLIC_CONVEX_URL`.
- Auth is intentionally absent in the MVP (personal single-deployment use). See
  [Future work](#future-work).

## Scripts

Run from the repo root:

| Command               | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `pnpm mobile`         | Start the Expo/Metro dev server (`expo start`)        |
| `pnpm mobile:android` | Build + launch on a connected Android device/emulator |

Package-local scripts (via `pnpm --filter @openmanager/mobile <script>`): `start`,
`android`, `ios`, `web`, `typecheck`.

### Running on Android with Expo Go

1. Install **Expo Go** from the Play Store on your Android device.
2. Make sure the phone and dev machine are on the same network.
3. Run `pnpm mobile` from the repo root.
4. Scan the QR code shown in the terminal / Metro web UI with Expo Go.

The app connects straight to Convex, so a session is only controllable from the phone when
its **desktop worker is online** (see the architecture note below). Jobs submitted while the
desktop is offline stay `pending` and are shown as "queued".

> Native builds (`pnpm mobile:android`, `expo run:android`) require the Android SDK. Expo Go
> is the fastest path for day-to-day development and needs no native toolchain.

## Installing dependencies

Do **not** use `pnpm dlx expo install` in this workspace — it shells out to `npm`, which
rejects the `workspace:*` protocol used by our internal packages and fails. Instead add
packages with pnpm's workspace filter, pinning to the SDK-compatible version:

```bash
pnpm --filter @openmanager/mobile add <pkg>@<sdk-compatible-version>
```

Look up the version Expo expects for the current SDK in
`apps/mobile/node_modules/expo/bundledNativeModules.json` before installing.

## Shell

The app is three top-level screens and a layer above them. **Sessions** (`src/app/(tabs)/index.tsx`,
tabs All · Active · Drafts), **Inbox** (`src/app/(tabs)/inbox.tsx`, Needs you · Done · Failed) and
**Settings** (`src/app/(tabs)/settings.tsx`) are an expo-router `Tabs` group
(`src/app/(tabs)/_layout.tsx`) whose tab bar is the floating glass pill (`src/ui/PillNav.tsx`). Each
tab is one instance that keeps its own state and scroll; a pill tap goes through the navigator, so
switching never stacks screens, re-tapping the current tab does nothing, and Android back goes to
Sessions and then out. The pill's Inbox badge is how many sessions need you. **Search**
(`src/app/search.tsx`, a modal pushed by the button detached beside the pill), a session
(`src/app/session/[externalId].tsx`), a draft (`src/app/draft/new.tsx` from the compose button,
`src/app/draft/[draftId].tsx` from a draft row; placeholders until the composer lands) and the theme
preview sit in the root Stack above the tabs. A back or close control returns to the previous screen,
or to the home when a cold deep link left nothing to go back to (`src/ui/goBack.ts`).

The components under `src/ui/` are the phone's design system after `docs/ui-prototypes/mobile/`:
`Glass` (blur + the scheme's translucent floating surface + float shadow), `StatusMark` (one glyph
per session state), `ProviderMark` (a tool as its mark, never its name), `SessionRow`, `DraftRow`,
`SegmentedTabs`, `BigTitle`, `SectionLabel`, `FadeOut`, `IconButton`, `ProjectChip`. The home and
the inbox are `SectionList`s, one section per group.

What the home shows comes through `src/home/source.ts`. Until the phone speaks the environment
protocol it returns a fixture (`src/home/fixture.ts`, the owner's own session titles) in the shared
sidebar's own shapes (`SidebarSessionEntry`, `SidebarDraft`); the sessions-list issue swaps the hook
for the shared sidebar providers without touching the screens. A session's status mark is the web
sidebar's own mapping: `statusMarkOf` calls `sessionBusyTone` from app-core
(`packages/app-core/src/components/sidebar/session-busy-tone.ts`, pure and import-free so Metro reads
it), so `done`, `busy`, `ready` and the rest read the same on both, and a status with no glyph is the
ring at rest. The pure logic in `src/home/rows.ts` (status marks, tab membership, Active groups and
day groups, trees ranked by their most urgent member and dated by their newest, child nesting) and
`src/home/search.ts` is unit-tested.

## Theme

The phone paints with web's tokens, not its own palette. `packages/app-core/scripts/theme-tokens.mjs`
reads `globals.css` and `fluid.css`, resolves the cascade for each `data-theme` scheme (twelve: six
families × light and dark), evaluates the colour maths, and writes
`packages/app-core/src/lib/theme-tokens.generated.ts`. That file is checked in; app-core's
`tests/theme-tokens.test.ts` fails when it is stale, so a token change on web cannot drift from
the phone. Regenerate with:

```bash
pnpm --filter @openmanager/app-core theme-tokens
```

On the phone, `src/theme/tokens.ts` derives a `PhoneTheme` (the roles the screens use: canvas,
ink, muted, faint, hover, active, bubble, float, glass, status colours, shadows) from the generated
map for one scheme, and `themeVars` turns it into NativeWind variables; the colour names in
`tailwind.config.js` all point at those variables. `src/theme/ThemeProvider.tsx` keeps the
appearance (family + light / dark / system) in AsyncStorage under the same key and shape web uses,
resolves the scheme from the OS appearance when the mode is system, and applies the variables on
the root view. `useTheme()` exposes the appearance, the resolved scheme and the `PhoneTheme`;
`usePhoneTheme()` is the shortcut for imperative styles. Settings → Theme → "Preview every scheme"
opens `src/app/theme-preview.tsx`, which paints all twelve.

Pure theme logic is unit-tested with vitest (`pnpm --filter @openmanager/mobile test`); screens
are checked by `tsc` and by bundling (`npx expo export --platform android`).

## Architecture

```
[Mobile (this app)] ──WebSocket──► [Convex] ◄──WebSocket── [Desktop Electron main]
                                                                    │
                                                             [opencode acp]
```

- **Convex-only client.** Mobile has no OpenCode connection. It reads data through reactive
  `useQuery` subscriptions and performs actions by submitting jobs to Convex's
  `pending_jobs`.
- **Desktop is the sole worker.** Only the desktop Electron app polls `pending_jobs`,
  executes them against the OpenCode sidecar, and streams results back into Convex. If no
  desktop worker is online for a session, the mobile UI disables the composer/abort and
  shows a "not connected to a desktop" notice.
- **Routing.** A job targets `session.clientId ?? args.clientId`. Sessions whose `clientId`
  is unset can't be reached from mobile — the UI reflects this as unreachable.
- **Streaming.** Assistant messages are reconstructed from the append-only stream-chunk
  feed, using the exact same algorithm as desktop. The pure reducer/part-merge logic is
  shared via `@openmanager/shared/lib/remote-stream-parts`.

### Where the code lives

- `src/app` — expo-router screens: `index.tsx` (sessions home), `session/[externalId].tsx`
  (chat), `settings.tsx` (theme + deployment info modal).
- `src/data` — typed Convex hooks and actions (the entire data layer; no Convex calls
  outside this directory).
- `src/components` — UI: `chat/`, `parts/` (message-part renderers mirroring desktop's
  `components/parts/*`), and `ui/AppText.tsx` (the single typed text primitive — **all**
  text renders through `AppText` or the markdown styles).
- `src/theme` — `tokens.ts` (the only file with color hex literals), `ThemeProvider.tsx`,
  and NativeWind wiring.
- Shared, platform-agnostic logic (streaming reconstruction, tool metadata/presenter) lives
  in `packages/shared/src/lib` and is imported by both desktop and mobile.

### Convex contract

The exact queries, mutations, job payloads, and the streaming-reconstruction algorithm are
documented in **`docs/mobile-mvp-plan.md` §3** (verified against the Convex source). That is
the source of truth for the client/server boundary. No Convex schema or function changes are
made or needed by this app — it consumes existing functions only.

## Future work

- **Push notifications** — deferred, but the data model already surfaces the trigger points:
  a session flipping to `waiting` (pending permission) or an assistant message finalizing.
  Slot in `expo-notifications`: register the Expo push token on launch, persist it so a
  future Convex function / worker can target it, and deep-link notification taps to
  `/session/[externalId]`. No schema exists for tokens yet — that is the first addition when
  this is built.
- **Auth** — none in the MVP (single personal deployment). When multi-user access is needed,
  add a Convex auth provider (e.g. Convex Auth / Clerk), gate the `ConvexProvider` in
  `src/app/_layout.tsx` behind a sign-in screen, and swap the anonymous mobile `clientId`
  for an authenticated identity in `src/data/client-id.ts`.
