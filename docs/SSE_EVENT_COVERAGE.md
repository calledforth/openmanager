# SSE Event Coverage

## Integrated (handled in sse-bridge)


| Event                  | Action                                    |
| ---------------------- | ----------------------------------------- |
| `session.updated`      | Upsert session status/title in Convex     |
| `session.status`       | Update session status (idle/busy/retry)   |
| `session.created`      | Upsert session record                     |
| `session.deleted`      | Remove session                            |
| `session.error`        | Store error on session                    |
| `message.updated`      | Flush full message + parts to Convex      |
| `message.part.updated` | Buffer part (all types)                   |
| `message.part.delta`   | Append delta to buffered part field       |
| `message.removed`      | Delete message from Convex                |
| `permission.asked`     | Store as permission message for UI prompt |
| `permission.replied`   | Remove permission message                 |


## Rendered in UI


| Part Type     | Component                                                     |
| ------------- | ------------------------------------------------------------- |
| `text`        | Markdown with syntax-highlighted code blocks                  |
| `tool`        | Collapsible card with state (pending/running/completed/error) |
| `reasoning`   | Toggleable thinking block                                     |
| `step-finish` | Metadata line (model, tokens, duration)                       |


## Explicitly Ignored (no-op, logged)


| Event              | Reason                           |
| ------------------ | -------------------------------- |
| `server.heartbeat` | Keep-alive only                  |
| `project.updated`  | Not needed for chat UX           |
| `session.idle`     | Covered by session.status        |
| `session.diff`     | Deferred — diff view is Phase 4+ |


## Skipped (can add later)


| Event                                  | Notes                                   |
| -------------------------------------- | --------------------------------------- |
| `question.asked/replied/rejected`      | Agent question flow — add when needed   |
| `todo.updated`                         | Session task list — nice to have        |
| `lsp.updated`                          | LSP diagnostics — deferred              |
| `vcs.branch.updated`                   | Git branch info — deferred              |
| `session.compacted`                    | Compaction marker — cosmetic            |
| `server.connected`                     | Could trigger re-fetch on reconnect     |
| `server.instance.disposed`             | Could trigger full re-bootstrap         |
| `file.edited` / `file.watcher.updated` | File change events — deferred           |
| `mcp.tools.changed`                    | MCP tools — deferred                    |
| `installation.update-available`        | Version notification — Phase 5          |
| `pty.*`                                | Terminal process lifecycle — not needed |
| `tui.*`                                | TUI-specific — not applicable           |
| `message.part.removed`                 | Part deletion — rare edge case          |


## Part Types Not Rendered (fallback to label)


| Part Type    | Notes                                 |
| ------------ | ------------------------------------- |
| `subtask`    | Subagent invocation — show label only |
| `file`       | Attached file badge — deferred        |
| `patch`      | File diff — deferred (Phase 4+)       |
| `snapshot`   | Git snapshot ref — deferred           |
| `retry`      | API retry marker — show label         |
| `compaction` | Compaction marker — show label        |
| `step-start` | Step boundary — no visual needed      |
| `agent`      | Agent marker — show label only        |


