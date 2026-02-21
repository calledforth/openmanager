# OpenManager — Feature Map & Tech Stack Reference

> Quick-reference checklist. One-liners only. For deep reasoning behind any decision, see `ARCHITECTURE.md`.

---

## 1. Tech Stack at a Glance

### Core engine
- OpenCode runs as `opencode serve` → exposes a local HTTP REST + SSE server on a random localhost port
- The server is written in Bun/TypeScript — entire stack is TypeScript end to end
- OpenCode already provides an SDK to consume its API — we use that in the renderer

### Electron shell
- Electron main process spawns `opencode serve` as a managed sidecar child process on app launch
- Main process does one health check (`GET /global/health`), then hands the port + password to the renderer via IPC
- After that handshake, the renderer talks to the OpenCode server **directly** — no IPC middleman for any API calls
- Main process is minimal by design: spawn, health check, cleanup on exit. Heavy lifting is all on the OpenCode server

### Real-time streaming
- Renderer subscribes to `GET /global/event` (SSE stream) — all session events arrive here
- SSE = one persistent connection, server pushes events as they happen (token deltas, tool calls, file changes, etc.)
- No polling. No WebSocket needed for OpenCode comms — SSE is enough

### Multi-device sync (Convex layer)
- Convex = cloud hub: database + real-time sync engine + auth layer
- Electron main process doubles as the "local agent": subscribes to Convex, picks up jobs from mobile/other devices, forwards them to OpenCode locally
- Desktop renderer gets direct SSE from OpenCode (lowest latency) AND Convex sync (for history/multi-device state)
- All other devices (mobile, other laptops) connect to Convex only — write jobs, read results reactively
- Security: desktop only makes outbound connections (to Convex via WebSocket, to OpenCode via localhost). No ports exposed

### What we are NOT building
- No custom AI infrastructure, no model hosting, no agent logic
- No terminal parsing / PTY hacks — we never touch OpenCode's TUI output
- No forking OpenCode — we treat `opencode serve` as a black box with a clean API surface

---

## 2. Feature Map

Build order matters. Convex is a foundation from day one, but we still validate local OpenCode session flow early so shipping velocity stays high.

---

### Phase 0 — Convex Foundation (do this first)

| # | Feature | What it means | Architecture touch point |
|---|---------|--------------|--------------------------|
| 0.1 | **Convex project bootstrap** | Set up Convex project, deployment envs, auth baseline, and local dev wiring | Convex platform setup |
| 0.2 | **Initial schema** | Define core tables: `workspaces`, `sessions`, `messages`, `pending_jobs` (minimal fields only) | Convex schema definition |
| 0.3 | **Data access boundary** | App code reads/writes through a repository/store boundary so storage backend is not scattered in UI | Renderer/Main architecture boundary |
| 0.4 | **Write-through baseline** | New workspace/session/message records are persisted in Convex from day one (even if desktop-only at first) | Convex mutations + queries |
| 0.5 | **Job status model** | Define queue states now: `pending`, `running`, `done`, `failed` | Convex `pending_jobs` workflow model |

---

### Phase 1 — Core Shell (prove local engine loop)

| # | Feature | What it means | Architecture touch point |
|---|---------|--------------|--------------------------|
| 1.1 | **Sidecar lifecycle** | Spawn `opencode serve` on app open, kill it on app close, restart on crash | Electron main process, `child_process` |
| 1.2 | **Health + port handoff** | Poll `/global/health` until ready, send port + password to renderer via IPC | Main process → renderer IPC |
| 1.3 | **SSE connection** | Renderer opens persistent SSE connection to `/global/event` immediately after handoff | OpenCode SSE stream |
| 1.4 | **Workspace registration** | User picks an existing local directory → saved as a named workspace | Convex `workspaces` table |

---

### Phase 2 — Session Management

| # | Feature | What it means | Architecture touch point |
|---|---------|--------------|--------------------------|
| 2.1 | **Create session** | `+` button in a workspace context → `POST /session` with the workspace path as `cwd` | OpenCode REST API |
| 2.2 | **Session chat UI** | Render messages, streaming token deltas, tool call events as they arrive via SSE | Renderer UI + SSE event parsing |
| 2.3 | **Send message** | User input → `POST /session/:id/message` | OpenCode REST API |
| 2.4 | **Session lifecycle controls** | Stop (abort in-flight), resume a paused session, close/archive | OpenCode `abort` endpoint + session state |
| 2.5 | **Multiple concurrent sessions** | Multiple sessions open at once — per workspace and across workspaces | OpenCode natively supports this; our job is UI (sidebar/tabs) |
| 2.6 | **Permission approval UI** | When OpenCode sends a permission request event, show an approve/deny prompt in the UI | SSE event → modal UI → `POST /session/:id/permissions/:pid` |

---

### Phase 3 — Quality of Life

| # | Feature | What it means | Architecture touch point |
|---|---------|--------------|--------------------------|
| 3.1 | **"Open in editor"** | Per session/workspace: dropdown → open that directory in VS Code, Cursor, or whichever IDE | Electron `shell.openPath` / launch registered editor |
| 3.2 | **Diff view** | Show a visual unified diff of all file changes made during a session | OpenCode exposes a diff endpoint — check `/session/:id/diff`; render as split view |
| 3.3 | **Session history** | List past sessions for a workspace, resume any of them | OpenCode session list API + Convex persistence |

---

### Phase 4 — Sync & Multi-Device Activation

| # | Feature | What it means | Architecture touch point |
|---|---------|--------------|--------------------------|
| 4.1 | **Session mirroring hardening** | Ensure every important OpenCode SSE event is mirrored to Convex reliably with idempotency | Main process local agent loop + Convex writes |
| 4.2 | **Job queue execution** | Any device can push a `pending_job`; main process picks it up and forwards to OpenCode | Convex `pending_jobs` + main process subscription |
| 4.3 | **Mobile viewer** | Read live session output from phone; send messages into running sessions | Mobile client → Convex reactive queries |
| 4.4 | **Offline queue** | Jobs submitted when desktop is asleep stay queued until local agent reconnects | Convex queue state transitions |
| 4.5 | **Cross-device consistency checks** | Verify ordering, duplicate prevention, and reconnection recovery across devices | Event ids, timestamps, optimistic UI rules |

---

### Phase 5 — Advanced (later)

| # | Feature | What it means | Architecture touch point |
|---|---------|--------------|--------------------------|
| 5.1 | **Git checkpointing** | Auto-commit (or stash) at session start / message boundaries so rollback is safe | Git integration in main process; check if OpenCode exposes this first |
| 5.2 | **Message revert** | Roll back to a prior session state — undo what the agent did | Depends on 5.1; also check OpenCode's own revert/fork session API |
| 5.3 | **Multi-agent orchestration** | Spawn multiple sessions across workspaces, view them in a single dashboard | Mostly UI — OpenCode already handles concurrent sessions |

---

## 3. Open Questions (to resolve as we build)

- [ ] UI framework for renderer — React, Solid, or Svelte? (performance matters here)
- [ ] State management approach — Zustand, Jotai, Nanostores, or Convex as primary state?
- [ ] Does OpenCode expose a diff endpoint natively, or do we compute diffs ourselves from file change events?
- [ ] Does OpenCode have any native session revert / fork API we can leverage before building our own git checkpointing?
- [ ] Convex schema design — what exactly needs to live in Convex vs. staying local only?
- [ ] How to handle the case where OpenCode server crashes mid-session — reconnect strategy, session recovery
- [ ] Authentication model for Convex — who is the "user"? Single user (personal app) simplifies this a lot
