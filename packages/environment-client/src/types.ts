import type {
  Environment,
  EnvironmentSettings,
  EnvironmentSettingsPatch,
  ErrorCode,
  FilesystemListing,
  HistoryCursor,
  Interaction,
  InteractionResponse,
  Message,
  PlanHistoryEntry,
  ProviderBootstrap,
  ProviderCatalogEntry,
  Session,
  SessionComposerState,
  SessionListCursor,
  SessionStatus,
  SessionTitleSource,
  Thread,
  Turn,
  UploadResult,
  Workspace,
  WorkspaceComposerPreference,
} from '@openmanager/protocol'
import type {
  ActivityRef,
  ReasoningEntry,
  ToolState,
  PendingInteraction,
  TurnFailure,
} from '@agentpack/view/protocol'
export type {
  ActivityRef,
  ReasoningEntry,
  ToolState,
  PendingInteraction,
  TurnFailure,
} from '@agentpack/view/protocol'

export type {
  EnvironmentSettings,
  EnvironmentSettingsPatch,
  FilesystemListing,
  ProviderCatalogEntry,
  SessionComposerState,
  SessionStatus,
  WorkspaceComposerPreference,
}

/** Protocol summary plus the thread IDs this client has already learned. */
export interface SessionSummary extends Session {
  /** Absent until the environment has named the session; see docs/session-titles.md. */
  titleSource?: SessionTitleSource
  status: SessionStatus
  providerId?: string
  updatedAt?: string
  /** When the user settled the session; null or absent while it is active. */
  settledAt?: string | null
  /**
   * When the last turn completed, while nobody has opened the session since.
   * Null or absent means there is nothing unseen.
   */
  doneAt?: string | null
  /**
   * The session's own model, mode and config selection, kept current by
   * `session.composer.updated`. Absent until the environment reports one.
   */
  composer?: SessionComposerState
  threadIds: string[]
}

export interface SessionListPage {
  sessions: SessionSummary[]
  nextCursor: SessionListCursor | null
}

export interface SessionHistoryPage {
  messages: Message[]
  turns: Turn[]
  interactions: Array<{ threadId: string; interaction: Interaction }>
  plans?: PlanHistoryEntry[]
  nextCursor: HistoryCursor | null
}

export interface ListSessionsInput {
  workspaceId?: string
  cursor?: SessionListCursor
  limit?: number
}

export interface LoadSessionHistoryInput {
  sessionId: string
  threadId: string
  cursor?: HistoryCursor
  limit?: number
}

/**
 * A user message echoed locally the moment it was sent, before the
 * environment confirmed it. Keyed by the command id the send carries, so the
 * response, the `turn.started` event and a retry all resolve the same row.
 */
export interface OutboxEntry {
  commandId: string
  text: string
  /** Uploaded artifacts the send names, so a retry carries them again. */
  artifactIds?: string[]
  status: 'pending' | 'failed'
  /** Why the send failed. Set only while `status` is `failed`. */
  error?: string
}

export interface TurnNotice {
  turnId: string
  message: string
}

/**
 * `idle` means we only know the thread exists (its scope produced an event
 * before anybody opened it). `ready` means a snapshot or session.history page
 * has replaced the thread state wholesale, so message history is trustworthy.
 */
export type HydrationState = 'idle' | 'loading' | 'ready' | 'failed'

export interface ThreadState {
  thread: Thread
  turns: Turn[]
  messages: Message[]
  reasoning: ReasoningEntry[]
  tools: ToolState[]
  /** Messages, reasoning and tools in arrival order; see `ProtocolThreadView.order`. */
  order: ActivityRef[]
  interactions: PendingInteraction[]
  failures: TurnFailure[]
  notices: TurnNotice[]
  /** Sends still waiting on the environment, oldest first, newest last. */
  outbox: OutboxEntry[]
  hydration: HydrationState
  /** Exclusive boundary for the next older persisted page. */
  historyCursor?: HistoryCursor | null
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
  /** Failed connection attempts since the last successful handshake. */
  attempt: number
  /**
   * The client has stopped retrying on its own: a terminal failure (auth,
   * protocol, capability) or an exhausted `maxAttempts`. Only `connect()`
   * brings it back. See `docs/connection-retry.md`.
   */
  retriesExhausted: boolean
}

