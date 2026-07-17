# AGENTS.md

## Cursor Cloud specific instructions

OpenManager is a pnpm monorepo (Node 22, pnpm 10.30.3, both preinstalled). Dependencies are
refreshed automatically on startup via `pnpm install --frozen-lockfile`. Standard scripts live in
the root `README.md` / `package.json`; this section only captures the non-obvious gotchas.

### Services / apps
- `apps/desktop` (`@openmanager/desktop`) — **primary product**, an Electron + React + Vite GUI for
  managing OpenCode agent sessions. Run with `pnpm dev` (see headless caveat below).
- `apps/mobile` (`@openmanager/mobile`) — Expo/React Native remote controller (Convex-only). Not
  required to exercise the desktop product.
- `packages/convex` — Convex DB schema + functions. `packages/shared` and `@agentpack/*` are
  libraries (typecheck only).

### Lint / test / typecheck / build
Use the root scripts (documented in `README.md`): `pnpm lint`, `pnpm test`, `pnpm typecheck`,
`pnpm run build`, or the combined `pnpm run ci:desktop`. These run fully headless with no Convex or
OpenCode dependency.

### Running the desktop app headless (important)
- Electron's GPU process fatally crashes in this headless VM (`GPU process isn't usable. Goodbye.`).
  Start dev mode with GPU disabled by passing Chromium flags after `--`:
  `pnpm dev -- --disable-gpu --disable-gpu-sandbox --no-sandbox --disable-dev-shm-usage`
  (electron-vite forwards post-`--` args to Electron.) Without these flags the window may crash
  intermittently on launch.
- A virtual X display is available at `DISPLAY=:1`. Capture screenshots with
  `ffmpeg -f x11grab -video_size 1280x800 -i :1 -frames:v 1 out.png`.
- `ERROR:dbus/...` and GPU-launch log lines are benign in this container.

### Convex deployment (required for the desktop UI)
- On launch the app shows a blocking "Connect your deployment" modal until a Convex URL is
  configured. Provide one of:
  - `CONVEX_URL=<url>` in the workspace-root `.env.local` (gitignored; read only in dev), or
  - Enter the URL in-app via Settings / the config modal. **In-app saved settings override the env
    var**, so if the app connects to the wrong deployment, clear the saved setting.
- For a self-contained, no-account backend: in `packages/convex` run
  `node node_modules/convex/bin/main.js dev` (do NOT use `pnpm convex:dev` for first-time setup — its
  wrapper passes `--env-file` which is non-interactive and skips the anonymous prompt). Choose
  "Start without an account (run Convex locally)"; it serves at `http://127.0.0.1:3210` and deploys
  the schema/indexes. Point the desktop app at that URL. After this, `CONVEX_DEPLOYMENT` is written
  to `packages/convex/.env.local`.

### OpenCode agent (external runtime dependency)
- The `opencode` CLI is not bundled and not installed by the update script. Without it, sessions show
  "Connecting to OpenCode..." and agents never respond, but Convex sync and message-send (which write
  `pending_jobs` to Convex) still work — enough to smoke-test the core UI + backend loop. A full
  agent round-trip additionally requires installing `opencode` and an LLM provider API key.
