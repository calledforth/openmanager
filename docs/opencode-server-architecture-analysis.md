# Open Code Desktop: Server Architecture Analysis

**Purpose:** Understand how the Open Code desktop application handles the Open Code Server—when it boots, how many run, how multi-workspace works, and what components are involved. For comparison with our openmanager desktop app.

---

## 1. High-Level Summary

| Question | Answer |
|----------|--------|
| **When does the server boot?** | At application startup, immediately after `app.whenReady()` |
| **How many servers?** | **One** per desktop application instance |
| **Per workspace?** | No. One server handles **all workspaces** via request-level scoping |
| **Sidecar?** | Yes. A native `opencode-cli` binary runs as a **single sidecar process** |
| **Multi-workspace sessions?** | Same server; requests scoped by `workspace` + `directory` params |

---

## 2. Boot Sequence & Timing

### When the server starts

- **Trigger:** `app.whenReady()` (Electron) in `desktop-electron/src/main/index.ts`
- **Flow:**
  1. `ensureLoopbackNoProxy()` – ensure localhost bypass
  2. `syncCli()` – sync CLI binary if packaged
  3. `initialize()` – main init
  4. `getSidecarPort()` – bind to `127.0.0.1:0` to get a free port
  5. `spawnLocalServer(hostname, port, password)` – spawn sidecar
  6. Wait for health check (`/global/health`) or SQLite migration if needed
  7. Create main window

- **Important:** Server is started on every app launch. There is no lazy or on-demand startup.

### Port allocation

```typescript
// From index.ts - getSidecarPort()
async function getSidecarPort() {
  const fromEnv = process.env.OPENCODE_PORT
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}
```

- Uses `OPENCODE_PORT` if set, otherwise a free port via `listen(0)` on loopback.

---

## 3. The Sidecar Architecture

### What is the sidecar?

- **Binary:** `opencode-cli` (native; likely Rust/compiled)
- **Location:**
  - Packaged: `process.resourcesPath/opencode-cli.exe` (Windows)
  - Dev: `../../resources/opencode-cli`
- **Invocation:** `opencode-cli serve --hostname 127.0.0.1 --port <port>`
- **Environment:** `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD`, `XDG_STATE_HOME`, etc.

### Spawn flow (from `cli.ts`)

```typescript
// cli.ts - serve()
export function serve(hostname: string, port: number, password: string) {
  const args = `--print-logs --log-level WARN serve --hostname ${hostname} --port ${port}`
  const env = {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
  }
  return spawnCommand(args, env)
}
```

- On Windows: direct spawn of `opencode-cli`
- On macOS/Linux: shell wrapper (e.g. `$SHELL -l -c "opencode-cli ..."`)
- WSL: `wsl -e bash -lc "<script>"` when WSL mode is enabled

### Single sidecar constraint

- `let sidecar: CommandChild | null = null` – one sidecar per app
- Killed on `before-quit` and when installing updates
- IPC: `killSidecar` handler for manual kill

---

## 4. How Many Open Code Servers?

**Exactly one server process per desktop app instance.**

- One Electron main process → one sidecar → one Open Code server
- Multiple workspaces/projects share this server
- Request scoping is done with `workspace` and `directory` (query or headers)

---

## 5. Multi-Workspace / Multi-Session Handling

### Request-level scoping (main server)

Every request is scoped by:

- `workspace` (query `workspace` or header `x-opencode-workspace`)
- `directory` (query `directory` or header `x-opencode-directory`, default `process.cwd()`)

```typescript
// server/server.ts - middleware
return WorkspaceContext.provide({
  workspaceID: rawWorkspaceID ? WorkspaceID.make(rawWorkspaceID) : undefined,
  async fn() {
    return Instance.provide({
      directory,
      init: InstanceBootstrap,
      async fn() => next(),
    })
  },
})
```

### Instance model

- **`Instance`** (`packages/opencode/src/project/instance.ts`): per-directory context
- `Instance.provide({ directory, fn })`:
  - Uses a `Map<directory, Promise<Context>>` cache
  - Lazy boot per directory on first use
  - All run in the same process
