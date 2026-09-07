# OpenManager web

Browser SPA for OpenManager. It boots without Electron globals and without a Convex URL. The environment server is the backend; this package is the independently hosted client shell. See the [browser stack decision](../../docs/decisions/web-browser-stack.md).

From the repository root, the usual local workflow starts the environment
server and this shell together:

```sh
pnpm install
pnpm dev:web
```

That is `http://127.0.0.1:5173` for the SPA and `http://127.0.0.1:43120` for
the server, with the Vite origins already allowed. The short filter
`pnpm --filter web dev` still starts only this package.

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