/** Normalized, immutable. Every update produces a new root object. */
export interface EnvironmentState {
  environment: Environment | null
  workspaces: Record<string, Workspace>
  workspaceOrder: string[]
  sessions: Record<string, SessionSummary>
  sessionOrder: string[]
  threads: Record<string, ThreadState>
  /**
   * Providers and their health, seeded by the handshake and kept current by
   * `provider_health_changed`. The composer profile (models, modes, defaults)
   * is absent on an entry until `getProviderCatalog` has read it.
   */
  providers: Record<string, ProviderCatalogEntry>
  providerOrder: string[]
  /**
   * Remembered composer choices, by workspace ID and then provider ID. An
   * entry exists only once a composer command has answered for that pair, so
   * a missing entry means "not loaded", never "no preference".
   */
  composerPreferences: Record<string, Record<string, WorkspaceComposerPreference>>
  activeSessionId: string | null
  activeThreadId: string | null
  /**
   * Last failed open, including sessions whose threads have not loaded yet.
   * `code` lets the UI branch without matching prose: `workspace_unavailable`
   * means the project folder is gone or unreadable, so the fix is on disk and
   * the only moves are retrying after restoring it or deleting the session.
   * `availability` is the cause the environment reported with that error, so
   * the pane names it even before the workspace list catches up.
   */
  sessionOpenFailure?: {
    sessionId: string
    message: string
    code: ErrorCode
    availability?: 'missing' | 'inaccessible'
  } | null
  connection: ConnectionState
}

export interface CreateSessionInput {
  environmentId: string
  workspaceId: string
  providerId: string
  firstMessage?: string
  title?: string
  /** Picks made in the draft; the environment files them before it starts the provider. */
  preference?: WorkspaceComposerPreference
  /** The mode the first message runs in. Needs `firstMessage`. */
  modeId?: string
  /** Images the draft uploaded for this workspace; they ride the first message. */
  artifactIds?: string[]
}

export interface AddWorkspaceInput {
  /** Environment-local absolute path; the environment validates and canonicalizes it. */
  path: string
  /** Display name; the environment derives one from the folder when omitted. */
  name?: string
}

export interface ThreadTarget {
  sessionId: string
  threadId: string
}

export interface SendTurnInput extends ThreadTarget {
  text: string
  /** Artifacts already uploaded to this session that the prompt attaches. */
  artifactIds?: string[]
  /**
   * Identity of this send, stable across retries. Retrying with the same id
   * reuses the optimistic row and never produces a second message. Generated
   * by the client when omitted.
   */
  commandId?: string
}

/** An artifact is only ever addressed inside the session that owns it. */
export interface ArtifactTarget {
  sessionId: string
  artifactId: string
}

/** A file the composer attaches. The environment stores it under the session. */
/**
 * One file for one session, or for a draft's workspace: a draft has no
 * session yet, so its upload is held there until the `createSession` that
 * launches it names it in `artifactIds`. Exactly one of the two.
 */
export type UploadArtifactInput = (
  { sessionId: string; workspaceId?: never } | { workspaceId: string; sessionId?: never }
) & {
  /** Display name only; it never becomes a path on the environment. */
  name: string
  mimeType: string
  bytes: Blob
}

/** What a stored upload is known as; `sendTurn` attaches it by `artifactId`. */
export type UploadedArtifact = UploadResult

export interface InterruptTurnInput extends ThreadTarget {
  turnId: string
}

export interface RespondToInteractionInput extends ThreadTarget {
  response: InteractionResponse
  /** Accept and implement a plan using its provider's continuation rule. */
  build?: { text: string; modeId?: string }
  /**
   * Identity of this answer, stable across retries. The environment treats a
   * repeat of the id that settled the interaction as success, and any other
   * answer to a settled interaction as a conflict. Generated when omitted.
   */
  commandId?: string
}

export interface ComposerPreferenceTarget {
  workspaceId: string
  providerId: string
}