- Project/sandbox detection via `Project.fromDirectory()` for non-worktree flows

### Workspace routing (experimental)

- `WorkspaceRouterMiddleware` only when `OPENCODE_EXPERIMENTAL_WORKSPACES`
- For remote workspaces, forwards to adaptors (e.g. `WorktreeAdaptor`)
- `WorktreeAdaptor.fetch()` calls `WorkspaceServer.App().fetch()` in-process, not a separate process

### WorkspaceServer vs main server

- `WorkspaceServer` is an alternate Hono app in the same process
- Used when routing to worktree-type workspaces
- No extra processes; same binary, different route handlers

### Concurrent sessions in different workspaces

- Single server process
- Concurrent requests handled by the HTTP server (Bun.serve)
- Each request is scoped to a workspace + directory via `WorkspaceContext` and `Instance.provide`
- No sidecars per workspace; no process-per-workspace model

---

## 6. Core Components

| Component | Location | Role |
|----------|----------|------|
| **Sidecar spawn** | `desktop-electron/src/main/cli.ts` | Spawns `opencode-cli serve` |
| **Server lifecycle** | `desktop-electron/src/main/server.ts` | `spawnLocalServer`, health check |
| **App bootstrap** | `desktop-electron/src/main/index.ts` | Init, sidecar start, window creation |
| **Open Code server** | `packages/opencode/src/server/server.ts` | Hono app, routes, auth |
| **Workspace context** | `packages/opencode/src/control-plane/workspace-context.ts` | Per-request workspace scope |
| **Instance** | `packages/opencode/src/project/instance.ts` | Per-directory context, lazy boot |
| **Workspace router** | `packages/opencode/src/control-plane/workspace-router-middleware.ts` | Forward to remote workspaces (experimental) |
| **WorkspaceServer** | `packages/opencode/src/control-plane/workspace-server/server.ts` | Alternate route handler for worktree workspaces |

---

## 7. Server Connection Types (from app’s perspective)

From `packages/app/src/context/server.tsx`:

- **Sidecar (base):** local desktop server, key `"sidecar"`
- **Sidecar (WSL):** WSL server, key `"wsl:<distro>"`
- **HTTP:** arbitrary HTTP servers (can add/remove)
- **SSH:** remote host via SSH proxy

`ServerProvider` gets `props.servers` from the desktop (e.g. sidecar URL from `awaitInitialization`). The sidecar is the default for desktop.

---

## 8. Health Check

- **Endpoint:** `GET /global/health`
- **Auth:** Basic (`opencode:<password>`)
- **Polling:** every 10s via `useCheckServerHealth`
- **Timeout:** 3s per request

---

## 9. Differences for Our openmanager App

For comparison with openmanager:

1. **Single process:** Open Code uses one server for all workspaces; we may have a different model (e.g. job worker, SSE bridge).
2. **Boot time:** Their server starts at app launch; we could consider lazy start on first session.
3. **Scoping:** They use `workspace` + `directory` on every request; our Convex-based model may scope differently.
4. **Native sidecar:** They ship a compiled `opencode-cli`; we use Node/Electron main + Convex.
5. **Port:** Dynamic via `listen(0)`; we may use fixed ports or different binding.

---

## 10. File Reference

| File | Purpose |
|------|---------|
| `opencode.ref/packages/desktop-electron/src/main/index.ts` | App bootstrap, sidecar spawn, init |
| `opencode.ref/packages/desktop-electron/src/main/cli.ts` | Sidecar path, `serve()`, spawn logic |
| `opencode.ref/packages/desktop-electron/src/main/server.ts` | `spawnLocalServer`, health check |
| `opencode.ref/packages/opencode/src/server/server.ts` | Main HTTP server (Hono) |
| `opencode.ref/packages/opencode/src/project/instance.ts` | Per-directory Instance |
| `opencode.ref/packages/opencode/src/control-plane/workspace-router-middleware.ts` | Workspace routing |
| `opencode.ref/packages/opencode/src/control-plane/workspace-server/server.ts` | WorkspaceServer app |
| `opencode.ref/packages/app/src/context/server.tsx` | Server connection context |
