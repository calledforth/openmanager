# OpenManager web

Browser SPA for OpenManager. It boots without Electron globals and without a Convex URL. The environment server is the backend; this package is the independently hosted client shell. See the [browser stack decision](../../docs/decisions/web-browser-stack.md).

From the repository root, the usual local workflow starts the environment
server and this shell together:

```sh
pnpm install
pnpm dev:web
```

That is `http://127.0.0.1:5173` for the SPA and `http://127.0.0.1:43120` for
the server, with the Vite origins already allowed and an ephemeral local-owner
claim key shared between the two processes. The short filter
`pnpm --filter web dev` still starts only this package and does not enable
automatic owner claiming on its own.

| Script      | Description                 |
| ----------- | --------------------------- |
| `dev`       | Vite development server     |
| `typecheck` | TypeScript (`tsc --noEmit`) |
| `test`      | Vitest                      |
| `build`     | Production SPA bundle       |
| `preview`   | Serve the production bundle |
| `lint`      | ESLint                      |

## Routes

The information architecture matches the desktop app and the mobile screens, expressed as URLs:

| Path                     | Desktop analog                       |
| ------------------------ | ------------------------------------ |
| `/`                      | New-session landing inside the shell |
| `/sessions/$sessionId`   | Active session / chat workspace      |
| `/settings`              | Settings (theme, font, environment)  |
| `/pair`                  | Where a pairing link lands on a new device |
| `/playground/connection` | Storybook-equivalent connection states |

First-run and terminal failures (no environment, protocol mismatch, unauthorized) replace the main pane. Connecting, reconnecting, and unreachable stay in-shell as a banner so the session UI is not swapped away. States come from the stored environment, `GET /bootstrap` + `evaluateBootstrap`, and connection status — not from a timeout.

Environments are stored by bootstrap `environmentId` as `{ environmentId, label, routes, credential }`, where each route is `{ type, endpoint, priority, health }`. Adding a second URL for the same ID adds a route to that record instead of creating a duplicate, and the token stays with the environment. The route in use is the one you choose; its health and that of the other saved routes are shown in the list and never switch the route for you. Select, remove, use and forget live on the first-run screen and in Settings. See [environment routes](../../docs/environment-routes.md). In the combined local workflow, connecting to a loopback endpoint with a blank token claims `GET /local-owner` with the process-scoped claim key and stores that owner credential on the environment record. A claim whose environment ID differs from bootstrap is rejected visibly. Remote endpoints are never asked for an owner token.

Other devices are paired from Settings → Devices → Pair a device, which makes a single-use link offering the access ticked there and shows it as a QR code and a link to copy. The link opens `/pair` with the route, environment ID and token in the URL fragment, which the page strips from the address bar at once. A browser with no credential for that environment posts the token to `POST /pair` on the link's route and saves the credential it gets back on the environment record, keyed by environment ID; a browser that already has one redeems the link over its own socket instead, so a saved credential is never replaced by, or sent to, an address a link named. Both end in the session list.
