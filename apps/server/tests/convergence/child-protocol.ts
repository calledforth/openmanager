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
}

/** One step of a scripted prompt, run by the fake provider without a round trip. */
export type ScriptStep =
  | { op: 'text'; text: string }
  | { op: 'thought'; text: string }
  | { op: 'tool'; status: 'in_progress' | 'completed' | 'failed'; title?: string }
  | { op: 'complete'; stopReason?: string }

export type ProviderOp =
  | { op: 'emitText'; sessionId: string; text: string }
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
  /** Text produced inside the child at a steady rate, so the IPC channel is not the bottleneck. */
  | { op: 'streamText'; sessionId: string; bytesPerSecond: number; durationMs: number }
  | { op: 'setNewSessionDelay'; ms: number }
  /** Every prompt from now on runs these steps by itself; `null` returns to manual prompts. */
  | { op: 'setAutoScript'; steps: ScriptStep[] | null }

export type ServerOp =
  /** Resolves once nothing was published, provided or dispatched for `quietMs`. */
  | { op: 'waitQuiet'; quietMs: number; timeoutMs: number }
  /** The server's own read of a thread: `listSessionHistory` walked to the start. */
  | { op: 'readThread'; sessionId: string; threadId: string }
  /** The server's own session summaries (`listSessionSummaries` walked to the end), newest first. */
  | { op: 'readSessions' }
  /** Per-connection socket buffers, read from inside the server process (S15). */
  | { op: 'sampleSockets' }
  /** Graceful stop through `server.close()`, then exit. */
  | { op: 'shutdown' }

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
}

/** What the server's own read of a thread holds, shaped like a client thread. */
export interface ServerThreadRead {
  turns: unknown[]
  messages: unknown[]
  reasoning: unknown[]
  tools: unknown[]
  order: unknown[]
  interactions: Array<{ turnId: string; interaction: unknown }>
}
