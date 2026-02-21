# OpenManager - Architecture & Design Canvas

> Living document tracking decisions, reasoning, and open questions as we design the app.

---

## 1. Vision

Build a desktop GUI ("OpenManager") that manages OpenCode agent sessions — similar to what Conductor does for Claude Code, but for OpenCode, on Windows (and eventually cross-platform).

We are NOT building coding-agent infrastructure. We reuse OpenCode CLI as the engine and wrap it with a GUI.

---

## 2. Key Decisions Log

| # | Decision | Options Considered | Chosen | Why |
|---|----------|--------------------|--------|-----|
| 1 | Desktop framework | Electron, Tauri | **Electron** | Faster prototyping, familiar JS/TS stack, no Rust dependency. Tauri migration possible later since UI layer is framework-agnostic web tech either way. |
| 2 | Integration approach | (a) Parse terminal output (PTY), (b) Hit OpenCode HTTP server API | **HTTP server API** | See Section 3 for full reasoning. |
| 3 | UI framework (inside Electron renderer) | TBD | TBD | React, Solid, Svelte, etc. — to be decided. |
| 4 | State management | TBD | TBD | |

---

## 3. Why a Local HTTP Server? (The Core "Why")

### 3.1 How OpenCode actually works (ELI5)

OpenCode is really **two programs glued together**:

1. **The Server** — the brain. It holds all the logic: talks to AI providers (Claude, GPT, Copilot, etc.), manages sessions, runs tools (file edits, shell commands), stores history in a local SQLite database. It exposes all of this through an HTTP API on localhost.

2. **The TUI (Terminal UI)** — just a face. The colorful terminal interface you see when you type `opencode` is merely a *client* that talks to the server above. It sends your prompts via HTTP, and receives responses/events back. It could be replaced by anything.

When you run `opencode` in a terminal:
- It starts the server on a random local port (say `127.0.0.1:51234`).
- It starts the TUI which connects to that server.
- Both live in the same process but are logically separate.

The `opencode serve` command lets you start ONLY the server (no TUI). The `opencode attach` command lets you connect a TUI to an already-running server. This proves they are independent pieces.

### 3.2 Why can't we just talk to "OpenCode's official servers"?

**There are no official remote servers.** OpenCode is not a cloud service. It's a local tool that runs on your machine. The "server" is always local — it's just an HTTP API running on `127.0.0.1` (your own computer). Think of it like a local web app (like how VS Code runs a local server for its UI).

The reason it needs to be local:
- It reads/writes your actual files on disk.
- It runs shell commands on your machine.
- It needs access to your git repos, your environment variables, your API keys.
- OAuth piggybacking (Copilot, Claude, etc.) works through locally-stored tokens.

None of this can happen from a remote server. The AI provider APIs (OpenAI, Anthropic, etc.) are remote, but OpenCode's own server is always local.

### 3.3 Why use an HTTP server at all? Why not just parse terminal output?

**Option A: Parse terminal output (PTY approach)**
- Spawn `opencode` in a pseudo-terminal.
- Read its stdout character by character.
- Try to parse the TUI's ANSI escape codes, colors, box-drawing characters.
- Reverse-engineer what's a "message", what's a "tool call", what's a "diff".

Problems:
- The TUI output is designed for *human eyes*, not machine parsing.
- It contains ANSI escape codes, cursor movements, screen redraws — total mess to parse.
- Any TUI update (new version of OpenCode changes layout) breaks your parser.
- You can't easily do things like "list all sessions" or "fork a session" by typing into a terminal.
- Bi-directional communication is fragile.

**Option B: Talk to the HTTP server directly**
- Start `opencode serve` (headless, no TUI).
- Hit `POST /session` to create a session — get back clean JSON.
- Hit `POST /session/:id/message` to send a prompt — get back structured message objects.
- Subscribe to `GET /event` (SSE stream) for real-time updates — get typed event objects.
- Everything is structured data. No parsing. No guessing.

