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
| `/playground/connection` | Storybook-equivalent connection states |

First-run and terminal failures (no environment, protocol mismatch, unauthorized) replace the main pane. Connecting, reconnecting, and unreachable stay in-shell as a banner so the session UI is not swapped away. States come from the stored environment, `GET /bootstrap` + `evaluateBootstrap`, and connection status — not from a timeout.

Environments are stored by bootstrap `environmentId` as `{ environmentId, label, endpoints, credential }`. Adding a second URL for the same ID updates that record instead of creating a duplicate. Select and remove live on the first-run screen and in Settings. In the combined local workflow, connecting to a loopback endpoint with a blank token claims `GET /local-owner` with the process-scoped claim key and stores that owner credential on the environment record. A claim whose environment ID differs from bootstrap is rejected visibly. Remote endpoints are never asked for an owner token.