export interface SetComposerPreferenceInput extends ComposerPreferenceTarget {
  /** A patch: fields left out keep the value the environment already holds. */
  preference: WorkspaceComposerPreference
}

export interface ProbeProviderInput {
  providerId: string
  /** Probes run in a registered workspace; the environment resolves its folder. */
  workspaceId: string
}

export interface SetSessionModelInput {
  sessionId: string
  modelId: string
}

export interface SetSessionModeInput {
  sessionId: string
  modeId: string
}

export interface SetSessionConfigOptionInput {
  sessionId: string
  configId: string
  value: string | boolean
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
  /** The workspace's icon as a data URL, or null when the folder has none. Not stored. */
  resolveWorkspaceIcon(workspaceId: string): Promise<string | null>
  listSessions(input?: ListSessionsInput | string): Promise<SessionListPage>
  createSession(
    input: CreateSessionInput,
  ): Promise<{ session: Session; thread: Thread; firstTurn?: { turn: Turn; userMessage: Message } }>
  /** Loads thread identities, then the newest history page for each thread. */
  openSession(sessionId: string): Promise<void>
  loadSessionHistory(input: LoadSessionHistoryInput): Promise<SessionHistoryPage>
  renameSession(sessionId: string, title: string | null): Promise<void>
  /** Move a session out of the active list (`true`) or back into it (`false`). */
  settleSession(sessionId: string, settled: boolean): Promise<void>
  /** The user has looked at a finished session; every client stops showing it as done. */
  acknowledgeSession(sessionId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  sendTurn(input: SendTurnInput): Promise<{ turn: Turn; userMessage: Message }>
  interruptTurn(input: InterruptTurnInput): Promise<void>
  respondToInteraction(input: RespondToInteractionInput): Promise<void>
  getProviderCatalog(): Promise<ProviderCatalogEntry[]>
  /** Re-checks one provider now; resolves with its entry once the probe settles. */
  probeProvider(input: ProbeProviderInput): Promise<ProviderBootstrap>
  getComposerPreference(input: ComposerPreferenceTarget): Promise<WorkspaceComposerPreference>
  setComposerPreference(input: SetComposerPreferenceInput): Promise<WorkspaceComposerPreference>
  /**
   * The session setters change the live session and remember the choice for
   * the session's workspace and provider; each resolves with that preference.
   */
  setSessionModel(input: SetSessionModelInput): Promise<WorkspaceComposerPreference>
  setSessionMode(input: SetSessionModeInput): Promise<WorkspaceComposerPreference>
  setSessionConfigOption(input: SetSessionConfigOptionInput): Promise<WorkspaceComposerPreference>
  /**
   * The child folders of a folder on the environment's machine, for picking a
   * project. `~` is its home folder; no path lists where Add project starts.
   */
  browseFolders(path?: string): Promise<FilesystemListing>
  /** Settings the environment shares with every client. Not stored. */
  getEnvironmentSettings(): Promise<EnvironmentSettings>
  /** A patch: settings left out keep their value. Resolves with all of them. */
  setEnvironmentSettings(patch: EnvironmentSettingsPatch): Promise<EnvironmentSettings>
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
  /**
   * Read an artifact's bytes over the environment's authorized HTTP route.
   * Bytes never travel on the command channel. Clients that have no such
   * route leave this out, and views show the image as unavailable.
   */
  fetchArtifact?(input: ArtifactTarget, init?: { signal?: AbortSignal }): Promise<Blob>
  /**
   * Store a prompt attachment on the environment: a ticket on the command
   * channel, then the bytes over the same authorized HTTP route family as
   * `fetchArtifact`. Clients with no such route leave this out, and the
   * composer offers no image upload.
   */
  uploadArtifact?(
    input: UploadArtifactInput,
    init?: { signal?: AbortSignal },
  ): Promise<UploadedArtifact>
  /** Local selection; does not hydrate. Use `commands.openSession` for that. */
  setActiveSession(sessionId: string | null): void
  setActiveThread(threadId: string | null): void
  connect(): void
  disconnect(): void
  /** Releases timers and sockets. The client is unusable afterwards. */
  dispose(): void
}