This is not even a close contest. Option B is what every serious desktop app does (Claude Desktop, Cursor, the OpenCode Desktop app itself).

### 3.4 What about the OAuth / subscription piggybacking?

OpenCode handles this entirely inside its server. When you authenticate via `opencode auth login` or use Copilot's OAuth flow, the tokens are stored locally (`~/.local/share/opencode/auth.json`). The server reads these tokens and uses them when making requests to AI providers.

Our GUI doesn't need to touch OAuth at all. We just start the server, and it already knows how to authenticate with whichever providers you've set up. The GUI just sends prompts and receives responses — the server handles all the provider routing and authentication.

### 3.5 The SSE (Server-Sent Events) stream — why streaming?

When you send a message to an AI, the response comes back token-by-token (like watching someone type). The server exposes this as an SSE stream at `GET /event`. Our GUI subscribes to this stream once on startup, and receives a continuous flow of events:

- `message.part.updated` — a new chunk of the AI's response.
- `session.status` — session went from "idle" to "running" or "waiting for approval".
- `tool.call` — the AI wants to run a tool (edit file, run command).

This is how we get real-time updates without constantly polling "is there anything new?".

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────┐
│              Electron App                    │
│                                              │
│  ┌──────────────┐    ┌───────────────────┐  │
│  │ Main Process  │    │ Renderer Process  │  │
│  │               │    │                   │  │
│  │ - Spawn/kill  │    │ - Session list    │  │
│  │   opencode    │    │ - Chat UI         │  │
│  │   serve       │    │ - Agent cards     │  │
│  │               │    │ - Tool approvals  │  │
│  │ - Health      │    │ - Diff viewer     │  │
│  │   checks      │    │                   │  │
│  │               │◄──►│                   │  │
│  │ - IPC bridge  │IPC │ - State store     │  │
│  └──────┬───────┘    └───────────────────┘  │
│         │                                    │
└─────────┼────────────────────────────────────┘
          │ HTTP + SSE (localhost)
          ▼
