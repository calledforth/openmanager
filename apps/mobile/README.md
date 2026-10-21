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
environment server; see `live/handshake.live.ts` for the variables it reads.

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
