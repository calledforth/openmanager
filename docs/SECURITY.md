# OpenManager — Security Baseline

## Localhost-Only Assumption

- OpenCode server binds exclusively to `127.0.0.1`
- No inbound port exposure to LAN or internet
- Renderer CSP restricts `connect-src` to self, Convex cloud, and localhost

## Secret Handling

- `OPENCODE_SERVER_PASSWORD`: generated per-session, passed via env var to sidecar, never persisted to disk
- `VITE_CONVEX_URL`: deployment URL, safe to store in `.env.local` (git-ignored)
- No secrets in source code, logs, or IPC payloads

## Explicit Non-Goals

- No PTY parsing or terminal output processing
- No inbound network listener on any public interface
- No bundled OpenCode binary (user installs independently)

## Electron Security Defaults

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: false` (required for preload IPC; may revisit)
- CSP enforced via meta tag in renderer HTML