┌─────────────────────┐
│  opencode serve     │
│  (headless server)  │
│                     │
│  - AI providers     │
│  - Tool execution   │
│  - File I/O         │
│  - Session/history  │
│  - OAuth tokens     │
│  - SQLite DB        │
└─────────────────────┘
```

### Electron Main Process responsibilities:
- Spawns `opencode serve --port <port> --hostname 127.0.0.1` as a child process.
- Generates a random password, passes it via `OPENCODE_SERVER_PASSWORD` env var.
- Polls `/global/health` until server is ready.
- Exposes IPC handlers so the renderer can say "the server is at http://127.0.0.1:PORT".
- Kills the sidecar on app exit.

### Electron Renderer Process responsibilities:
- All UI rendering.
- Talks to the OpenCode server via HTTP (REST calls + SSE event stream).
- Manages local UI state (which session is selected, scroll position, etc.).

---

## 5. OpenCode Server API — Key Endpoints We'll Use

| What we want to do | Method | Endpoint | Notes |
|---------------------|--------|----------|-------|
| Check server is alive | GET | `/global/health` | Returns `{ healthy: true, version: "..." }` |
| Real-time event stream | GET | `/global/event` | SSE stream — subscribe once, receive all events |
| List sessions | GET | `/session` | Returns array of sessions |
| Create session | POST | `/session` | Body: `{ title? }` |
| Get session detail | GET | `/session/:id` | |
| Delete session | DELETE | `/session/:id` | |
| Send a message | POST | `/session/:id/message` | Body includes prompt parts |
| Send message (async) | POST | `/session/:id/prompt_async` | Fire-and-forget, events come via SSE |
| Abort running session | POST | `/session/:id/abort` | |
| Get session diff | GET | `/session/:id/diff` | File changes made by the agent |
| Approve a permission | POST | `/session/:id/permissions/:pid` | Tool approval/denial |
| List providers | GET | `/provider` | Which AI providers are connected |
| Get config | GET | `/config` | Current OpenCode configuration |
| List files | GET | `/file?path=` | Browse project files |

---

## 6. MVP Scope (First Working Version)

**Goal**: Ship a Convex-backed desktop app that can register a workspace, create sessions, chat with OpenCode, stream events live, and handle permissions safely.

### 6.1 Rollout strategy (Convex-first, feature activation later)

1. **Foundation first**: Convex schema and storage boundary are built first so data flow is correct from day one.
2. **Local loop second**: prove sidecar spawn + OpenCode session/chat streaming quickly for desktop UX confidence.
3. **Multi-device activation later**: mobile/job-queue behavior is enabled after desktop flow is stable.

This avoids painful refactors ("Convex bolted on later"), while still keeping implementation velocity high.

### 6.2 MVP checklist (what must work first)

**Convex foundation (Phase 0):**
- [ ] Convex bootstrap + auth baseline
- [ ] Initial schema (`workspaces`, `sessions`, `messages`, `pending_jobs`)
- [ ] Data access boundary in app code (no scattered direct storage writes)
- [ ] Write-through persistence to Convex for workspace/session/message records

**Core shell + session flow (Phases 1-2):**
- [ ] Sidecar lifecycle (spawn, health check, shutdown/restart)
- [ ] Renderer handshake with server URL/password
- [ ] SSE connection and event consumption
- [ ] Workspace registration (saved in Convex)
- [ ] Session list/create/switch/delete
- [ ] Chat interface (send prompt, see streaming response)
- [ ] Tool call visibility and permission handling (approve/deny)
- [ ] Basic error handling and reconnect behavior

**Sync readiness (minimal, still MVP):**
- [ ] Mirror key session events into Convex so history is already multi-device compatible

### 6.3 NOT in MVP
- Full mobile client UX
- Remote job queue execution path from non-desktop devices
- Multi-workspace orchestration dashboard / agent board
- Custom agent profiles/presets
- Statistics / token tracking
- Auto-update mechanism

---

## 7. Open Questions

- [ ] UI framework choice for renderer (React vs Solid vs Svelte vs Vue)
- [ ] State management approach (Zustand/Jotai/Nanostores vs Convex-driven primary state)
- [ ] Convex schema boundary: what must live in Convex vs remain local-only
- [ ] Exact reconnect semantics if OpenCode sidecar crashes mid-session
- [ ] Event idempotency strategy for Convex mirroring (dedupe + ordering)
- [ ] Diff source of truth: OpenCode diff endpoint vs derived file-change events
- [ ] Revert strategy: native OpenCode session primitives vs git checkpointing layer
- [ ] Packaging and distribution strategy
- [ ] Whether to bundle OpenCode CLI or require user to install it separately

---

## 8. Clarifications & Mental Model

### 8.1 The entire stack is TypeScript

OpenCode server runs on **Bun** (a JS/TS runtime, similar to Node). The SDK is TypeScript. Our Electron main process is Node.js (TypeScript). Our renderer is TypeScript + React (or whatever we choose). Everything is one language top to bottom.

### 8.2 Why we can't embed OpenCode as a library (Option 1 expanded)

The server code is deeply coupled to the CLI entry point — it's not published as `require('opencode/server').start()`. To embed it, we'd need to:
1. Fork the OpenCode repo.
2. Extract all server internals (provider routing, tool execution, SQLite, MCP, LSP, file watching).
3. Rewire all of it to run inside our Electron main process (which does have system access).
4. Maintain this fork as OpenCode ships frequent updates.

The main process *could* technically host all this (it has full Node/system access), but it's an enormous maintenance burden for zero user-facing benefit. `opencode serve` gives us the exact same functionality with one `child_process.spawn()` call.

### 8.3 Renderer talks to OpenCode server DIRECTLY

The renderer (browser) makes HTTP requests straight to `http://127.0.0.1:PORT`. **The main process is not a middleman for API calls.** The only IPC is a one-time handshake:

