import {
  ACCESS_CAPABILITIES,
  ClientLabelSchema,
  ComposerCommandSchemas,
  DRAFT_CHANGED_MESSAGE,
  DRAFT_DELETED_MESSAGE,
  DraftCommandSchemas,
  PAIRING_LINK_LIFETIME_MS,
  PAIRING_TOKEN_ALPHABET,
  PAIRING_TOKEN_LENGTH,
  PairingTokenSchema,
  ProofEventSchemas,
  ProofCommandSchemas,
  ProviderCatalogEntrySchema,
  WorkspaceComposerPreferenceSchema,
  type AuthorizedClient,
  type AuthorizedClientList,
  type AccessCapability,
  type Draft,
  type DraftTombstone,
  type Environment,
  type EnvironmentSettings,
  type Interaction,
  type InteractionResponse,
  type Message,
  type PairingLink,
  type PairingRejectionReason,
  type ProofEvent,
  type ProviderCatalogEntry,
  type Session,
  type Thread,
  type Turn,
  type TurnFailureReason,
  type TurnStart,
  type Workspace,
  type WorkspaceComposerPreference,
} from '@openmanager/protocol'
import { EnvironmentClientError } from './errors'
import {
  applyActiveSession,
  applyActiveThread,
  applyComposerPreference,
  applyConnection,
  applyEnvironment,
  applyEvent,
  applyProviderCatalog,
  applyProviderProbe,
  applySessionCreated,
  applySessionHistory,
  applySessionOpen,
  applySessionOpening,
  applyTurnSendFailed,
  applyTurnSending,
  applyTurnStarted,
  applyWorkspaceList,
  applyWorkspaceRemoved,
  createInitialState,
  createThreadState,
  deriveSessionStatus,
  selectSessionList,
} from './state'
import { createSettleTracker } from './settle'
import { applyDraftList } from './draft-state'
import { createDraftSync } from './draft-sync'
import { createEnvironmentStore } from './store'
import { pageSessionSummaries, pageThreadMessages } from './pagination'
import type {
  ComposerPreferenceTarget,
  SessionComposerState,
  ConnectionState,
  EnvironmentClient,
  EnvironmentCommandName,
  EnvironmentCommands,
  EnvironmentState,
  SendTurnInput,
  SessionStatus,
  ThreadTarget,
} from './types'
import { UPLOAD_TICKET_COMMAND, WIRE_COMMANDS } from './wire'

export interface MockSeedSession {
  session: Session
  status?: SessionStatus
  providerId?: string
  updatedAt?: string
  threads?: Thread[]
  turns?: Turn[]
  messages?: Message[]
}

export interface MockSeed {
  environment?: Environment
  workspaces?: Workspace[]
  /** Icon data URLs by workspace ID; workspaces without an entry answer null. */
  workspaceIcons?: Record<string, string>
  /** What `getProviderCatalog` answers. Already in state when the mock advertises it. */
  providers?: ProviderCatalogEntry[]
  /**
   * Preferences the environment remembers, by workspace ID then provider ID.
   * Like the wire, they reach state only once a composer command answers.
   */
  composerPreferences?: Record<string, Record<string, WorkspaceComposerPreference>>
  sessions?: MockSeedSession[]
  activeSessionId?: string | null
  /** Stored bytes by artifact ID; what `fetchArtifact` and a send's `artifactIds` resolve. */
  artifacts?: Record<string, Blob>
  /**
   * The environment's folders for `browseFolders`: child folder names by
   * absolute folder path. A path with no entry is not there.
   */
  folders?: Record<string, readonly string[]>
  /** What `~` means, and where browsing starts with no setting. Defaults to the first folder. */
  home?: string
  environmentSettings?: Partial<EnvironmentSettings>
  /**
   * The device list. Defaults to a single connected owner, which is this
   * client; `currentClientId` names this client when the list is seeded.
   */
  authorizedClients?: readonly AuthorizedClient[]
  currentClientId?: string
  /** Pairing links, each with the token that opens it, as if another device had made them. */
  pairingLinks?: ReadonlyArray<{ link: PairingLink; token: string }>
}

export interface MockTurnContext extends ThreadTarget {
  turnId: string
  text: string
}

export interface MockEnvironmentClientOptions {
  seed?: MockSeed
  /** Commands the mock advertises. Defaults to all of them. */
  capabilities?: readonly EnvironmentCommandName[]
  /**
   * Whether the mock advertises `upload.ticket.create` and stores uploads.
   * Gated separately from `sendTurn`, as it is on the wire, so an
   * environment that takes turns but not uploads can be modelled. Defaults
   * to following `sendTurn`.
   */
  uploads?: boolean
  /** Pause before a draft edit is saved; defaults to `latencyMs`. */
  draftSaveDebounceMs?: number
  /**
   * Chunks streamed as the assistant reply after `sendTurn`. Return `null` to
   * leave the turn running so a test can script it by hand. Defaults to an echo.
   */
  respond?: ((turn: MockTurnContext) => readonly string[] | null) | null
  /** Delay between streamed chunks. Zero still yields to the event loop. */
  chunkDelayMs?: number
  /** Latency added to every command. Zero still yields to the event loop. */
  latencyMs?: number
  now?: () => string
  nextId?: () => string
}

export interface MockTurnTarget extends ThreadTarget {
  turnId: string
}

export interface MockCommandCall {
  command: EnvironmentCommandName
  input: unknown
}

/**
 * Drives the same reducers as the WebSocket client, but from in-process
 * protocol-valid events. Anything the mock emits is parsed against the
 * protocol schemas so a test cannot pass with data the wire would reject.
 */
export interface MockEnvironmentClient extends EnvironmentClient {
  readonly calls: readonly MockCommandCall[]
  emit(event: ProofEvent): void
  /** Streams text into an assistant message and returns its ID. */
  streamAssistantText(target: MockTurnTarget, text: string, messageId?: string): string
  completeTurn(target: MockTurnTarget): void
  interruptTurn(target: MockTurnTarget): void
  failTurn(target: MockTurnTarget, reason: TurnFailureReason, message: string): void
  requestInteraction(target: MockTurnTarget, interaction: Interaction): void
  notice(target: MockTurnTarget, message: string): void
  setConnection(patch: Partial<ConnectionState>): void
  /**
   * Drop, rehydrate the active session from a `session.open` snapshot, and
   * mark the client connected again. Replayed resource IDs do not duplicate.
   */
  reconnect(): void
  /** Resolves once all scheduled streaming has drained. */
  settle(): Promise<void>
  /**
   * Another device trading a pairing token at `POST /pair`: the link is used
   * and a `paired` client joins the device list. Throws with the refusal's
   * reason in `details.reason`, as the environment would answer.
   */
  pairDevice(token: string, label?: string): AuthorizedClient
}

const ALL_COMMANDS = Object.keys(WIRE_COMMANDS) as EnvironmentCommandName[]

/** Last path segment, for either separator; the whole path when there is none. */
const workspaceNameFromPath = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed
}

const wireCapabilities = (capabilities: ReadonlySet<EnvironmentCommandName>, uploads: boolean) => [
  ...[...capabilities].map((command) => WIRE_COMMANDS[command]),
  ...(uploads ? [UPLOAD_TICKET_COMMAND] : []),
]

const defaultIds = () => {
  let counter = 0
  return () => `mock-${++counter}`
}

