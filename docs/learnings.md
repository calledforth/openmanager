# Learnings from OpenManager vs OpenCode Comparison

Notes captured during analysis of OpenCode's architecture and how it differs from our implementation. Each section is a discrete insight from our discussion.

---

## 1. Server Process vs Instance: Terminology & Architecture Distinction

**Terminology:**


| Term               | Meaning                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server process** | One OS process running the opencode CLI (e.g. `opencode serve --hostname 127.0.0.1 --port N`). One process = one binary.                                                                      |
| **Instance**       | OpenCode's in-process concept for scoping. A per-directory request context inside the same server process. One process can host many instances; each HTTP request is scoped to one directory. |


**My understanding:**

- **Server process** = you run the opencode CLI once. One process.
- By design, **one server process can handle multiple sessions, workspaces, and directories**. The opencode server supports this natively via the Instance model.
- On the **client side**, you distinguish which workspace a request targets by attaching **workspace** and **directory** in request headers (or query params). The server uses these to call `Instance.provide({ directory })` and scope the request.

**Critical distinction:**


|                            | OpenManager (current)                                          | OpenCode Desktop                                              |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| **When sidecar starts**    | Per workspace, on demand                                       | Once at app startup                                           |
| **Process count**          | N workspaces → N opencode processes                            | N workspaces → 1 opencode process                             |
| **How directory is known** | Inferred by server from `cwd` (each process has different cwd) | Passed explicitly via `directory` / `workspace` headers/query |
| **Efficiency**             | Less efficient (more processes)                                | More efficient (shared process)                               |


**For OpenManager:** If we move to a single shared sidecar (like OpenCode), we would need to pass `directory` (and optionally `workspace`) on every request to the opencode API so it can scope correctly.

---

## 2. Workspace Router Middleware, Adaptors, Main vs Workspace Server

**Hono** = Lightweight web framework (like Express). OpenCode uses it to define routes and middleware. `Bun.serve({ fetch: app.fetch })` runs the Hono app.

**Main Server vs Workspace Server** – same process, two Hono apps:


|                   | Main Server                                                     | Workspace Server                                                 |
| ----------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| **What**          | Hono app with full API (session, project, pty, file, mcp, etc.) | Hono app with session + workspace routes only                    |
| **Directory**     | From query/header, or defaults to `process.cwd()`               | **Required** via `x-opencode-directory` / `directory` query      |
| **Where it runs** | The one `Bun.serve()` in the opencode binary                    | Never runs as its own server – only via `App().fetch()`          |
| **Purpose**       | Handle most requests; flexible about directory                  | Handle workspace-scoped requests when directory must be explicit |


They are both route handlers. The main Server is what `Bun.serve` uses. WorkspaceServer is only invoked in-process (see below).

**Workspace Router Middleware** (experimental, gated by `OPENCODE_EXPERIMENTAL_WORKSPACES`):

- Runs on the main Server, before normal request handling.
- If the request has a `workspace` ID: look up that workspace, get its `type` (e.g. `worktree`), and call the matching adaptor’s `fetch`.
- If the adaptor returns a response, the middleware returns it and the main Server never sees the request.
- If not (e.g. no workspace, or non-experimental mode), it calls `next()` and the main Server handles it as usual.

So the middleware decides: "handle this via the workspace adaptor" vs "handle this via the main Server."

**Adaptors** – pluggable backends per workspace type:

- `Adaptor` has `configure`, `create`, `remove`, and `**fetch`**.
- `fetch(workspace, path, init)` = "handle this request for this workspace." Can be in-process or a real HTTP call.

**Worktree Adaptor** (only built-in adaptor for now):

- For `type: "worktree"` – a local git worktree.
- `fetch` does **not** do a network request. It:
  1. Adds `x-opencode-directory` with the worktree’s directory.
  2. Builds a new `Request` with that header.
  3. Calls `WorkspaceServer.App().fetch(request)` – an **in-process** call to the WorkspaceServer handler.
- So it’s an internal re-route: same process, different route set. WorkspaceServer requires workspace + directory; the adaptor supplies them.

**Future remote adaptors** (not implemented yet):

- For workspace types like `ssh` or `cloud`, `fetch` would do a real `fetch()` to another OpenCode server (e.g. over SSH tunnel or remote URL).
- That would be the "route to remote" behavior: local control plane → adaptor → HTTP to remote server.

**Concurrency:**

- `Bun.serve` handles many concurrent HTTP connections.
- The opencode binary is a single server process; all routing, middleware, and Instance scoping happen inside it. Concurrency is handled by Bun’s runtime.

---

## 3. Tauri vs Electron, Instance Lifecycle, Remote, Zen

**Tauri vs Electron desktop:**

- In the opencode repo, **both** Electron and Tauri spawn a sidecar automatically at app startup (same flow: `initialize()` → `spawn_local_server()` → health check → main window).
- If you see “No local server, start it” on Tauri, it’s likely:
  - **Mobile build** (iOS/Android): Tauri mobile can’t spawn local processes; you connect to an external server.
  - **Missing sidecar binary**: If `opencode-cli` isn’t bundled (e.g. some distros), the app falls back to asking you to start/connect to a server.
