# @openmanager/mobile

Expo (React Native) client for OpenManager. The phone reaches an environment
server the same way the web client does: the HTTP bootstrap, the WebSocket
handshake, commands and events, all through `@openmanager/environment-client`
and the shared logic in `@openmanager/app-core/logic`. Nothing on the server
is phone-specific.

Android-first (the project owner develops on Windows); iOS bundles too but is
untested on a device.

## Setup

```bash
# From the repo root: installs the whole workspace (pnpm only)
pnpm install

# Start the Metro dev server
pnpm mobile
```

There is no deployment URL to configure. The phone keeps the environments it
is paired with in its own storage; the connection controller's
`saveEnvironment` takes what a pairing exchange answers. (The pairing screens
themselves are not built yet.)

## Scripts

Run from the repo root:

| Command               | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `pnpm mobile`         | Start the Expo/Metro dev server (`expo start`)        |
| `pnpm mobile:android` | Build + launch on a connected Android device/emulator |
| `pnpm run ci:mobile`  | Typecheck, lint and unit-test the app                 |

Package-local scripts (via `pnpm --filter @openmanager/mobile <script>`):
`start`, `android`, `ios`, `web`, `typecheck`, `lint`, `test`, `test:live`.

`test:live` drives the phone's connection controller against a running
environment server; see `live/handshake.live.ts` (pairing, origin, lifecycle) and
`live/sessions.live.ts` (the home and a read-only thread through a live provider turn) for the
variables they read. `live/recovery.live.ts` starts its own server on a side port (43420 by
default) behind switchable LAN and tunnel forwarders and records the recovery matrix: airplane
mode, LAN to tunnel, the tunnel down (HTTP 530) and back, a server restart, and a revocation
followed by pairing again.

`EXPO_PUBLIC_FIXTURE=1` shows the dev fixture on a phone with nothing paired (the home's
sessions and drafts from `src/home/fixture.ts`, a session page from a recorded thread); without
it an unpaired phone shows the empty home.

## Releases

Every merge to `dev` that can change the app publishes a signed APK, and installed copies offer
it on the home and in Settings. See [Mobile releases](../../docs/RELEASING.md#mobile-releases).
Local builds have no updater; `src/updates/distribution.ts` is the switch.

## Installing dependencies

Do **not** use `pnpm dlx expo install` in this workspace: it shells out to
`npm`, which rejects the `workspace:*` protocol. Add packages with pnpm's
workspace filter, pinned to the SDK-compatible version from
`apps/mobile/node_modules/expo/bundledNativeModules.json`:

```bash
pnpm --filter @openmanager/mobile add <pkg>@<sdk-compatible-version>
```

## How the phone connects

- **Entry.** `index.ts` imports `src/environment/polyfills.ts` before
  expo-router: `react-native-url-polyfill` (React Native's `URL` lacks the
  accessors the endpoint helpers read), `AbortSignal.timeout` (the route
  probes give up through it) and `crypto.randomUUID`, a version 4 UUID from
  expo-crypto's random bytes (app-core mints draft and session ids with it).
- **Root provider.** `src/environment/PhoneEnvironmentProvider.tsx` owns the
  connection controller, hands its client to app-core's
  `EnvironmentClientProvider`, and mounts `EnvironmentApplicationProviders`
  with the phone's device storage and app-exit hook once the environment has
  accepted the client. Screens read `usePhoneConnection()`.
- **Controller.** `src/environment/controller.ts` picks the selected
  environment, searches its routes local network first, bootstraps, and opens
  one environment client on the route that answered. It holds (no socket, no
  timers) while the app is in the background or the device is offline, and
  searches again when the app is back or the network returns. A refused token
  or a protocol mismatch waits for a person; nothing retries it. Each socket
  sends the environment's app origin (the pairing link's origin) as `Origin`,
  the value the environment's `--allowed-origin` lists
  (`src/environment/app-origin.ts`).
- **Storage.** `src/storage` (see its README): the registry in AsyncStorage,
  each credential in SecureStore. The controller waits for `hydrate()`, reads
  and writes the whole registry through the shared registry functions, and
  after a refused token's latch forgets the token once its own environment is
  known to have refused it.
