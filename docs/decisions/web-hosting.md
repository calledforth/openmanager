# Web hosting: independently hosted static SPA

Status: Accepted, 2026-09-06. Recorded from [CAL-19](https://linear.app/calledforth/issue/CAL-19/decision-web-hosting-model-served-by-environment-server-vs-static-host).

## Decision

Use an independently hosted static SPA as the canonical OpenManager web client.

The browser application is deployed separately from environment servers (for example Cloudflare Pages or Vercel). Environment servers expose the OpenManager API, WebSocket, bootstrap, and pairing surfaces; they do not own the canonical frontend.

## Context and rationale

OpenManager is a multi-environment client. A single stable frontend origin gives one environment registry, one browser storage and cache space, and one pairing surface, instead of fragmenting state across per-environment frontend URLs.

Serving the SPA from each environment removes CORS only for the trivial one-client/one-environment case. As soon as one client needs to reach another environment, cross-origin networking and explicit trust are required anyway. Designing that correctly is part of the intended architecture.

## Alternatives considered

| Alternative                         | Assessment                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Serve the SPA from each environment | Attractive for same-origin requests, but fragments client state and pairing across frontend URLs. Cross-environment access still needs CORS and origin validation. |
| Environment-server reverse proxy    | Could hide CORS for one environment. The canonical client still talks to many environments, so the extra hop does not remove origin policy from the architecture.  |

## Route selection

For each known environment, the client stores environment identity separately from available routes and chooses a reachable route at runtime.

Initial priority:

1. localhost / loopback when reachable from the client device
2. Cloudflare route as fallback

If the browser is on the same machine as the environment server, localhost should normally win. On another device, localhost points at that device and will fail, so the client falls back to Cloudflare.

Hosted-web → localhost access is permission-gated rather than guaranteed. If local access is unavailable or denied, route selection falls back.

## Origin and security consequences

- CORS and origin rules are an explicit part of the environment-server security model.
- WebSocket upgrade origins must be validated as well.
- CORS/origin approval is not authentication; environment access still requires an authorized-client credential.
- Credentials belong to the trusted environment/client relationship, not to a particular raw route URL.
- CSP and allowed-origin policy should account for the canonical hosted frontend and later desktop client origin.

## Static hosting implications

The static host serves the built frontend assets only. Runtime API/WebSocket traffic goes directly from the browser to the selected environment route. The host does not proxy that traffic unless we later add functions or proxies on purpose.

## Desktop implications

The Electron application is another OpenManager client, not another environment server. It should package the same shared React/Vite application and add desktop-only adapters such as windows, notifications, and updates. It does not need to run its own localhost web server merely to host the UI.

## Electron reuse of the same entry

The browser entry is `apps/web/index.html` → `src/main.tsx`. `pnpm --filter @openmanager/web build` writes a static `apps/web/dist/` tree (`index.html`, hashed `/assets/*`, and the Cloudflare/Netlify SPA fallback `_redirects`).

Later Electron should load **that same bundle**, not a forked renderer:

1. **Packaged desktop:** register a custom protocol (for example `openmanager://`) that serves `dist/` at `/`, then `BrowserWindow.loadURL('openmanager://-/')`. Keep `nodeIntegration: false` and expose desktop APIs only from preload adapters. A raw `file://` `loadFile` will not resolve `/assets/...` or history routes such as `/settings`.
2. **Dev / hosted:** `loadURL` of Vite (`http://127.0.0.1:5173`) or the canonical static host. Same entry, same router.
3. **Adapters only:** windows, notifications, updates, and filesystem stay outside `apps/web`. ESLint `no-restricted-imports` and the post-build `check-browser-bundle` script reject Node/Electron imports in this package.

`base` stays `/` so the independently hosted SPA keeps stable asset URLs on nested routes.

## Local fallback UI

An environment-served local or recovery UI may be added later for setup, offline recovery, or debugging. That is a convenience, not the canonical product architecture.

## Build and deploy

- Web build: `pnpm --filter @openmanager/web build` emits static Vite output in `apps/web/dist`, then scans that tree for Node/Electron-only imports.
- Static host: publish `apps/web/dist`. Cloudflare Pages / Netlify use `_redirects` (`/* → /index.html 200`). Vercel uses `apps/web/vercel.json` rewrites. Existing files are served first; unknown paths fall back to the SPA.
- Environment server: API/WebSocket/bootstrap/pairing endpoints only for the canonical architecture.
- Multi-environment client state remains owned by the client and keyed by stable environment identity, not frontend URL.
- CI already runs this path in `.github/workflows/ci.yml` (`pnpm run ci:web`).

## Related records

- Browser stack: [web-browser-stack.md](./web-browser-stack.md)
- Environment server runtime: [environment-server-runtime.md](./environment-server-runtime.md)