- So it’s a platform/distribution limitation, not a design choice. Desktop Tauri and Electron both auto-start the sidecar when the binary is present.

**OpenManager – one process:**

- OpenManager will have **one** OpenManager process (the Electron app).
- That process talks to **one** opencode sidecar (after we switch from per-workspace sidecars).
- All multi-workspace / multi-session handling is done by the **opencode server** via the Instance model. OpenManager only needs to pass `directory`/`workspace` per request.

**Instances – when are they created?**

- **Instance** = one per directory, created lazily.
- From `Instance.provide()`: first request for a directory triggers `boot()` and the instance is cached.
- So instances are created when the first request hits that directory (e.g. opening a session in that workspace), not when the app starts.

**Remote proxy / SSH / cloud:**

- **ServerConnection.Ssh** exists: “Remote server desktop can SSH into – SSH client exposes an HTTP server for the app to use as a proxy.” So the desktop can connect to a remote OpenCode server via SSH tunnel; the tunnel exposes HTTP, and the app uses it like any other server.
- **Workspace adaptors**: Only `worktree` is implemented. Cloud/SSH workspace types would need new adaptors whose `fetch` does a real HTTP call to a remote URL. Those are not implemented yet.
- **Truly remote?** Yes for SSH: you SSH into a machine, run opencode there, and the desktop proxies through. The experimental workspace adaptor “remote” path is designed for that, but only worktree exists today.

**Zen gateway?**

- “Zen” in the codebase is product naming (ZenLite, ZenBlack – Stripe plans), not a gateway.
- The main Server has a catch-all proxy to `https://app.opencode.ai` for unmatched routes (web app, account, etc.). That’s the cloud/web gateway, not “Zen.”

---

## 4. Zen Gateway, SSH Remote, Convex vs SSH Comparison

**Zen = OpenCode’s AI model gateway (verified from opencode.ai/docs/zen):**

- Zen is a **cloud model-routing product**, not a remote-desktop or tunnel product.
- Flow when using Zen: **Client → Local OpenCode server → Zen API (opencode.ai/zen/v1/...) → upstream models** (OpenAI, Anthropic, etc.).
- Tokens are streamed via Zen: your prompts and model outputs pass through OpenCode’s cloud.
- Security: Zen sees your prompts and responses. Privacy policy states zero retention by providers for training, with exceptions (e.g. OpenAI/Anthropic 30-day retention). Hosted in US.
- Works with any agent: Zen is just another provider. You add an API key and configure model IDs like `opencode/gpt-5.3-codex`.
- Other providers: The Provider abstraction in OpenCode works with many providers (OpenAI, Anthropic, Zen, OpenRouter, etc.). Streaming uses HTTP (e.g. `streamText`), not raw WebSockets for model calls. The `/event` SSE stream is for server events (UI updates), not token streaming.

**SSH remote – how it works:**

- **ServerConnection.Ssh**: “Remote server desktop can SSH into” + “SSH client exposes an HTTP server for the app to use as a proxy.”
- Interpretation: Desktop A (e.g. your laptop) wants to use OpenCode running on Desktop B (e.g. office machine).
- You SSH into Desktop B. A **tunnel** is created (SSH port forwarding, e.g. `ssh -L 5432:localhost:5432 user@remote`). The “SSH client” on Desktop A exposes a local HTTP server (e.g. localhost:5432) that forwards traffic over the SSH connection to the OpenCode server on Desktop B.
- So: **Desktop A app → localhost:5432 → SSH tunnel → Desktop B’s opencode server**. Classic ngrok/tailscale-style tunneling, but using SSH.
- Security: End-to-end encrypted (SSH). Only you and the remote machine see traffic. If an attacker gets your SSH keys, they can abuse the tunnel. No third-party server in the path.

**Convex vs SSH – remote access comparison:**

| | SSH tunnel | Convex sync |
|--|------------|-------------|
| **Architecture** | Direct tunnel: Client A → SSH → OpenCode on Client B | Mediated: Client A → Convex → Client B (with sidecar) processes → Convex → Client A |
| **Where OpenCode runs** | On the remote machine (Desktop B) | On the machine that “owns” the session (has the sidecar) |
| **Traffic path** | Client A talks directly to remote OpenCode via tunnel | Messages and state flow through Convex; only the worker machine talks to the sidecar |
| **Trust** | Trust your SSH setup; no third party for chat traffic | Trust Convex; they store and sync messages/state |
| **Security** | E2E encrypted (SSH); prompts/responses never touch a third party | Convex sees message content; depends on Convex auth and policies |
| **Setup** | SSH keys, port forwarding, opencode running on remote | Convex project, auth; no tunnels to manage |
| **Best for** | Single user, “use my office machine from home” | Multi-device sync (phone, tablet, multiple desktops); collaborative |

**Trade-off:**

- Both have a trust boundary: SSH = your key management and remote machine security; Convex = Convex’s infra and access control.
- The “message can reach a remote machine” property exists in both: with SSH, you tunnel to the machine; with Convex, a worker pulls from Convex and talks to the sidecar. The difference is who mediates the data path.
- Convex is often easier for mobile and multi-client setups; SSH is simpler when you only need to reach one known machine.
