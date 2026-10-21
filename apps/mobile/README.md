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

There is no deployment URL to configure. The phone pairs with an environment
(a pairing link or QR code from web's Settings → Devices) and keeps what it
learned in its own storage.

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
  probes give up through it) and `crypto.randomUUID` from expo-crypto
  (app-core mints draft and session ids with it).
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
  or a protocol mismatch waits for a person; nothing retries it.
- **Storage.** `src/environment/phone-storage.ts` is the seam: a synchronous
  registry store for the shared registry functions, a credential store for
  tokens (kept out of the registry document), and app-core's device storage.
  `phone-storage-instance.ts` picks the implementation; it is in memory until
  the AsyncStorage and SecureStore stores replace it.
- **Metro.** `metro/resolve-request.js` lets Metro load the workspace
  packages' TypeScript source (NodeNext `./x.js` imports of `x.ts` files) and
  keeps one React in the bundle under pnpm's isolated linker.
  `OPENMANAGER_METRO_RESOLVER_LOG=1` prints every rewrite.

The screens in `src/app` and `src/components` predate the environment
connection. Their data hooks in `src/data` are inert placeholders until the
screens move onto the shared logic.
