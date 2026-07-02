# OpenManager

Desktop GUI for managing OpenCode agent sessions. Electron + React + Convex.

## Setup  

```bash
# Install dependencies (requires pnpm: https://pnpm.io)
pnpm install

# Initialize Convex (requires Convex account)
pnpm convex:dev

# Start development
pnpm dev
```

## Scripts

| Command                       | Description                         |
| ----------------------------- | ----------------------------------- |
| `pnpm dev`                    | Start Electron + Vite dev server    |
| `pnpm build`                  | Production desktop build            |
| `pnpm typecheck`              | TypeScript strict check             |
| `pnpm lint`                   | ESLint                              |
| `pnpm test`                   | Vitest                              |
| `pnpm ci`                     | typecheck + lint + test             |
| `pnpm convex:dev`             | Start Convex dev server             |
| `pnpm storybook`              | Start Storybook UI playground       |
| `pnpm storybook:build`        | Build Storybook static site         |
| `pnpm --filter @openmanager/desktop build` | Build only the desktop app |

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for full design rationale.

- **Desktop app** — `apps/desktop`, including Electron main/preload and the current renderer
- **Main process** — sidecar lifecycle management
- **Preload** — typed IPC bridge (context-isolated)
- **Renderer** — React UI with direct OpenCode HTTP/SSE + Convex sync
- **Shared contracts** — `packages/shared`, domain types and boundary interfaces
- **Convex** — `packages/convex/convex`, cloud DB schema and functions

## UI layout

- `apps/desktop/src/renderer/src/components/chat` — chat surface and input components
- `apps/desktop/src/renderer/src/components/sidebar` — sidebar components
- `apps/desktop/src/renderer/src/components/parts` — message-part renderers (tool/text/reasoning)
- `apps/desktop/src/renderer/src/stories` — Storybook stories and playground screens
