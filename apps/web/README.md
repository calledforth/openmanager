# OpenManager web

Browser SPA for OpenManager. It boots without Electron globals and without a Convex URL. The environment server is the backend; this package is the independently hosted client shell. See the [browser stack decision](../../docs/decisions/web-browser-stack.md).

From the repository root:

```sh
pnpm install
pnpm --filter @openmanager/web dev
```

The short filter `pnpm --filter web dev` also selects this package. The dev server is `http://127.0.0.1:5173`.

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

| Path                   | Desktop analog                       |
| ---------------------- | ------------------------------------ |
| `/`                    | New-session landing inside the shell |
| `/sessions/$sessionId` | Active session / chat workspace      |
| `/settings`            | Settings (theme and font for now)    |

Environment selection, connection states, and protocol bootstrap belong to later Wave 1 issues.