```
Main Process                          Renderer
    │                                     │
    │ (spawns opencode serve)             │
    │ (waits for health check)            │
    │                                     │
    ├──── IPC: "server ready at           │
    │      http://127.0.0.1:5432,         │
    │      password: abc123"  ───────────►│
    │                                     │
    │                           (renderer connects directly)
    │                           (SSE stream, REST calls)
    │                                     │──► opencode serve
    │                                     │◄── opencode serve
```

After that initial handshake, the main process just babysits the sidecar (is it alive? restart if crashed). All real communication is renderer ↔ server.

### 8.4 Electron vs Tauri — why the difference barely matters here

| Concern | Electron | Tauri | Impact for us |
|---------|----------|-------|---------------|
| Main process language | Node.js (JS/TS) | Rust | **Negligible** — main process does almost nothing (spawn server, health check, cleanup) |
| Renderer | Chromium | System WebView | Same web code either way |
| Bundle size | ~150MB+ | ~5-10MB | Real difference, but not a dealbreaker for personal tool |
| RAM baseline | ~150-300MB | ~30-50MB | Real difference, but OpenCode server itself uses comparable RAM |
| Where heavy work happens | OpenCode server (Bun/TS) | OpenCode server (Bun/TS) | **Identical** — the framework choice doesn't touch this |

Rust in Tauri is not doing AI work, not doing file I/O for the agent, not managing sessions. It's just the thin shell. Even OpenCode's own Tauri desktop app has minimal Rust — `lib.rs` is mostly spawn/kill sidecar + a few platform helpers (WSL path conversion, app existence check). Nothing that benefits from Rust's performance characteristics.

**Migration path**: If we ever move to Tauri, we rewrite the main process (small) and keep the entire renderer (large) unchanged. The renderer doesn't care what spawned it.

### 8.5 How VS Code / Cursor handle processes (brief)

**VS Code** (Electron):
- Main process: window management, menus, lifecycle orchestration
- Extension Host: separate Node process running all extensions
- Language Servers: one child process per language (TS server, Python LSP, etc.)
- Terminal: each integrated terminal = child process via node-pty
- File Watcher: dedicated child process
- Shared Process: telemetry, updates, auth

So yes, VS Code spawns many child processes. The main Electron process is an orchestrator, not a workhorse.

**Cursor** (also Electron, forked from VS Code):
- Same multi-process architecture as VS Code
- AI logic (prompt construction, context retrieval, model routing) lives on **Cursor's remote servers** — closed source, not shipped locally
- Local app handles editor + system access, remote servers handle the "smart stuff"

**OpenCode Desktop** (Tauri):
- Rust backend: spawn sidecar, health check, window management
- Web frontend: the full app UI
- OpenCode server: separate sidecar process handling all AI/tool/session logic

