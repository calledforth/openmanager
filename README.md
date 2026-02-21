# OpenManager

Desktop GUI for managing OpenCode agent sessions. Electron + React + Convex.

## Setup

```bash
# Install dependencies
npm install

# Initialize Convex (requires Convex account)
npx convex dev

# Start development
npm run dev
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Electron + Vite dev server |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript strict check |
| `npm run lint` | ESLint |
| `npm run test` | Vitest |
| `npm run ci` | typecheck + lint + test |
| `npm run convex:dev` | Start Convex dev server |

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for full design rationale.

- **Main process** — sidecar lifecycle management
- **Preload** — typed IPC bridge (context-isolated)
- **Renderer** — React UI with direct OpenCode HTTP/SSE + Convex sync
- **Shared contracts** — domain types and boundary interfaces
- **Convex** — cloud DB schema and functions