- **Metro.** `metro/resolve-request.js` lets Metro load the workspace
  packages' TypeScript source (NodeNext `./x.js` imports of `x.ts` files) and
  keeps one React in the bundle under pnpm's isolated linker.
  `OPENMANAGER_METRO_RESOLVER_LOG=1` prints every rewrite.

## Pairing

`src/app/pair.tsx` is a modal in the root Stack, opened from the top row of Settings and from the
sessions home while nothing is paired. Two doors: scan the QR code web's Pair-device dialog shows
(`expo-camera`, QR only, `src/pairing/ScanPanel.tsx`), or paste its link (a field with a paste from
clipboard button). Both go through the same core in `src/pairing/`, which never keeps the link or
the token anywhere but memory:

- **Read** (`link.ts`): the shared `parsePairingLink`, plus the app origin, the origin of the
  link's own URL, which the controller sends as the socket's `Origin`.
- **Plan** (`flow.ts`, `planPairing`): with no token for the link's environment, **exchange** the
  link's token at `POST {route}/pair` (shared `exchangePairingToken`) and save through
  `controller.saveEnvironment` (token to SecureStore, route, label and `appOrigin` to the
  registry). With a token, **redeem** the link over the phone's own socket (`pairing.redeem`),
  never at the link's route; if the link's address is new to the environment, the shared rule
  (`classifyDiscoveredRoute`, exposed as `controller.classifyRoute`) says the saved token would go
  there, so the address is first checked to answer as that environment, then the person is asked,
  and only an agreed address joins (`controller.addRoute`, as the last route).
- **Refusals** (`failures.ts`): every reason the environment reports reads as web's shared
  message, with a title and a next step (a new link, try again, or close); unreachable, another
  environment answering, rate limits and links this app cannot read are told apart too.
- **Label** (`device-label.ts`): the phone's model name from `expo-device`, editable; a link made
  with a name keeps that name.

After pairing, the sheet names the route the controller connected through
(`src/environment/connected-route.ts`), and the home's environment line reads the controller's
label and route kind (LAN or Tunnel); with nothing paired the home offers pairing. `live/pairing.live.ts` drives the core against a real
server.

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

What the home shows comes through `src/home/source.ts`: the shared sidebar providers of the paired
environment (`SidebarDataContext`, `SidebarSessionsContext`, `useSidebarDrafts`), normalised there
into the shell's shapes (the workspace groups become one list of rows that each know their
workspace; every status, title and settle passes through as the environment served it), with the
environment line (label, route kind, connected) from the phone's controller. The fixture
(`src/home/fixture.ts`, the owner's own session titles) is the source only with nothing paired and
`EXPO_PUBLIC_FIXTURE=1`. A session's status mark is the web
sidebar's own mapping: `statusMarkOf` calls `sessionBusyTone` from app-core
(`packages/app-core/src/components/sidebar/session-busy-tone.ts`, pure and import-free so Metro reads
it), so `done`, `busy`, `ready` and the rest read the same on both, and a status with no glyph is the
ring at rest. The pure logic in `src/home/rows.ts` (status marks, tab membership, Active groups and
day groups, trees ranked by their most urgent member and dated by their newest, child nesting),
`src/home/search.ts` and the source's normalisation are unit-tested.

A row opens `src/app/session/[externalId].tsx`, read-only for now (the composer comes later).
`src/session/useReadOnlySession.ts` opens it as web's session route does: `session.open` once the
socket is up, the snapshot and then the live events through the shared active-thread provider, and
`setActiveSession(null)` when the page goes, which releases its subscriptions. It never asks for
`session.history`. A `done` session on screen is acknowledged on the environment
(`acknowledgeSessionDone`), which is what clears it. The rows (`src/components/chat/*`) read each
message from the shared stores, so a streamed token re-renders only its own row: markdown, reasoning
collapsed, bare tool rows (name and status), images through `fetchArtifact`.
`src/session/thread-rows.ts` is the pure mapping; `tests/read-only-thread.test.tsx` mounts the
shared providers over the mock environment client and checks the snapshot, a live turn, the
acknowledgement, child sessions and the release, with no history call.

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

The screens in `src/app` and `src/components` predate the environment
connection. Their data hooks in `src/data` are inert placeholders until the
screens move onto the shared logic.