**Our app** (Electron):
- Main process: spawn sidecar, health check, window management (same role as Tauri's Rust)
- Renderer: the full app UI (same as any of the above)
- OpenCode server: separate sidecar process (identical to all above)

### 8.6 Performance reality check

Where actual CPU/memory goes in our app:
1. **OpenCode server** (Bun process) — majority of memory/CPU. Manages sessions, runs tools, handles AI streaming.
2. **Electron renderer** (Chromium) — second largest. DOM rendering, React, state management.
3. **Electron main process** (Node) — trivial. Almost idle after startup.

Our optimization efforts should focus on **#2 (renderer)** — efficient rendering, virtualized lists, smart event handling. The main process and framework choice are rounding errors in the performance budget.

---

## 9. Mobile Access, Cloud Sync & Sandboxing

### 9.1 Mobile access — it's already built in

OpenCode server supports binding to `0.0.0.0` (all network interfaces) via the `hostname` config. With `mdns: true` it also broadcasts on the local network for auto-discovery.

- Default (`127.0.0.1`): only your machine.
- `0.0.0.0`: any device on same network can reach it.
- With mDNS: discoverable as `opencode.local`.

**For remote access (outside home Wi-Fi):** Use Tailscale or ZeroTier (private mesh VPN). Phone on mobile data can reach desktop OpenCode server as if local. No port forwarding, no public exposure.

### 9.2 Why other companies don't do local-server mobile access

**Security is the primary reason, not a technical limitation.**

Exposing `opencode serve` to a network means exposing an API that can:
- Read any file on your machine
- Execute arbitrary shell commands
- Edit your codebase

Cursor, Copilot etc. go cloud so they control the security surface and users don't have to think about it. There was even a real CVE in OpenCode (`GHSA-c83v-7274-4vgp`) where a malicious website could exploit the web UI to execute commands on localhost:4096 — shows how real the risk is if not careful.

**For personal use with Tailscale:** Risk is effectively eliminated. The mesh VPN keeps the server private, no internet exposure.

### 9.3 Cross-device sync architecture

Two different problems:

| Need | Solution |
|------|---------|
| See a live running session on mobile | Phone connects directly to desktop server (Tailscale) — SSE stream works natively |
| Access session history when desktop is off | Sync completed session data to Convex (or similar) |
| Notifications (agent done / needs approval) | Push from Convex when session state changes |

OpenCode stores all session data in local SQLite (`~/.local/share/opencode/`). The CLI and desktop app use the **same data store** — they both talk to the same local server.

A viable personal sync architecture:
```
[Desktop OpenCode server] ──live SSE──► [Mobile app via Tailscale]
          │
          └── [on session complete] ──► [Convex] ──► [Mobile app for history/notifs]
```

### 9.4 OpenCode sandboxing — what it actually is

**No OS-level sandbox.** No Docker containers around the agent. No Windows Sandbox. No process isolation.

What OpenCode calls "sandboxing" is just a permission gate system:
- `permission.bash`: `allow` / `ask` / `deny` — controls whether agent can run shell commands
- `permission.edit`: controls file writes
- `permission.external_directory`: agent can't leave the project folder by default
- `permission.doom_loop`: blocks repeated identical tool calls
- `.env` files: denied by default to protect secrets

The `packages/containers/` directory in the repo is purely **CI/CD build containers** for their GitHub Actions pipeline — nothing to do with agent sandboxing.

**OpenAI Codex's sandbox is different** — it runs on OpenAI's servers in a real Linux container that resets per session. That exists to prevent cross-user contamination on shared cloud infrastructure. OpenCode doesn't need that because it only ever runs for one user on one machine.

### 9.5 Why WSL is recommended on Windows (not for sandboxing)

1. **Model training data** — LLMs were mostly trained on Linux codebases. They generate bash commands (`grep`, `sed`, `chmod`, etc.) that don't work in PowerShell/CMD.
2. **Dev toolchain compatibility** — shell scripts, makefiles, Unix pipes all work natively on Linux.
3. **File system performance** — WSL2 is faster for recursive file operations agents frequently do.
4. **Path consistency** — Unix paths are unambiguous. Windows paths (`C:\Users\...`) cause agent confusion.

It's a developer experience recommendation, not a security one.

---

## 10. Convex Sync Architecture (Multi-Device)

### 10.1 The pattern

Convex is the cloud hub. The Electron app IS the local agent — no separate script needed.

```
[Mobile / any device]
     │ writes job to Convex
     ▼
[Convex DB] ──reactive subscription──► [Electron main process]
                                               │ localhost HTTP
                                               ▼
                                        [opencode serve]
                                               │ streams chunks
                                               ▼
                                        [Electron main process]
                                               │ writes chunks to Convex
                                               ▼
                                        [Convex DB] ──reactive push──► [All devices]
```

Desktop renderer ALSO connects directly to OpenCode's SSE stream for zero-extra-hop latency.

### 10.2 Mobile capabilities and limitations

**Can do:**
- Watch a live session updating in real time
- Send a message into an ongoing session
- Review completed sessions and diffs
- Start background jobs that execute on the desktop

**Cannot do:**
- Start a session in a workspace that doesn't exist on desktop (OpenCode needs the files physically present)
- Meaningfully interact with file changes without the project context

Mobile = remote viewer + limited controller. Not a limitation of this architecture — it's physical reality.

### 10.3 Security model

- Desktop machine only makes OUTBOUND connections: to Convex (WebSocket) and to OpenCode (localhost)
- No ports exposed to internet, no LAN exposure, no tunnels needed
- OpenCode server never leaves localhost

---

## 11. OpenAI Codex CLI — Comparison & GUI Feasibility

### 11.1 What Codex actually is

Codex CLI (`openai/codex`) is genuinely open source and runs **mostly locally**:
- Local: agent loop, tool execution, session management, OS-level sandbox
- Remote (cloud): AI inference (calls OpenAI's API using your ChatGPT subscription token)

OpenCode is similar but uses any provider (Copilot, Claude, OpenAI, etc.) and everything including model calls uses your own credentials.

### 11.2 Sandbox comparison

| | OpenCode | Codex CLI |
|--|---------|-----------|
| Sandbox type | Config-level permission gates | OS-level kernel enforcement |
| macOS | Permission `ask`/`deny` config | Apple Seatbelt (`sandbox-exec`) |
| Linux | Permission `ask`/`deny` config | Landlock + seccomp |
| Windows | Permission `ask`/`deny` config | Experimental (WSL for real sandbox) |
| What it actually stops | Nothing at OS level — just prompts you | Kernel denies syscalls that violate policy |

OpenCode's `permission: "ask"` is a UI gate. The kernel doesn't enforce it. Codex's sandbox is enforced by the OS kernel regardless of what the model tries to do.

### 11.3 Codex app-server (how to build a GUI for Codex)

Codex exposes `codex app-server` — an official protocol for rich clients (used by the VS Code Codex extension). It speaks **JSON-RPC 2.0** over:
- `stdio` (default, good for same-machine embedding)
- `WebSocket` (experimental, `--listen ws://127.0.0.1:PORT`)

Core primitives map to OpenCode concepts:
| Codex | OpenCode equivalent |
|-------|-------------------|
| Thread | Session |
| Turn | One prompt + response cycle |
| Item | Event (message part, tool call, file change, command) |

Building a Codex GUI: spawn `codex app-server --listen ws://127.0.0.1:4500`, connect WebSocket, speak JSON-RPC. Nearly identical architecture to our OpenCode approach.

### 11.4 Key distinction for future reference

- **OpenCode**: Any AI provider, full open source, no real OS sandbox, HTTP+SSE API
- **Codex**: OpenAI-only (ChatGPT subscription), open source agent/sandbox layer, proprietary model, JSON-RPC API

Both support building a rich GUI on top. Our app focuses on OpenCode but the pattern is portable.

---

## 12. Glossary

| Term | Meaning |
|------|---------|
| **Sidecar** | A background process (opencode serve) that our app spawns and manages |
| **Session** | One conversation thread with the AI agent |
| **Workspace / Project** | A directory on disk that the agent operates on |
| **SSE** | Server-Sent Events — a one-way streaming protocol over HTTP |
| **TUI** | Terminal User Interface — the colored terminal app you see when running `opencode` |
| **Provider** | An AI service (Anthropic, OpenAI, Copilot, etc.) |
| **OAuth piggyback** | Using existing subscription tokens (e.g., Copilot) to access AI providers without separate API keys |
| **IPC** | Inter-Process Communication — how Electron main and renderer processes talk |
