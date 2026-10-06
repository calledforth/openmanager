# OpenManager

OpenManager is one app for running and managing AI coding agent sessions:
**OpenCode**, **Cursor** and **Claude Code** (Codex is planned).

Instead of juggling a separate terminal or editor for each agent, you get a single
chat-style UI to start sessions in your projects, watch them work, answer their
questions and permission prompts, and pick up where you left off, from any device.

## How it works

```
 browser / desktop / phone          your machine
 ┌──────────────────┐   WebSocket   ┌─────────────────────────┐
 │  OpenManager UI  │ ────────────▶ │  Environment server     │──▶ OpenCode
 └──────────────────┘               │  (Node, SQLite)         │──▶ Cursor
                                    └─────────────────────────┘──▶ Claude Code
```

- The **environment server** runs on the machine where your code lives. It owns
  your projects, starts the agent CLIs, and stores sessions and history in a
  local SQLite database. Your code and provider logins never leave that machine.
- The **web app** is the client. It connects to one or more environments.
- Other devices (a phone, another laptop) join by **pairing**: create a link or
  QR code in Settings → Devices and open it on the new device.

## What you can do

- Add project folders and start sessions with any installed provider
- Pick the model, mode and reasoning options per session
- See streaming replies, tool calls and reasoning as they happen
- Approve permissions and answer agent questions from the UI
- Attach images to prompts
- Keep drafts that sync between devices
- Get browser notifications when a session finishes or needs you
- Pair, rename and revoke devices
- Run the server in the background (Windows logon task, Linux/WSL systemd)

## Getting started

You need **Node 24**, **pnpm** (`corepack enable`), and at least one provider
CLI installed and logged in (`opencode`, `cursor-agent` or `claude`).

```bash
pnpm install
pnpm dev:web
```

Then open <http://127.0.0.1:5173>. This starts:

- the environment server at `http://127.0.0.1:43120`
- the web app at `http://127.0.0.1:5173`

and connects them for you, with this repo as the first project.

### Run the server in the background

```bash
pnpm --filter @openmanager/server build
node apps/server/dist/main.js service install
```

See [docs/windows-startup.md](docs/windows-startup.md) and
[docs/linux-systemd.md](docs/linux-systemd.md).

## What's in the repo

| Path                          | What it is                                                           |
| ----------------------------- | -------------------------------------------------------------------- |
| `apps/server`                 | Environment server: runs agents, stores data, auth and pairing       |
| `apps/web`                    | Web app (Vite + React), the main client                              |
| `apps/desktop`                | Older Electron app (OpenCode + Convex), being replaced by the web app |
| `apps/mobile`                 | Expo (React Native) app, early stage                                 |
| `packages/app-core`           | Shared React UI used by web and desktop, plus Storybook              |
| `packages/environment-client` | Client that talks to an environment server                           |
| `packages/protocol`           | Wire protocol shared by server and clients                           |
| `packages/agent-*`            | Provider runtime, contracts and views (`@agentpack/*`)               |
| `packages/shared`, `convex`   | Older shared types and the Convex backend used by the desktop app    |
| `docs`                        | Design notes, decisions and guides                                   |

## Common commands

| Command          | What it does                            |
| ---------------- | --------------------------------------- |
| `pnpm dev:web`   | Start the server + web app (hot reload) |
| `pnpm dev`       | Start the Electron desktop app          |
| `pnpm storybook` | UI playground                           |
| `pnpm typecheck` | Typecheck everything                    |
| `pnpm lint`      | Lint everything                         |
| `pnpm test`      | Run all tests                           |
| `pnpm ci:server` | Server checks + build (also `ci:web`, `ci:app-core`, ...) |

## More docs

- [Server guide](apps/server/README.md): configuration, auth, pairing, uploads, storage
- [Web app](apps/web/README.md): routes, environments, pairing on a new device
- [Security](docs/SECURITY.md) and [threat model](docs/threat-model.md)
- [Decisions](docs/decisions/)
- [Releasing](docs/RELEASING.md)
