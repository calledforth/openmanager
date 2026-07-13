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
| `pnpm build`                               | Production desktop build                 |
| `pnpm typecheck`                           | TypeScript strict check                  |
| `pnpm lint`                                | ESLint                                   |
| `pnpm test`                                | Vitest                                   |
| `pnpm ci`                                  | typecheck + lint + test                  |
| `pnpm convex:dev`                          | Start Convex dev server                  |
| `pnpm storybook`                           | Start Storybook UI playground            |
| `pnpm storybook:build`                     | Build Storybook static site              |
| `pnpm mobile`                              | Start the mobile Expo/Metro dev server   |
| `pnpm mobile:android`                      | Build + launch the mobile app on Android |
| `pnpm --filter @openmanager/desktop build` | Build only the desktop app               |

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for full design rationale.

- **Desktop app** — `apps/desktop`, including Electron main/preload and the current renderer
- **Main process** — sidecar lifecycle management
- **Preload** — typed IPC bridge (context-isolated)
- **Renderer** — React UI with direct OpenCode HTTP/SSE + Convex sync
- **Mobile app** — `apps/mobile`, an Expo (React Native) Convex-only controller; reactive
  queries for data, `pending_jobs` for actions. The desktop app is the sole OpenCode
  worker. See [`apps/mobile/README.md`](apps/mobile/README.md).
- **Shared contracts** — `packages/shared`, domain types and boundary interfaces
- **Convex** — `packages/convex/convex`, cloud DB schema and functions

## UI layout

- `apps/desktop/src/renderer/src/components/chat` — chat surface and input components
- `apps/desktop/src/renderer/src/components/sidebar` — sidebar components
- `apps/desktop/src/renderer/src/components/parts` — message-part renderers (tool/text/reasoning)
- `apps/desktop/src/renderer/src/stories` — Storybook stories and playground screens
- `apps/mobile/src/app` — expo-router screens (sessions home, chat, settings)
- `apps/mobile/src/components` — mobile UI, including `parts` message-part renderers mirroring desktop
- `apps/mobile/src/data` — typed Convex hooks and job actions (mobile data layer)