export function createMockEnvironmentClient(
  options: MockEnvironmentClientOptions = {},
): MockEnvironmentClient {
  const nextId = options.nextId ?? defaultIds()
  const now = options.now ?? (() => new Date().toISOString())
  const chunkDelayMs = options.chunkDelayMs ?? 0
  const latencyMs = options.latencyMs ?? 0
  const artifacts: Record<string, Blob> = { ...options.seed?.artifacts }
  /** A draft's uploads, by artifact id, and the workspace each is held for. */
  const heldArtifacts = new Map<string, string>()
  const respond =
    options.respond === undefined
      ? (turn: MockTurnContext) => splitChunks(`You said: ${turn.text}`)
      : options.respond
  const capabilities = new Set(options.capabilities ?? ALL_COMMANDS)
  const uploads = options.uploads ?? capabilities.has('sendTurn')
  const environment: Environment = options.seed?.environment ?? {
    environmentId: 'mock-environment',
    name: 'Mock environment',
  }
  const store = createEnvironmentStore(seedState(environment, options.seed, capabilities, uploads))
  const settles = createSettleTracker(store, now)
  const calls: MockCommandCall[] = []
  let openGeneration = 0
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const drains = new Set<() => void>()
  const pendingCommands = new Set<(error: EnvironmentClientError) => void>()
  let disposed = false

  const drainIfIdle = () => {
    if (timers.size !== 0) return
    for (const resolve of [...drains]) resolve()
    drains.clear()
  }

  const schedule = (fn: () => void, delayMs: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      try {
        fn()
      } finally {
        drainIfIdle()
      }
    }, delayMs)
    timers.add(timer)
    return timer
  }

  const settle = () =>
    new Promise<void>((resolve) => {
      if (timers.size === 0) resolve()
      else drains.add(resolve)
    })

  const emit = (event: ProofEvent) => {
    const schema = ProofEventSchemas[event.name] as { parse(input: unknown): ProofEvent }
    const parsed = schema.parse(event)
    const folded = settles.mask(parsed)
    store.update((state) => applyEvent(state, folded))
    // The mock plays the server as well as the client. Emit the authoritative
    // summary update explicitly; production reducers never derive it from history.
    if (
      parsed.scope.type === 'thread' &&
      (parsed.name === 'turn.started' ||
        parsed.name === 'turn.completed' ||
        parsed.name === 'turn.interrupted' ||
        parsed.name === 'turn.failed' ||
        parsed.name === 'interaction.requested' ||
        parsed.name === 'interaction.resolved' ||
        parsed.name === 'interaction.expired')
    ) {
      const state = store.getState()
      const session = state.sessions[parsed.scope.sessionId]
      if (session) {
        const working = !!session.backgroundTasks?.length
        const derived = deriveSessionStatus(session.threadIds.map((id) => state.threads[id]!))
        // Like the environment, a session with background work still running
        // rests at running rather than idle.
        const status = derived === 'idle' && working ? 'running' : derived
        // Like the environment, a turn or a question brings a settled session back.
        const unsettle =
          !!session.settledAt &&
          (parsed.name === 'turn.started' || parsed.name === 'interaction.requested')
        // Only a completed turn leaves news, and only once nothing is left
        // running; any other ending or a new turn clears it.
        const doneAt =
          parsed.name === 'turn.completed' && !working
            ? parsed.timestamp
            : parsed.name === 'turn.completed'
              ? null
              : parsed.name === 'turn.started' ||
                  parsed.name === 'turn.interrupted' ||
                  parsed.name === 'turn.failed'
                ? null
                : undefined
        const doneChanged = doneAt !== undefined && doneAt !== (session.doneAt ?? null)
        if (status !== session.status || unsettle || doneChanged)
          emit({
            ...base(),
            name: 'session.updated',
            scope: envScope(),
            payload: {
              sessionId: session.sessionId,
              status,
              ...(unsettle ? { settledAt: null } : {}),
              ...(doneChanged ? { doneAt } : {}),
            },
          })
      }
    }
  }

  const envScope = () =>
    ({ type: 'environment', environmentId: environment.environmentId }) as const
  const threadScope = (target: ThreadTarget) =>
    ({
      type: 'thread',
      environmentId: environment.environmentId,
      sessionId: target.sessionId,
      threadId: target.threadId,
    }) as const

  const base = () => ({ type: 'event' as const, eventId: nextId(), timestamp: now() })

  const requireThread = (target: ThreadTarget) => {
    const thread = store.getState().threads[target.threadId]
    if (!thread || thread.thread.sessionId !== target.sessionId) {
      throw new EnvironmentClientError('not_found', 'Thread not found.')
    }
    return thread
  }

  const gate = (command: EnvironmentCommandName) => {
    if (disposed) throw new EnvironmentClientError('unavailable', 'Client is disposed.')
    if (!capabilities.has(command)) throw EnvironmentClientError.unsupported(command)
  }

  const run = <T>(command: EnvironmentCommandName, input: unknown, work: () => T) =>
    new Promise<T>((resolve, reject) => {
      calls.push({ command, input })
      try {
        gate(command)
      } catch (error) {
        reject(error)
        return
      }
      pendingCommands.add(reject)
      schedule(() => {
        pendingCommands.delete(reject)
        try {
          resolve(work())
        } catch (error) {
          reject(error)
        }
      }, latencyMs)
    })

  const streamAssistantText = (target: MockTurnTarget, text: string, messageId = nextId()) => {
    requireThread(target)
    emit({
      ...base(),
      name: 'message.delta',
      scope: threadScope(target),
      payload: {
        messageId,
        turnId: target.turnId,
        role: 'assistant',
        content: { type: 'text', text },
      },
    })
    return messageId
  }

  const scriptedReplies = new Map<string, ReturnType<typeof setTimeout>[]>()
  const cancelScript = (turnId: string) => {
    for (const timer of scriptedReplies.get(turnId) ?? []) {
      clearTimeout(timer)
      timers.delete(timer)
    }
    scriptedReplies.delete(turnId)
    drainIfIdle()
  }

  /** Cancel every scripted reply for turns that belong to the given threads. */
  const cancelScriptsForThreads = (threadIds: readonly string[]) => {
    const state = store.getState()
    for (const threadId of threadIds) {
      for (const turn of state.threads[threadId]?.turns ?? []) cancelScript(turn.turnId)
    }
  }

  const completeTurn = (target: MockTurnTarget) => {
    requireThread(target)
    cancelScript(target.turnId)
    emit({
      ...base(),
      name: 'turn.completed',
      scope: threadScope(target),
      payload: { turnId: target.turnId },
    })
  }

  const scriptReply = (turn: MockTurnContext, chunks: readonly string[]) => {
    const messageId = nextId()
    const pending: ReturnType<typeof setTimeout>[] = []
    chunks.forEach((chunk, index) => {
      pending.push(
        schedule(() => streamAssistantText(turn, chunk, messageId), chunkDelayMs * (index + 1)),
      )
    })
    pending.push(
      schedule(
        () => {
          scriptedReplies.delete(turn.turnId)
          const current = store.getState().threads[turn.threadId]
          const active = current?.turns.find((item) => item.turnId === turn.turnId)
          if (active?.state === 'running') completeTurn(turn)
        },
        chunkDelayMs * (chunks.length + 1),
      ),
    )
    scriptedReplies.set(turn.turnId, pending)
  }

  /** What each command id already started, keyed like the environment's own. */
  const startedCommands = new Map<string, TurnStart>()
  const commandKey = (target: ThreadTarget, commandId: string) => `${target.threadId}:${commandId}`

  const catalog = (options.seed?.providers ?? []).map((entry) =>
    ProviderCatalogEntrySchema.parse(entry),
  )
  /** The environment's side of the preferences; state only sees answered reads. */
  const preferences = new Map<string, WorkspaceComposerPreference>()
  let environmentSettings: EnvironmentSettings = {
    addProjectStartsIn: '',
    titleGeneration: { provider: 'codex', model: '' },
    ...options.seed?.environmentSettings,
  }
  // The device list, as the environment keeps it for admin holders.
  const seededAt = now()
  let authorizedClients: AuthorizedClient[] = [
    ...(options.seed?.authorizedClients ?? [
      {
        clientId: 'client-owner',
        label: 'Local owner',
        kind: 'owner',
        capabilities: ['read', 'operate', 'agent', 'terminal', 'admin'],
        createdAt: seededAt,
        lastSeenAt: seededAt,
        expiresAt: new Date(Date.parse(seededAt) + 30 * 86_400_000).toISOString(),
        connected: true,
      } satisfies AuthorizedClient,
    ]),
  ]
  let currentClientId =
    options.seed?.currentClientId ?? authorizedClients[0]?.clientId ?? 'client-owner'
  const clientListListeners = new Set<(list: AuthorizedClientList) => void>()
  const clientList = (): AuthorizedClientList => ({
    clients: authorizedClients.map((client) => ({ ...client })),
    currentClientId,
    omitted: 0,
  })
  /** The environment's own checks, so a view cannot do here what it could not do there. */
  const requireAdmin = () => {
    const caller = authorizedClients.find((item) => item.clientId === currentClientId)
    if (!caller?.capabilities.includes('admin')) {
      throw new EnvironmentClientError(
        'capability_missing',
        'This command requires the admin capability.',
      )
    }
    return caller
  }
  const announceClients = () => {
    const list = clientList()
    for (const listener of [...clientListListeners]) listener(list)
  }
  // Pairing links, with the token each was created with; the environment
  // keeps only a hash, but the mock has nothing to protect.
  let pairingLinks: Array<{ link: PairingLink; token: string }> = [
    ...(options.seed?.pairingLinks ?? []),
  ]
  const pairingToken = () => {
    let token = ''
    for (let index = 0; index < PAIRING_TOKEN_LENGTH; index += 1) {
      token += PAIRING_TOKEN_ALPHABET[Math.floor(Math.random() * PAIRING_TOKEN_ALPHABET.length)]
    }
    return token
  }
  /** What a link's creator holds now; nothing once it was revoked or expired. */
  const creatorGrant = (link: PairingLink) => {
    const creator = authorizedClients.find((item) => item.clientId === link.createdByClientId)
    return creator && Date.parse(creator.expiresAt) > Date.parse(now())
      ? creator.capabilities
      : undefined
  }
  const linkStatus = (link: PairingLink): PairingLink => {
    if (link.status !== 'waiting') return link
    if (Date.parse(link.expiresAt) <= Date.parse(now())) return { ...link, status: 'expired' }
    return creatorGrant(link) ? link : { ...link, status: 'void' }
  }
  const refusePairing = (reason: PairingRejectionReason, message: string) =>
    new EnvironmentClientError(
      reason === 'already_authorized'
        ? 'conflict'
        : reason === 'grant_exceeds_link' || reason === 'malformed'
          ? 'validation'
          : 'auth',
      message,
      { reason },
    )
  /**
   * The waiting link a token opens and what redeeming it grants, or the
   * refusal the environment would give. The creator is checked again now: a
   * revoked creator's links are void, a narrowed one's narrow.
   */
  const waitingLink = (raw: string, capabilities?: readonly AccessCapability[]) => {
    const token = PairingTokenSchema.safeParse(raw)
    if (!token.success) throw refusePairing('malformed', 'Not a pairing token.')
    const entry = pairingLinks.find((item) => item.token === token.data)
    if (!entry || entry.link.status === 'revoked') {
      throw refusePairing('invalid', 'That pairing link is not valid.')
    }
    const link = linkStatus(entry.link)
    if (link.status === 'expired') throw refusePairing('expired', 'That pairing link expired.')
    if (link.status === 'used') throw refusePairing('used', 'That pairing link was already used.')
    if (link.status === 'void') {
      throw refusePairing('creator_revoked', 'The device that made this link no longer has access.')
    }
    if (capabilities?.some((capability) => !link.capabilities.includes(capability))) {
      throw refusePairing('grant_exceeds_link', 'That asks for more than the link offers.')
    }
    const asked = capabilities ?? link.capabilities
    const creator = creatorGrant(link) ?? []
    const grant = ACCESS_CAPABILITIES.filter(
      (capability) => asked.includes(capability) && creator.includes(capability),
    )
    if (!grant.includes('read')) {
      throw refusePairing('creator_revoked', 'The device that made this link no longer has access.')
    }
    return { entry, grant }
  }
  const consumeLink = (
    entry: { link: PairingLink; token: string },
    clientId: string,
  ): PairingLink => {
    const used: PairingLink = {
      ...entry.link,
      status: 'used',
      usedByClientId: clientId,
      usedAt: now(),
    }
    pairingLinks = pairingLinks.map((item) =>
      item === entry ? { link: used, token: item.token } : item,
    )
    return used
  }

  const liveClient = (clientId: string) => {
    const client = authorizedClients.find((item) => item.clientId === clientId)
    if (!client) throw new EnvironmentClientError('not_found', 'That client is not authorized.')
    return client
  }

  const preferenceKey = (target: ComposerPreferenceTarget) =>
    JSON.stringify([target.workspaceId, target.providerId])
  for (const [workspaceId, byProvider] of Object.entries(options.seed?.composerPreferences ?? {})) {
    for (const [providerId, preference] of Object.entries(byProvider)) {
      preferences.set(
        preferenceKey({ workspaceId, providerId }),
        WorkspaceComposerPreferenceSchema.parse(preference),
      )
    }
  }

  const parseComposerPayload = <N extends keyof typeof ComposerCommandSchemas>(
    name: N,
    payload: unknown,
  ) => {
    const parsed = ComposerCommandSchemas[name].safeParse({
      type: 'command',
      requestId: 'mock-composer',
      name,
      payload,
    })
    if (!parsed.success) throw new EnvironmentClientError('validation', `Invalid ${name} request.`)
  }

  const requireProvider = (providerId: string) => {
    if (!catalog.some((provider) => provider.id === providerId)) {
      throw new EnvironmentClientError('not_found', 'Provider not found.')
    }
  }

  /**
   * Merges like the environment: a patch, where an absent field keeps its
   * value. `known` is false when the client side could not have named the
   * pair, so the answer is returned but, as on the wire, not stored.
   */
  const writePreference = (
    target: ComposerPreferenceTarget,
    patch: WorkspaceComposerPreference,
    known = true,
  ) => {
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    )
    const next = { ...preferences.get(preferenceKey(target)), ...defined }
    preferences.set(preferenceKey(target), next)
    if (known) store.update((state) => applyComposerPreference(state, target, next))
    return next
  }

  /**
   * The environment always knows a session's provider; the client only does
   * once a session summary carried it.
   */
  const sessionPreferenceTarget = (sessionId: string) => {
    const session = store.getState().sessions[sessionId]
    if (!session) throw new EnvironmentClientError('not_found', 'Session not found.')
    return {
      target: { workspaceId: session.workspaceId, providerId: session.providerId ?? 'opencode' },
      known: session.providerId !== undefined,
    }
  }

  /** A session setter changes that session alone, and says so as the environment would. */
  const writeSessionComposer = (sessionId: string, patch: SessionComposerState) => {
    emit({
      ...base(),
      name: 'session.composer.updated',
      scope: envScope(),
      payload: {
        sessionId,
        composer: { ...store.getState().sessions[sessionId]?.composer, ...patch },
      },
    })
  }

  const startTurn = (input: SendTurnInput & { commandId: string }) => {
    const replayed = startedCommands.get(commandKey(input, input.commandId))
    if (replayed) {
      // The retry still confirms its echo, exactly as the first send did.
      store.update((state) => applyTurnStarted(state, input, replayed))
      return replayed
    }
    const thread = requireThread(input)
    if (thread.turns.some((turn) => turn.state === 'running' || turn.state === 'waiting')) {
      throw new EnvironmentClientError('conflict', 'A turn is already in progress.')
    }
    const turn: Turn = { turnId: nextId(), threadId: input.threadId, state: 'running' }
    const userMessage: Message = {
      messageId: nextId(),
      threadId: input.threadId,
      turnId: turn.turnId,
      role: 'user',
      content: [
        ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
        ...[...new Set(input.artifactIds ?? [])].map((artifactId, index) => {
          const blob = artifacts[artifactId]
          if (!blob) {
            throw new EnvironmentClientError('not_found', 'Artifact not found in this session.')
          }
          return {
            type: 'artifact' as const,
            artifactId,
            mimeType: blob.type || 'application/octet-stream',
            name: `image-${index + 1}`,
            sizeBytes: blob.size,
          }
        }),
      ],
    }
    const started: TurnStart = { turn, userMessage, commandId: input.commandId }
    startedCommands.set(commandKey(input, input.commandId), started)
    // Fold the user echo in before the event, the way the WebSocket client
    // applies `turn.send` before `turn.started` arrives. The event is then
    // a no-op instead of a second bubble.
    store.update((state) => applyTurnStarted(state, input, started))
    emit({ ...base(), name: 'turn.started', scope: threadScope(input), payload: started })
    const context: MockTurnContext = { ...input, turnId: turn.turnId }
    const chunks = respond ? respond(context) : null
    if (chunks) scriptReply(context, chunks)
    return started
  }

  /** The environment's draft rows; a deleted one keeps its revision as a tombstone. */
  const draftRows = new Map<
    string,
    { draft: Draft | null; revision: number; sessionId: string | null; deletedRevision: number }
  >()
  const listDraftRows = () => {
    const drafts: Draft[] = []
    const tombstones: DraftTombstone[] = []
    for (const [draftId, row] of draftRows) {
      if (row.draft) drafts.push(row.draft)
      else if (row.sessionId) tombstones.push({ draftId, revision: row.revision })
    }
    const list = { drafts, tombstones }
    store.update((state) => applyDraftList(state, list))
    return list
  }
  const deleteDraftRow = (
    draftId: string,
    baseRevision?: number,
    ifRevision?: number,
  ): DraftTombstone => {
    const row = draftRows.get(draftId)
    if (row && !row.draft) return { draftId, revision: row.revision }
    if (row && baseRevision !== undefined && baseRevision < row.deletedRevision) {
      throw new EnvironmentClientError('conflict', DRAFT_DELETED_MESSAGE, {
        draftId,
        revision: row.deletedRevision,
      })
    }
    // A conditional delete of the draft as it was at exactly that revision.
    if (row && ifRevision !== undefined && row.revision !== ifRevision) {
      throw new EnvironmentClientError('conflict', DRAFT_CHANGED_MESSAGE, {
        draftId,
        revision: row.revision,
        changed: true,
      })
    }
    const sessionId = row?.sessionId ?? (store.getState().sessions[draftId] ? draftId : null)
    const tombstone = { draftId, revision: (row?.revision ?? 0) + 1 }
    draftRows.set(draftId, {
      draft: null,
      revision: tombstone.revision,
      sessionId,
      deletedRevision: tombstone.revision,
    })
    emit({
      ...base(),
      name: 'draft.deleted',
      scope: envScope(),
      payload: { ...tombstone, sessionId },
    })
    return tombstone
  }

  const commands: EnvironmentCommands = {
    getEnvironment: () =>
      run('getEnvironment', null, () => {
        store.update((state) => applyEnvironment(state, environment))
        return environment
      }),
    listWorkspaces: () =>
      run('listWorkspaces', null, () =>
        store.getState().workspaceOrder.map((id) => store.getState().workspaces[id]!),
      ),
    addWorkspace: (input) =>
      run('addWorkspace', input, () => {
        const workspace: Workspace = {
          workspaceId: input.path,
          name: input.name ?? workspaceNameFromPath(input.path),
          path: input.path,
          lastUsedAt: null,
          lastActivityAt: null,
          capabilities: { git: false, providers: [] },
          exists: true,
        }
        emit({
          ...base(),
          name: 'workspace.updated',
          scope: envScope(),
          payload: { workspace },
        })
        return workspace
      }),
    resolveWorkspaceIcon: (workspaceId) =>
      run('resolveWorkspaceIcon', workspaceId, () => {
        if (!store.getState().workspaces[workspaceId]) {
          throw new EnvironmentClientError('not_found', 'Workspace not found.')
        }
        return options.seed?.workspaceIcons?.[workspaceId] ?? null
      }),
    removeWorkspace: (workspaceId) =>
      run('removeWorkspace', workspaceId, () => {
        if (!store.getState().workspaces[workspaceId]) {
          throw new EnvironmentClientError('not_found', 'Workspace not found.')
        }
        cancelScriptsForThreads(
          selectSessionList(store.getState(), workspaceId).flatMap((session) => session.threadIds),
        )
        store.update((state) => applyWorkspaceRemoved(state, workspaceId))
      }),
    listSessions: (input = {}) =>
      run('listSessions', input, () => {
        const query = typeof input === 'string' ? { workspaceId: input } : input
        return pageSessionSummaries(selectSessionList(store.getState()), query)
      }),
    createSession: (input) =>
      run('createSession', input, () => {
        if (
          !ProofCommandSchemas['session.create'].safeParse({
            type: 'command',
            requestId: 'mock-create',
            name: 'session.create',
            payload: input,
          }).success ||
          input.environmentId !== environment.environmentId
        ) {
          throw new EnvironmentClientError('validation', 'Invalid session create request.')
        }
        const workspace = store.getState().workspaces[input.workspaceId]
        if (!workspace || !workspace.exists) {
          throw new EnvironmentClientError('not_found', 'Workspace not found.')
        }
        if (!workspace.capabilities.providers.includes(input.providerId)) {
          throw new EnvironmentClientError(
            'validation',
            'The workspace does not offer the requested provider.',
          )
        }
        // Checked before anything exists, as the environment does, so a stale
        // id leaves no session behind. A held image goes with the draft to
        // whichever project it is sent from.
        const artifactIds = [...new Set(input.artifactIds ?? [])]
        if (artifactIds.some((artifactId) => !heldArtifacts.has(artifactId))) {
          throw new EnvironmentClientError(
            'not_found',
            'These images are no longer available. Attach them again.',
          )
        }
        // Filed before the session exists, as the environment does, and kept
        // as the new session's own model and config: what the draft showed.
        const target = { workspaceId: input.workspaceId, providerId: input.providerId }
        const launched = input.preference
          ? writePreference(target, input.preference)
          : preferences.get(preferenceKey(target))
        if (input.sessionId !== undefined && store.getState().sessions[input.sessionId]) {
          throw new EnvironmentClientError('conflict', 'A session with this id already exists.')
        }
        if (input.draftId !== undefined && draftRows.get(input.draftId)?.sessionId) {
          throw new EnvironmentClientError(
            'validation',
            "A session's draft cannot start another session.",
          )
        }
        const session: Session = {
          sessionId: input.sessionId ?? nextId(),
          workspaceId: input.workspaceId,
          title: input.title ?? null,
        }
        const thread: Thread = { threadId: nextId(), sessionId: session.sessionId }
        emit({ ...base(), name: 'session.created', scope: envScope(), payload: { session } })
        // Like the environment: the sent draft goes in the same write.
        if (input.draftId !== undefined) deleteDraftRow(input.draftId)
        emit({
          ...base(),
          name: 'thread.created',
          scope: {
            type: 'session',
            environmentId: environment.environmentId,
            sessionId: session.sessionId,
          },
          payload: { thread },
        })
        store.update((state) => {
          const created = applySessionCreated(state, { session, thread })
          const current = created.sessions[session.sessionId]
          if (!current) return created
          return {
            ...created,
            sessions: {
              ...created.sessions,
              [session.sessionId]: {
                ...current,
                status: 'idle',
                providerId: input.providerId,
                updatedAt: current.updatedAt ?? now(),
              },
            },
          }
        })
        const firstTurn =
          input.firstMessage === undefined
            ? undefined
            : startTurn({
                sessionId: session.sessionId,
                threadId: thread.threadId,
                text: input.firstMessage,
                commandId: nextId(),
                ...(artifactIds.length > 0 ? { artifactIds } : {}),
              })
        // Claimed only once the first turn started: a launch that failed keeps
        // them held for the retry, as the environment hands them back.
        for (const artifactId of artifactIds) heldArtifacts.delete(artifactId)
        if (launched?.modelId !== undefined || launched?.configValues !== undefined) {
          writeSessionComposer(session.sessionId, {
            ...(launched.modelId !== undefined ? { modelId: launched.modelId } : {}),
            ...(launched.configValues !== undefined ? { configValues: launched.configValues } : {}),
          })
        }
        // The first turn runs in the picked mode; the session reports it.
        if (input.modeId !== undefined)
          writeSessionComposer(session.sessionId, { modeId: input.modeId })
        return { session, thread, ...(firstTurn ? { firstTurn } : {}) }
      }),
    openSession: (sessionId) => {
      const generation = ++openGeneration
      // On screen, loading, from the request on, as the wire client shows it.
      store.update((state) => applySessionOpening(state, sessionId))
      return run('openSession', sessionId, () => {
        // Like the wire client, an open overtaken by a later selection lands nowhere.
        if (generation !== openGeneration) return
        const session = store.getState().sessions[sessionId]
        if (!session) throw new EnvironmentClientError('not_found', 'Session not found.')
        const workspace = store.getState().workspaces[session.workspaceId]
        const availability =
          workspace && (workspace.availability ?? (workspace.exists ? 'available' : 'missing'))
        if (availability && availability !== 'available') {
          const message =
            'The session folder is missing, moved, or inaccessible on this environment. Restore the original folder path or its permissions, then try again. Your session is still listed.'
          store.update((state) => ({
            ...applyActiveSession(state, sessionId),
            sessionOpenFailure: { sessionId, message, code: 'workspace_unavailable', availability },
          }))
          throw new EnvironmentClientError('workspace_unavailable', message, {
            workspaceId: session.workspaceId,
            availability,
          })
        }
        store.update((state) => {
          let next = applySessionOpen(state, {
            session: {
              sessionId: session.sessionId,
              workspaceId: session.workspaceId,
              title: session.title,
              status: session.status,
              providerId: session.providerId ?? 'opencode',
              updatedAt: session.updatedAt ?? now(),
            },
            threads: session.threadIds
              .map((threadId) => state.threads[threadId]?.thread)
              .filter((thread): thread is Thread => thread !== undefined),
          })
          for (const threadId of session.threadIds) {
            const thread = next.threads[threadId]
            if (!thread) continue
            next = applySessionHistory(next, thread.thread, {
              messages: thread.messages,
              turns: thread.turns,
              interactions: thread.interactions.map((item) => ({
                threadId: item.threadId,
                interaction: item.interaction,
              })),
              nextCursor: null,
            })
          }
          return applyActiveSession(next, sessionId)
        })
      })
    },
    loadSessionHistory: (input) =>
      run('loadSessionHistory', input, () => {
        const thread = requireThread(input)
        const page = pageThreadMessages(thread.messages, input)
        const payload = {
          messages: page.messages,
          turns: thread.turns,
          interactions: thread.interactions.map((item) => ({
            threadId: item.threadId,
            interaction: item.interaction,
          })),
          nextCursor: page.nextCursor,
        }
        store.update((state) =>
          applySessionHistory(state, thread.thread, payload, input.cursor !== undefined),
        )
        return payload
      }),
    renameSession: (sessionId, title) =>
      run('renameSession', { sessionId, title }, () => {
        if (!store.getState().sessions[sessionId]) {
          throw new EnvironmentClientError('not_found', 'Session not found.')
        }
        emit({
          ...base(),
          name: 'session.updated',
          scope: envScope(),
          payload: { sessionId, title, titleSource: 'user' },
        })
      }),
    regenerateSessionTitle: (sessionId) =>
      run('regenerateSessionTitle', { sessionId }, () => {
        const session = store.getState().sessions[sessionId]
        if (!session) throw new EnvironmentClientError('not_found', 'Session not found.')
        emit({
          ...base(),
          name: 'session.updated',
          scope: envScope(),
          payload: {
            sessionId,
            title: `Regenerated ${session.title ?? 'session'}`,
            titleSource: 'generated',
          },
        })
      }),
    settleSession: (sessionId, settled) =>
      settles.settle(sessionId, settled, () =>
        run('settleSession', { sessionId, settled }, () => {
          const session = store.getState().sessions[sessionId]
          if (!session) throw new EnvironmentClientError('not_found', 'Session not found.')
          // Mirrors the environment: a live session would stay settled after it finishes.
          if (settled && (session.status === 'running' || session.status === 'waiting')) {
            throw new EnvironmentClientError('conflict', 'A live session cannot be settled.')
          }
          const settledAt = settled ? now() : null
          emit({
            ...base(),
            name: 'session.updated',
            scope: envScope(),
            payload: { sessionId, settledAt },
          })
          return settledAt
        }),
      ),
    stopBackgroundTasks: (input) =>
      run('stopBackgroundTasks', input, () => {
        const session = store.getState().sessions[input.sessionId]
        if (!session) throw new EnvironmentClientError('not_found', 'Session not found.')
        const live = session.backgroundTasks ?? []
        const left = input.taskIds
          ? live.filter((task) => !input.taskIds!.includes(task.taskId))
          : []
        if (left.length === live.length) return
        emit({
          ...base(),
          name: 'session.updated',
          scope: envScope(),
          payload: {
            sessionId: input.sessionId,
            backgroundTasks: left,
            // Between turns the roster is all that holds a session at running.
            ...(left.length === 0 &&
            session.status === 'running' &&
            deriveSessionStatus(session.threadIds.map((id) => store.getState().threads[id]!)) ===
              'idle'
              ? { status: 'idle' as const }
              : {}),
          },
        })
      }),
    acknowledgeSession: (sessionId) =>
      run('acknowledgeSession', { sessionId }, () => {
        const session = store.getState().sessions[sessionId]
        if (!session) throw new EnvironmentClientError('not_found', 'Session not found.')
        if (!session.doneAt) return
        emit({
          ...base(),
          name: 'session.updated',
          scope: envScope(),
          payload: { sessionId, doneAt: null },
        })
      }),
    deleteSession: (sessionId) =>
      run('deleteSession', sessionId, () => {
        const session = store.getState().sessions[sessionId]
        if (!session) throw new EnvironmentClientError('not_found', 'Session not found.')
        cancelScriptsForThreads(session.threadIds)
        emit({ ...base(), name: 'session.deleted', scope: envScope(), payload: { sessionId } })
      }),
    sendTurn: (input) => {
      const commandId = input.commandId ?? nextId()
      const thread: Thread = { threadId: input.threadId, sessionId: input.sessionId }
      store.update((state) =>
        applyTurnSending(state, thread, {
          commandId,
          text: input.text,
          artifactIds: input.artifactIds,
        }),
      )
      // Recorded with the id it actually ran under, minted or not.
      const send = { ...input, commandId }
      return run('sendTurn', send, () => startTurn(send)).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        store.update((state) => applyTurnSendFailed(state, thread, commandId, message))
        throw error
      })
    },
    interruptTurn: (input) =>
      run('interruptTurn', input, () => {
        const thread = requireThread(input)
        const turn = thread.turns.find((item) => item.turnId === input.turnId)
        if (!turn || (turn.state !== 'running' && turn.state !== 'waiting')) {
          throw new EnvironmentClientError('conflict', 'Turn is not in progress.')
        }
        cancelScript(input.turnId)
        emit({
          ...base(),
          name: 'turn.interrupted',
          scope: threadScope(input),
          payload: { turnId: input.turnId },
        })
      }),
    respondToInteraction: (input) =>
      run('respondToInteraction', input, () => {
        const thread = requireThread(input)
        const pending = thread.interactions.find(
          (item) => item.interaction.interactionId === input.response.interactionId,
        )
        if (!pending) throw new EnvironmentClientError('not_found', 'Interaction not found.')
        if (pending.interaction.kind !== input.response.kind) {
          throw new EnvironmentClientError('validation', 'Response kind does not match.')
        }
        emit({
          ...base(),
          name: 'interaction.resolved',
          scope: threadScope(input),
          payload: { turnId: pending.turnId, response: input.response as InteractionResponse },
        })
      }),
    getProviderCatalog: () =>
      run('getProviderCatalog', null, () => {
        store.update((state) => applyProviderCatalog(state, catalog))
        return catalog
      }),
    // The mock's providers never change health: a probe answers what is seeded.
    probeProvider: (input) =>
      run('probeProvider', input, () => {
        const entry = catalog.find((provider) => provider.id === input.providerId)
        if (!entry) throw new EnvironmentClientError('not_found', 'Provider not found.')
        if (!store.getState().workspaces[input.workspaceId]) {
          throw new EnvironmentClientError('not_found', 'Workspace not found.')
        }
        const provider = {
          id: entry.id,
          displayName: entry.displayName,
          capabilities: entry.capabilities,
          health: entry.health,
        }
        store.update((state) => applyProviderProbe(state, provider))
        return provider
      }),
    getComposerPreference: (input) =>
      run('getComposerPreference', input, () => {
        parseComposerPayload('composer.preferences.get', input)
        requireProvider(input.providerId)
        return writePreference(input, {})
      }),
    setComposerPreference: (input) =>
      run('setComposerPreference', input, () => {
        parseComposerPayload('composer.preferences.set', input)
        requireProvider(input.providerId)
        return writePreference(input, input.preference)
      }),
    setSessionModel: (input) =>
      run('setSessionModel', input, () => {
        parseComposerPayload('composer.model.set', input)
        const { target, known } = sessionPreferenceTarget(input.sessionId)
        writeSessionComposer(input.sessionId, { modelId: input.modelId })
        return writePreference(target, { modelId: input.modelId }, known)
      }),
    setSessionMode: (input) =>
      run('setSessionMode', input, () => {
        parseComposerPayload('composer.mode.set', input)
        const { target, known } = sessionPreferenceTarget(input.sessionId)
        writeSessionComposer(input.sessionId, { modeId: input.modeId })
        return writePreference(target, { modeId: input.modeId }, known)
      }),
    setSessionConfigOption: (input) =>
      run('setSessionConfigOption', input, () => {
        parseComposerPayload('composer.config_option.set', input)
        const { target, known } = sessionPreferenceTarget(input.sessionId)
        writeSessionComposer(input.sessionId, {
          configValues: {
            ...store.getState().sessions[input.sessionId]?.composer?.configValues,
            [input.configId]: input.value,
          },
        })
        const configValues = {
          ...preferences.get(preferenceKey(target))?.configValues,
          [input.configId]: input.value,
        }
        return writePreference(target, { configValues }, known)
      }),
    browseFolders: (path, prefix) =>
      run('browseFolders', prefix === undefined ? path : { path, prefix }, () => {
        const folders = options.seed?.folders ?? {}
        const home = options.seed?.home ?? Object.keys(folders)[0] ?? '/'
        const expand = (input: string) =>
          input === '~' ? home : /^~[\\/]/.test(input) ? joinMockPath(home, input.slice(2)) : input
        // Like the environment: a start folder that has gone falls back home.
        const startsIn = environmentSettings.addProjectStartsIn
        const start = startsIn && folders[trimMockPath(expand(startsIn))] ? startsIn : home
        const folder = trimMockPath(expand(path ?? start))
        const children = folders[folder]?.filter(
          (name) => !prefix || name.toLowerCase().startsWith(prefix.toLowerCase()),
        )
        if (!children) {
          throw new EnvironmentClientError('not_found', `No folder exists at ${folder}.`)
        }
        return {
          path: folder,
          parentPath: parentMockPath(folder),
          entries: [...children]
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
            .map((name) => ({ name, path: joinMockPath(folder, name) })),
          omitted: 0,
          readable: true,
        }
      }),
    listDrafts: () => run('listDrafts', null, listDraftRows),
    saveDraft: (input) =>
      run('saveDraft', input, () => {
        const parsed = DraftCommandSchemas['draft.save'].shape.payload.safeParse(input)
        if (!parsed.success) throw new EnvironmentClientError('validation', 'Invalid draft.')
        const { draftId, baseRevision, target, content } = parsed.data
        if (target.type === 'session' && target.sessionId !== draftId) {
          throw new EnvironmentClientError('validation', "A session's draft is named by its id.")
        }
        const row = draftRows.get(draftId)
        if (row && baseRevision < row.deletedRevision) {
          throw new EnvironmentClientError('conflict', DRAFT_DELETED_MESSAGE, {
            draftId,
            revision: row.deletedRevision,
          })
        }
        const at = now()
        const draft: Draft = {
          draftId,
          target,
          content,
          revision: (row?.revision ?? 0) + 1,
          createdAt: row?.draft?.createdAt ?? at,
          updatedAt: at,
          updatedByClientId: null,
        }
        draftRows.set(draftId, {
          draft,
          revision: draft.revision,
          sessionId: target.type === 'session' ? target.sessionId : null,
          deletedRevision: row?.deletedRevision ?? 0,
        })
        emit({ ...base(), name: 'draft.saved', scope: envScope(), payload: { draft } })
        return draft
      }),
    deleteDraft: (input) =>
      run('deleteDraft', input, () =>
        deleteDraftRow(input.draftId, input.baseRevision, input.ifRevision),
      ),
    listAuthorizedClients: () =>
      run('listAuthorizedClients', null, () => {
        requireAdmin()
        return clientList()
      }),
    renameAuthorizedClient: (clientId, label) =>
      run('renameAuthorizedClient', { clientId, label }, () => {
        const caller = requireAdmin()
        if (liveClient(clientId).kind === 'owner' && caller.kind !== 'owner') {
          throw new EnvironmentClientError(
            'capability_missing',
            'Only the owner can rename itself.',
          )
        }
        const parsed = ClientLabelSchema.safeParse(label)
        if (!parsed.success) {
          throw new EnvironmentClientError('validation', parsed.error.issues[0]!.message)
        }
        const renamed = { ...liveClient(clientId), label: parsed.data }
        authorizedClients = authorizedClients.map((item) =>
          item.clientId === clientId ? renamed : item,
        )
        announceClients()
        return { ...renamed }
      }),
    revokeAuthorizedClient: (clientId) =>
      run('revokeAuthorizedClient', { clientId }, () => {
        requireAdmin()
        if (clientId === currentClientId) {
          throw new EnvironmentClientError('validation', 'A device cannot revoke itself.')
        }
        if (liveClient(clientId).kind === 'owner') {
          throw new EnvironmentClientError('validation', 'The owner cannot be revoked.')
        }
        authorizedClients = authorizedClients.filter((item) => item.clientId !== clientId)
        announceClients()
      }),
    revokeOtherAuthorizedClients: () =>
      run('revokeOtherAuthorizedClients', null, () => {
        requireAdmin()
        const revoked = authorizedClients
          .filter((item) => item.clientId !== currentClientId && item.kind !== 'owner')
          .map((item) => item.clientId)
        authorizedClients = authorizedClients.filter((item) => !revoked.includes(item.clientId))
        if (revoked.length > 0) announceClients()
        return revoked
      }),
    rotateOwnerCredential: () =>
      run('rotateOwnerCredential', null, () => {
        const previous = requireAdmin()
        if (previous.kind !== 'owner') {
          throw new EnvironmentClientError(
            'capability_missing',
            'Only the owner can rotate the owner credential.',
          )
        }
        const client: AuthorizedClient = {
          ...previous,
          clientId: nextId(),
          createdAt: now(),
          lastSeenAt: null,
          connected: false,
        }
        authorizedClients = authorizedClients.map((item) =>
          item.clientId === previous.clientId ? client : item,
        )
        currentClientId = client.clientId
        announceClients()
        return { client: { ...client }, credential: `omc1.${'m'.repeat(43)}` }
      }),
    createPairingLink: (input) =>
      run('createPairingLink', input, () => {
        const caller = requireAdmin()
        const missing = input.capabilities.find(
          (capability) => !caller.capabilities.includes(capability),
        )
        if (missing) {
          throw new EnvironmentClientError(
            'capability_missing',
            `This device cannot offer ${missing}.`,
          )
        }
        const createdAt = now()
        const link: PairingLink = {
          linkId: nextId(),
          label: input.label ?? null,
          capabilities: [...input.capabilities],
          createdByClientId: caller.clientId,
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + PAIRING_LINK_LIFETIME_MS).toISOString(),
          status: 'waiting',
          usedByClientId: null,
          usedAt: null,
        }
        const token = pairingToken()
        pairingLinks = [...pairingLinks, { link, token }]
        return { link: { ...link }, token }
      }),
    listPairingLinks: () =>
      run('listPairingLinks', null, () => {
        requireAdmin()
        return pairingLinks.map((item) => linkStatus(item.link))
      }),
    revokePairingLink: (linkId) =>
      run('revokePairingLink', { linkId }, () => {
        requireAdmin()
        const entry = pairingLinks.find((item) => item.link.linkId === linkId)
        if (!entry || linkStatus(entry.link).status !== 'waiting') {
          throw new EnvironmentClientError('not_found', 'That link is not waiting.')
        }
        pairingLinks = pairingLinks.map((item) =>
          item === entry ? { ...item, link: { ...item.link, status: 'revoked' } } : item,
        )
      }),
    redeemPairingLink: (input) =>
      run('redeemPairingLink', input, () => {
        const { entry, grant } = waitingLink(input.token, input.capabilities)
        const caller = liveClient(currentClientId)
        if (caller.kind !== 'paired') {
          throw refusePairing('already_authorized', 'This device is already authorized.')
        }
        const grantChanged =
          grant.length !== caller.capabilities.length ||
          grant.some((capability) => !caller.capabilities.includes(capability))
        consumeLink(entry, caller.clientId)
        authorizedClients = authorizedClients.map((item) =>
          item.clientId === caller.clientId ? { ...item, capabilities: grant } : item,
        )
        announceClients()
        return { clientId: caller.clientId, clientLabel: caller.label, grant, grantChanged }
      }),
    getEnvironmentSettings: () =>
      run('getEnvironmentSettings', null, () => ({ ...environmentSettings })),
    setEnvironmentSettings: (patch) =>
      run('setEnvironmentSettings', patch, () => {
        environmentSettings = {
          ...environmentSettings,
          ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
        }
        return { ...environmentSettings }
      }),
  }

  const drafts = createDraftSync({
    store,
    // Listing on connect is housekeeping, kept out of `calls` like the
    // handshake; the saves and deletes an edit causes are recorded.
    commands: { ...commands, listDrafts: async () => listDraftRows() },
    supported: () => capabilities.has('saveDraft'),
    debounceMs: options.draftSaveDebounceMs ?? latencyMs,
  })

  return {
    commands,
    drafts,
    calls,
    getState: store.getState,
    subscribe: store.subscribe,
    supports: (command) => capabilities.has(command),
    pairDevice(token, label) {
      const { entry, grant } = waitingLink(token)
      const createdAt = now()
      const client: AuthorizedClient = {
        clientId: nextId(),
        label: entry.link.label ?? label ?? 'Paired device',
        kind: 'paired',
        capabilities: grant,
        createdAt,
        lastSeenAt: null,
        expiresAt: new Date(Date.parse(createdAt) + 30 * 86_400_000).toISOString(),
        connected: false,
      }
      consumeLink(entry, client.clientId)
      authorizedClients = [...authorizedClients, client]
      announceClients()
      return { ...client }
    },
    onAuthorizedClientsChanged(listener) {
      clientListListeners.add(listener)
      return () => {
        clientListListeners.delete(listener)
      }
    },
    fetchArtifact: async (input) => {
      await new Promise<void>((resolve) => schedule(resolve, latencyMs))
      const blob = artifacts[input.artifactId]
      if (!blob) throw new EnvironmentClientError('not_found', 'Artifact not found.')
      return blob
    },
    uploadArtifact: async (input) => {
      await new Promise<void>((resolve) => schedule(resolve, latencyMs))
      if (!uploads) throw EnvironmentClientError.unsupported(UPLOAD_TICKET_COMMAND)
      // A draft's upload is held for its workspace until a create claims it.
      const workspaceId =
        input.sessionId !== undefined
          ? store.getState().sessions[input.sessionId]?.workspaceId
          : store.getState().workspaces[input.workspaceId!]?.workspaceId
      if (workspaceId === undefined) {
        throw new EnvironmentClientError(
          'not_found',
          input.sessionId !== undefined ? 'Session not found.' : 'Workspace not found.',
        )
      }
      const artifactId = nextId()
      artifacts[artifactId] = input.bytes
      if (input.sessionId === undefined) heldArtifacts.set(artifactId, workspaceId)
      return {
        artifactId,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        workspaceId,
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.size,
      }
    },
    setActiveSession: (sessionId) => {
      openGeneration += 1
      store.update((state) => applyActiveSession(state, sessionId))
    },
    setActiveThread: (threadId) => store.update((state) => applyActiveThread(state, threadId)),
    connect: () =>
      store.update((state) =>
        applyConnection(state, {
          phase: 'connected',
          hasConnected: true,
          failure: null,
          capabilities: wireCapabilities(capabilities, uploads),
        }),
      ),
    disconnect: () =>
      store.update((state) => applyConnection(state, { phase: 'closed', failure: null })),
    dispose: () => {
      disposed = true
      drafts.dispose()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      scriptedReplies.clear()
      const error = new EnvironmentClientError('unavailable', 'Client is disposed.')
      for (const reject of [...pendingCommands]) reject(error)
      pendingCommands.clear()
      for (const resolve of drains) resolve()
      drains.clear()
      store.update((state) => applyConnection(state, { phase: 'closed' }))
    },
    emit,
    streamAssistantText,
    completeTurn,
    interruptTurn: (target) => {
      requireThread(target)
      cancelScript(target.turnId)
      emit({
        ...base(),
        name: 'turn.interrupted',
        scope: threadScope(target),
        payload: { turnId: target.turnId },
      })
    },
    failTurn: (target, reason, message) => {
      requireThread(target)
      cancelScript(target.turnId)
      emit({
        ...base(),
        name: 'turn.failed',
        scope: threadScope(target),
        payload: { turnId: target.turnId, reason, message },
      })
    },
    requestInteraction: (target, interaction) => {
      requireThread(target)
      emit({
        ...base(),
        name: 'interaction.requested',
        scope: threadScope(target),
        payload: { turnId: target.turnId, interaction },
      })
    },
    notice: (target, message) => {
      requireThread(target)
      emit({
        ...base(),
        name: 'turn.notice',
        scope: threadScope(target),
        payload: { turnId: target.turnId, message },
      })
    },
    setConnection: (patch) => store.update((state) => applyConnection(state, patch)),
    reconnect: () => {
      if (disposed) return
      store.update((state) =>
        applyConnection(state, { phase: 'reconnecting', hasConnected: true, failure: null }),
      )
      const state = store.getState()
      const sessionId = state.activeSessionId
      const summary = sessionId ? state.sessions[sessionId] : undefined
      if (summary) {
        const threadStates = summary.threadIds
          .map((id) => state.threads[id])
          .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
        store.update((current) => {
          let next = applySessionOpen(current, {
            session: {
              sessionId: summary.sessionId,
              workspaceId: summary.workspaceId,
              title: summary.title,
              status: summary.status,
              providerId: summary.providerId ?? 'opencode',
              updatedAt: summary.updatedAt ?? now(),
            },
            threads: threadStates.map((item) => item.thread),
          })
          for (const item of threadStates) {
            next = applySessionHistory(next, item.thread, {
              messages: item.messages,
              turns: item.turns,
              interactions: item.interactions.map((pending) => ({
                threadId: pending.threadId,
                interaction: pending.interaction,
              })),
              nextCursor: null,
            })
          }
          return applyActiveSession(next, sessionId)
        })
      }
      store.update((current) =>
        applyConnection(current, {
          phase: 'connected',
          hasConnected: true,
          failure: null,
          capabilities: wireCapabilities(capabilities, uploads),
        }),
      )
    },
    settle,
  }
}

