import type {
  ContentBlock,
  Environment,
  ErrorCode,
  Interaction,
  InteractionResponse,
  Message,
  ProofEventSchemas,
  Session,
  Thread,
  Turn,
  TurnFailureReason,
  Workspace,
} from '@openmanager/protocol'
import type { z } from 'zod'

/** Rolled up from a session's turns so the sidebar never inspects threads. */
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'error'

export interface SessionSummary extends Session {
  status: SessionStatus
  threadIds: string[]
}

export interface ReasoningEntry {
  messageId: string
  turnId: string
  phase: 'start' | 'delta' | 'stop'
  content: ContentBlock[]
  tokens?: number
}

export type ToolState = z.infer<(typeof ProofEventSchemas)['tool.updated']['shape']['payload']>

export interface PendingInteraction {
  sessionId: string
  threadId: string
  turnId: string
  interaction: Interaction
}

export interface TurnFailure {
  turnId: string
  reason: TurnFailureReason
  message: string
}

export interface TurnNotice {
  turnId: string
  message: string
}

/**
 * `idle` means we only know the thread exists (its scope produced an event
 * before anybody opened it). `ready` means a snapshot or session.open has
 * replaced the thread state wholesale, so message history is trustworthy.
 */
export type HydrationState = 'idle' | 'loading' | 'ready' | 'failed'

export interface ThreadState {
  thread: Thread
  turns: Turn[]
  messages: Message[]
  reasoning: ReasoningEntry[]
  tools: ToolState[]
  interactions: PendingInteraction[]
  failures: TurnFailure[]
  notices: TurnNotice[]
  hydration: HydrationState
}

export type ConnectionPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface ConnectionFailure {
  code: ErrorCode
  message: string
}

export interface ConnectionState {
  phase: ConnectionPhase
  /** True once any handshake succeeded, so a later drop reads as "reconnecting". */
  hasConnected: boolean
  failure: ConnectionFailure | null
  /** Command names advertised by the environment; empty until the handshake lands. */
  capabilities: readonly string[]
}

/** Normalized, immutable. Every update produces a new root object. */
export interface EnvironmentState {
  environment: Environment | null
  workspaces: Record<string, Workspace>
  workspaceOrder: string[]
  sessions: Record<string, SessionSummary>
  sessionOrder: string[]
  threads: Record<string, ThreadState>
  activeSessionId: string | null
  activeThreadId: string | null
  connection: ConnectionState
}

export interface CreateSessionInput {
  workspaceId: string
  title?: string
}

export interface AddWorkspaceInput {
  name: string
  /** Environment-local path. Validation is the environment's job (CAL-51). */
  path: string
}

export interface ThreadTarget {
  sessionId: string
  threadId: string
}

export interface SendTurnInput extends ThreadTarget {
  text: string
}

export interface InterruptTurnInput extends ThreadTarget {
  turnId: string
}

export interface RespondToInteractionInput extends ThreadTarget {
  response: InteractionResponse
}

/**
 * Everything React may ask an environment to do. Reads return data; writes
 * also fold their result into the store so callers rarely need the value.
 */
export interface EnvironmentCommands {
  getEnvironment(): Promise<Environment>
  listWorkspaces(): Promise<Workspace[]>
  addWorkspace(input: AddWorkspaceInput): Promise<Workspace>
  removeWorkspace(workspaceId: string): Promise<void>
  listSessions(workspaceId: string): Promise<SessionSummary[]>
  createSession(input: CreateSessionInput): Promise<{ session: Session; thread: Thread }>
  /** Hydrates the session's threads and makes it (and its first thread) active. */
  openSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, title: string | null): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  sendTurn(input: SendTurnInput): Promise<{ turn: Turn; userMessage: Message }>
  interruptTurn(input: InterruptTurnInput): Promise<void>
  respondToInteraction(input: RespondToInteractionInput): Promise<void>
}

export type EnvironmentCommandName = keyof EnvironmentCommands

export type Unsubscribe = () => void

/**
 * The single seam between visual components and any environment. Reads are
 * external-store style (`getState` + `subscribe`) so React can bind them with
 * `useSyncExternalStore`; writes go through `commands`.
 */
export interface EnvironmentClient {
  readonly commands: EnvironmentCommands
  getState(): EnvironmentState
  subscribe(listener: () => void): Unsubscribe
  /** Whether the environment advertises the command. Unknown before handshake. */
  supports(command: EnvironmentCommandName): boolean
  /** Local selection; does not hydrate. Use `commands.openSession` for that. */
  setActiveSession(sessionId: string | null): void
  setActiveThread(threadId: string | null): void
  connect(): void
  disconnect(): void
  /** Releases timers and sockets. The client is unusable afterwards. */
  dispose(): void
}
