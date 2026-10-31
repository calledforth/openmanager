/**
 * The IPC contract between the test process and the server child. Plain data
 * only: both ends serialize it with the `advanced` IPC channel.
 */

export interface ChildConfig {
  dataDir: string
  workspaceRoot: string
  /** `Host` values the proxy's URL produces, so requests through it are accepted. */
  allowedHosts: string[]
  /** How long the fake provider's `session/new` takes, in milliseconds. */
  newSessionDelayMs: number
  /** Armed from the start, so a kill can land inside boot (recovery, the repair). */
  killAt?: KillAt
}

/**
 * Kill the server child (SIGKILL, from inside) at a commit of the event log:
 * just before COMMIT (`before`: neither the rows nor the events land) or just
 * after it (`after`: both land, and nothing has been published). The commit
 * is the `skip`+1-th one whose records include an event named `name`.
 */
export interface KillAt {
  phase: 'before' | 'after'
  name: string
  skip?: number
  /**
   * Count only a record a producer wrote, not one the repository's status
   * pass derived (`isDerivedRecord`): a turn or a new session also commits
   * a derived `workspace.updated` for the recency it moved (§4.7.1).
   */
  producer?: boolean
}

/** One step of a scripted prompt, run by the fake provider without a round trip. */
export type ScriptStep =
  | { op: 'text'; text: string }
  | { op: 'thought'; text: string }
  | { op: 'tool'; status: 'in_progress' | 'completed' | 'failed'; title?: string }
  | { op: 'complete'; stopReason?: string }

export type ProviderOp =
  | { op: 'emitText'; sessionId: string; text: string }
  | { op: 'emitCommands'; sessionId: string; names: string[] }
  | { op: 'emitThought'; sessionId: string; text: string }
  | { op: 'openTool'; sessionId: string; toolCallId: string; title?: string }
  | {
      op: 'updateTool'
      sessionId: string
      toolCallId: string
      status: 'pending' | 'in_progress' | 'completed' | 'failed'
    }
  | { op: 'askPermission'; sessionId: string; toolCallId: string; title?: string }
  /** Cursor's own question request (`cursor/ask_question`); the session must run on Cursor. */
  | { op: 'askQuestion'; sessionId: string; questionId: string }
  | { op: 'completeTurn'; sessionId: string; stopReason?: string }
  | { op: 'crashProvider'; sessionId: string }
  /** An image the artifact store refuses, so the server publishes a transient `turn.notice`. */
  | { op: 'emitUnstorableImage'; sessionId: string }
  /** An OpenCode `task` tool that names a child provider session (`subtask_update`). */
  | { op: 'emitSubtask'; sessionId: string; toolCallId: string; childProviderSessionId: string }
  /**
   * Text, then an image the artifact store refuses, in one step: the notice
   * is published while the text still waits in the batcher, whatever the
   * host's scheduling (S5).
   */
  | { op: 'emitTextThenUnstorableImage'; sessionId: string; text: string }
  /** Text produced inside the child at a steady rate, so the IPC channel is not the bottleneck. */
  | { op: 'streamText'; sessionId: string; bytesPerSecond: number; durationMs: number }
  | { op: 'setNewSessionDelay'; ms: number }
  /**
   * The fake Claude Code SDK (sessions on provider `claude`): wait for the
   * runtime's `prompts`-th prompt, report a background-task roster
   * (`background_tasks_changed`, REPLACE semantics), or end the prompted turn.
   */
  | { op: 'claudeWaitPrompt'; prompts: number }
  | {
      op: 'claudeBackground'
      tasks: Array<{ task_id: string; task_type: string; description: string }>
    }
  | { op: 'claudeComplete' }
  /** Every prompt from now on runs these steps by itself; `null` returns to manual prompts. */
  | { op: 'setAutoScript'; steps: ScriptStep[] | null }

export type ServerOp =
  /** Resolves once nothing was published, provided or dispatched for `quietMs`. */
  | { op: 'waitQuiet'; quietMs: number; timeoutMs: number }
  /** The server's own read of a thread: `readThreadState`, the whole thread. */
  | { op: 'readThread'; sessionId: string; threadId: string }
  /** The threads the server holds for a session (`listThreadsForSession`), whatever any client knows. */
  | { op: 'readSessionThreads'; sessionId: string }
  /** The server's own session summaries (`listSessionSummaries` walked to the end), newest first. */
  | { op: 'readSessions' }
  /** Per-connection socket buffers, read from inside the server process (S15). */
  | { op: 'sampleSockets' }
  /** Every row of the provenance audit (provenance.ts), oldest first. */
  | { op: 'readAudit' }
  /** Sessions whose row holds no provider session identity, read from the database. */
  | { op: 'readUnidentified' }
  /** Graceful stop through `server.close()`, then exit. */
  | { op: 'shutdown' }
  /** How many bytes the running `streamText` has handed the server, and since when. */
  | { op: 'readStreamed' }
  /** Arm a kill at a commit (see `KillAt`); `null` disarms. */
  | { op: 'armKill'; at: KillAt | null }
  /**
   * F4's delivery seam (docs/sync-foundations.md §5.5, S13): the next
   * durable `message.delta` of this thread leaves the delivery queue and
   * reaches no socket. A scenario holds one connection on the thread, so it
   * is lost for exactly that connection. Nothing else is touched.
   */
  | { op: 'dropNextRecord'; threadId: string }
  /** The records the seam dropped so far: thread, sequence, event. */
  | { op: 'readDropped' }

