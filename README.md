# OpenManager

Desktop GUI for managing OpenCode agent sessions. Electron + React + Convex.

## Setup

```bash
# Install dependencies (requires Bun: https://bun.sh)
bun install

# Initialize Convex (requires Convex account)
bunx convex dev

# Start development
bun run dev
```

## Scripts

| Command                   | Description                      |
| ------------------------- | -------------------------------- |
| `bun run dev`             | Start Electron + Vite dev server |
| `bun run build`           | Production build                 |
| `bun run typecheck`       | TypeScript strict check          |
| `bun run lint`            | ESLint                           |
| `bun run test`            | Vitest                           |
| `bun run ci`              | typecheck + lint + test          |
| `bun run convex:dev`      | Start Convex dev server          |
| `bun run storybook`       | Start Storybook UI playground    |
| `bun run storybook:build` | Build Storybook static site      |

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for full design rationale.

- **Main process** — sidecar lifecycle management
- **Preload** — typed IPC bridge (context-isolated)
- **Renderer** — React UI with direct OpenCode HTTP/SSE + Convex sync
- **Shared contracts** — domain types and boundary interfaces
- **Convex** — cloud DB schema and functions

## UI layout

- `src/renderer/src/components/chat` — chat surface and input components
- `src/renderer/src/components/sidebar` — sidebar components
- `src/renderer/src/components/parts` — message-part renderers (tool/text/reasoning)
- `src/renderer/src/stories` — Storybook stories and playground screens