function seedState(
  environment: Environment,
  seed: MockSeed | undefined,
  capabilities: ReadonlySet<EnvironmentCommandName>,
  uploads: boolean,
): EnvironmentState {
  let state = applyEnvironment(createInitialState(), environment)
  state = applyConnection(state, {
    phase: 'connected',
    hasConnected: true,
    capabilities: wireCapabilities(capabilities, uploads),
  })
  state = applyWorkspaceList(state, seed?.workspaces ?? [])
  if (capabilities.has('getProviderCatalog')) {
    state = applyProviderCatalog(
      state,
      (seed?.providers ?? []).map((entry) => ProviderCatalogEntrySchema.parse(entry)),
    )
  }
  for (const [index, entry] of (seed?.sessions ?? []).entries()) {
    const threads = entry.threads ?? [
      { threadId: `${entry.session.sessionId}-thread`, sessionId: entry.session.sessionId },
    ]
    for (const thread of threads) {
      state = applySessionCreated(state, { session: entry.session, thread })
      state = {
        ...state,
        threads: {
          ...state.threads,
          [thread.threadId]: {
            ...createThreadState(thread, 'ready'),
            turns: (entry.turns ?? []).filter((turn) => turn.threadId === thread.threadId),
            messages: (entry.messages ?? []).filter(
              (message) => message.threadId === thread.threadId,
            ),
          },
        },
      }
    }
    const current = state.sessions[entry.session.sessionId]
    if (current) {
      state = {
        ...state,
        sessions: {
          ...state.sessions,
          [entry.session.sessionId]: {
            ...current,
            status: entry.status ?? current.status,
            providerId: entry.providerId ?? current.providerId ?? 'opencode',
            updatedAt:
              entry.updatedAt ??
              current.updatedAt ??
              new Date(1_700_000_000_000 + index * 1_000).toISOString(),
          },
        },
      }
    }
  }
  for (const session of Object.values(state.sessions)) {
    const threads = session.threadIds.map((id) => state.threads[id]!)
    const status =
      seed?.sessions?.find((entry) => entry.session.sessionId === session.sessionId)?.status ??
      deriveSessionStatus(threads)
    if (status !== session.status) {
      state = {
        ...state,
        sessions: { ...state.sessions, [session.sessionId]: { ...session, status } },
      }
    }
  }
  if (seed?.activeSessionId) state = applyActiveSession(state, seed.activeSessionId)
  return state
}

function splitChunks(text: string, size = 12): string[] {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size))
  }
  return chunks.length ? chunks : ['']
}

/** A mock path's separator: backslash when the path already uses one. */
const mockSeparator = (path: string) => (path.includes('\\') ? '\\' : '/')

/** Drop a trailing separator, except the one a root needs (`/`, `C:\`). */
function trimMockPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed === '') return '/'
  return /^[a-z]:$/i.test(trimmed) ? `${trimmed}\\` : trimmed
}

function joinMockPath(parent: string, name: string): string {
  const separator = mockSeparator(parent)
  return /[\\/]$/.test(parent) ? `${parent}${name}` : `${parent}${separator}${name}`
}

function parentMockPath(path: string): string | null {
  const cut = path.replace(/[\\/]+$/, '').search(/[\\/][^\\/]*$/)
  if (cut === -1) return null
  const parent = trimMockPath(path.slice(0, cut + 1))
  return parent === path ? null : parent
}