export type ChildRequest = (ProviderOp | ServerOp) & { id: number }

export type ChildReply =
  | { type: 'reply'; id: number; ok: true; result: unknown }
  | { type: 'reply'; id: number; ok: false; error: string }

export type ChildEvent =
  | { type: 'ready'; port: number; environmentId: string; pid: number }
  | { type: 'fatal'; error: string }
  /** The server closed a socket itself: heartbeat, slow consumer, shutdown, protocol. */
  | {
      type: 'serverClose'
      socket: number
      remotePort: number | undefined
      code: number | undefined
      reason: string
      at: number
    }

export type ChildMessage = ChildReply | ChildEvent

export interface SocketSample {
  socket: number
  remotePort: number | undefined
  readyState: number
  bufferedAmount: number
  /** The server writer's bytes not yet written. */
  queued: number
  /** Bytes written and not yet acknowledged by the client. */
  inFlight: number
  window: number
  /** Subscriptions of this socket that are lagging. */
  lagging: number
}

/**
 * The test-only audit the server child keeps with SQLite triggers on its temp
 * database (server-child.ts): every event appended, every write to a
 * session's `updated_at` or provider identity, every workspace `last_used_at`,
 * and markers around each boot, so boot-time recovery is told apart. `seq` is the
 * one order all of them share.
 */
export type AuditRow =
  | {
      seq: number
      kind: 'event'
      scopeKey: string
      sequence: number
      name: string
      eventId: string
      /** The event's timestamp, epoch ms (event_log.created_at). */
      ts: number
      sessionId: string | null
      workspaceId: string | null
      threadId: string | null
      /** `session.updated` names a title. */
      title: boolean
      status: string | null
      /** `workspace.updated`'s value. */
      lastActivityAt: string | null
    }
  | {
      seq: number
      kind: 'session'
      op: 'insert' | 'update' | 'delete'
      sessionId: string
      workspaceId: string
      old: number | null
      new: number | null
      oldProvider: string | null
      newProvider: string | null
    }
  | {
      seq: number
      kind: 'workspace'
      workspaceId: string
      old: number | null
      new: number | null
    }
  /** A server process starting on an existing database (`start`), and done booting (`boot`). */
  | { seq: number; kind: 'start' | 'boot' }

/**
 * What the server owed and sent each socket, logged by the server child as it
 * happens (one JSON line each, so a hard kill loses nothing written). `s` is
 * the socket (`pid:n`), `port` its remote port as the server sees it, `a`
 * the audit's `seq` when the line was written.
 */
export type Delivery = { s?: string; port?: number; a: number; at: number } & (
  | {
      k: 'grant'
      key: string
      mode: 'live' | 'replay' | 'snapshot'
      /** Replay: the last sequence it carried; snapshot: its cursor. */
      base: number | null
      replayed: number[]
    }
  | { k: 'refuse'; key: string; code: string | null }
  | { k: 'request'; name: string; key: string | null; requestId: string }
  | { k: 'end'; key: string | null }
  | { k: 'closed' }
  | {
      k: 'publish'
      key: string
      seq: number
      name: string
      /** Open sockets holding a subscription to the scope when it was published. */
      owed: string[]
      /** Sockets whose subscription request for the scope was received and not yet answered. */
      pending: string[]
      /** Sockets it was handed to (`ws.send`). */
      sent: string[]
      /** Owed, not handed over, and still open afterwards: the server's own loss. */
      withheld: string[]
    }
  | {
      k: 'carried'
      /** Values a response handed the socket: workspace recency and session times. */
      workspaces: Record<string, string | null>
      sessions: Record<string, string>
      /** A `session.create` answer's `announcedAt`, which the client also takes as recency. */
      announced: { workspaceId: string; at: string } | null
    }
)

/** The file the server child appends `Delivery` lines to, in its data directory. */
export const DELIVERIES_FILENAME = 'convergence-deliveries.jsonl'

/** What the server's own read of a thread holds, shaped like a client thread. */
export interface ServerThreadRead {
  turns: unknown[]
  messages: unknown[]
  reasoning: unknown[]
  tools: unknown[]
  order: unknown[]
  interactions: Array<{ turnId: string; interaction: unknown }>
  listing: unknown
}
