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
