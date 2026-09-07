# OpenManager

Desktop GUI for managing OpenCode agent sessions. Electron + React + Convex.

## Setup

```bash
# Install dependencies (requires pnpm: https://pnpm.io)
pnpm install

# Initialize Convex (requires Convex account)
pnpm convex:dev

# Point local development at the deployment (saved settings override this value)
# .env.local: CONVEX_URL=https://your-deployment.convex.cloud

# Start development
pnpm dev
```

## Environment server + web

The headless environment server and the browser shell are a separate local
workflow from Electron. One command starts both with hot reload:

```bash
pnpm install
pnpm dev:web
```

That launches:

- **Environment server** at `http://127.0.0.1:43120` (`node --watch`, restarts on server edits)
- **Web SPA** at `http://127.0.0.1:5173` (Vite HMR)

The combined command allows the Vite origins (`http://localhost:5173` and
`http://127.0.0.1:5173`) so the browser can call bootstrap and upgrade a
WebSocket. Environment selection in the shell is later Wave 1 work; until then
the two processes still run together so that wiring can be built against a live
server.

`pnpm dev` remains the Electron desktop workflow. To run either process alone:

```bash
pnpm --filter @openmanager/server dev --allowed-origin http://localhost:5173
pnpm --filter @openmanager/web dev
```

See [`apps/server/README.md`](apps/server/README.md) and
[`apps/web/README.md`](apps/web/README.md) for configuration and checks.

## Convex deployment configuration

Development builds use `CONVEX_URL` from `.env`/`.env.local` as a default. You can override it from
**Settings → Convex deployment**; the app tests the deployment and saves the URL on that device.

Packaged builds do not embed a Convex deployment URL. On first launch, OpenManager asks for the
deployment URL and restarts after verifying the OpenManager Convex schema. The URL is an endpoint,
not a secret—never enter a deploy key or admin token in the app.

## Scripts

| Command                                    | Description                              |
| ------------------------------------------ | ---------------------------------------- |
| `pnpm dev`                                 | Start Electron + Vite dev server         |
| `pnpm dev:web`                             | Start environment server + web SPA       |
| `pnpm build`                               | Production desktop build                 |
| `pnpm typecheck`                           | TypeScript strict check                  |
| `pnpm lint`                                | ESLint                                   |
| `pnpm test`                                | Vitest                                   |
| `pnpm run ci:desktop`                      | Desktop typecheck + lint + test          |
| `pnpm run ci:protocol`                     | Protocol build + typecheck + lint + test |
| `pnpm run ci:server`                       | Server typecheck + lint + test + build   |
| `pnpm run ci:web`                          | Web typecheck + lint + test + build      |
| `pnpm dist:win`                            | Build Windows installer + portable app  |
| `pnpm release:prepare <version>`           | Synchronize desktop release versions    |
| `pnpm convex:dev`                          | Start Convex dev server                  |
| `pnpm storybook`                           | Start Storybook UI playground            |
| `pnpm storybook:build`                     | Build Storybook static site              |
| `pnpm mobile`                              | Start the mobile Expo/Metro dev server   |
| `pnpm mobile:android`                      | Build + launch the mobile app on Android |
| `pnpm --filter @openmanager/web dev`       | Start the browser SPA                         |
| `pnpm --filter @openmanager/web typecheck` | Typecheck the web app                         |
| `pnpm --filter @openmanager/web test`      | Vitest for the web app                        |
| `pnpm --filter @openmanager/web build`     | Production web bundle                         |

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for full design rationale.

- **Desktop app** — `apps/desktop`, including Electron main/preload and the current renderer
- **Web app** — `apps/web`, a Vite SPA that boots in a normal browser without Electron or Convex
- **Environment server** — `apps/server`, the headless Node 24 process that owns local execution
- **Main process** — sidecar lifecycle management
- **Preload** — typed IPC bridge (context-isolated)
- **Renderer** — React UI with direct OpenCode HTTP/SSE + Convex sync
- **Mobile app** — `apps/mobile`, an Expo (React Native) Convex-only controller; reactive
  queries for data, `pending_jobs` for actions. The desktop app is the sole OpenCode
  worker. See [`apps/mobile/README.md`](apps/mobile/README.md).
- **Shared contracts** — `packages/shared`, domain types and boundary interfaces
- **Convex** — `packages/convex/convex`, cloud DB schema and functions

## Releases

The new headless environment server has its own [setup and checks](apps/server/README.md).
It runs on Node 24 LTS; the current desktop workflow above remains available.
`.github/workflows/ci.yml` runs typecheck, Vitest, and build for the protocol
package, the server (Node 24 on Linux and Windows), and the web app, in addition
to the existing desktop pipeline.

CI, Windows packaging, public GitHub Releases, and application updates are documented in
[`docs/RELEASING.md`](docs/RELEASING.md).

## UI layout

- `apps/desktop/src/renderer/src/components/chat` — chat surface and input components
- `apps/desktop/src/renderer/src/components/sidebar` — sidebar components
- `apps/desktop/src/renderer/src/components/parts` — message-part renderers (tool/text/reasoning)
- `apps/desktop/src/renderer/src/stories` — Storybook stories and playground screens
- `apps/mobile/src/app` — expo-router screens (sessions home, chat, settings)
- `apps/mobile/src/components` — mobile UI, including `parts` message-part renderers mirroring desktop
- `apps/mobile/src/data` — typed Convex hooks and job actions (mobile data layer)
