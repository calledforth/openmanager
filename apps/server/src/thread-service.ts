import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ProofCommandSchemas,
  ProofEventSchemas,
  ProofResponseSchemas,
  pageSessionSummaries,
  pageThreadMessages,
  type CommandEnvelope,
  type ErrorCode,
  type EventEnvelope,
  type Message,
  type ProofEvent,
  type Session,
  type SessionStatus,
  type SessionSummary,
  type Thread,
  type TurnFailureReason,
  type Turn,
  type TurnStart,
} from '@openmanager/protocol/node'
import {
  projectAgentEvent,
  providers,
  type AgentRuntime,
  type HostDeps,
  type ProtocolEventContext,
  type RuntimeSessionArgs,
} from '@agentpack/runtime/node'
import {
  findTurnByCommandId,
  getProviderSessionId,
  getSessionSummary,
  listSessionHistory,
  listSessionSummaries,
  listThreadsForSession,
} from './db/session-store.ts'
import type { CommandContext } from './command-context.ts'

type ProviderId = keyof typeof providers

const WORKSPACE_UNAVAILABLE =
  'The workspace folder is unavailable. Restore its path or permissions, then try again.'
type RuntimeEvent = Parameters<HostDeps['emitEvent']>[0]
type ProviderGate = {
  rejection(providerId: string): { code: ErrorCode; message: string } | undefined
}
export type WorkspaceRuntimeRoute = {
  providerId: string
  /** Providers offered by this workspace; legacy resolver seams offer their single route. */
  providers?: readonly string[]
  cwd: string
  /**
   * Called once the provider has actually opened a session in the workspace.
   * Bookkeeping only: the host owns reporting a failure, and a throw here
   * never affects the session the client already holds.
   */
  onSessionStarted?: () => void
}
export type WorkspaceRuntimeResolver = (
  workspaceId: string,
  context?: CommandContext,
) => WorkspaceRuntimeRoute | undefined
type ActiveTurn = {
  turn: Turn
  userMessage: Message
  interruptRequested: boolean
  runtimeMessageId?: string
  toolIds: Map<string, string>
  interactionIds: Map<string, string>
}
type ThreadRecord = {
  session: Session
  thread: Thread
  providerId: ProviderId
  cwd: string
  runtimeSession: Promise<string>
  turns: Turn[]
  messages: Message[]
  /** What each command id already started here, so a retry never runs twice. */
  commandTurns: Map<string, TurnStart>
  status: SessionStatus
  updatedAt: number
  activeTurn?: ActiveTurn
}

const errorResult = (requestId: string, code: ErrorCode, message: string) => ({
  type: 'error' as const,
  requestId,
  error: { code, message },
})

const turnSendResult = (requestId: string, started: TurnStart) =>
  ProofResponseSchemas['turn.send'].parse({ type: 'response', requestId, payload: started })

/**
 * Own the host identities and runtime routes used by the proof-slice commands.
 *
 * Runtime work is deliberately queued in a microtask. The returned command
 * result is therefore written to the socket before a provider can emit an
 * event, including providers that emit synchronously while opening a session.
 */
export function createThreadService(
  runtime: Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
  providerGate: ProviderGate,
  appendEvent: (event: ProofEvent) => void,
  publishTransient: (event: EventEnvelope) => void = () => undefined,
  // Routing is by registered workspace ID only (D9): there is no default that
  // treats the ID as a path, so an unregistered workspace can never run.
  resolveWorkspace: WorkspaceRuntimeResolver = () => undefined,
  options: {
    database?: DatabaseSync
    flush?: () => void
    /** Commit several host events together; falls back to one append per event. */
    appendAtomic?: (events: readonly ProofEvent[]) => void
    /**
     * A failed write on the provider-driven path is reported here and the
     * batch stays queued for the next append. Without a handler it throws.
     */
    onPersistenceError?: (error: unknown, eventName: string) => void
  } = {},
) {
  const sessions = new Map<string, ThreadRecord>()
  const threads = new Map<string, ThreadRecord>()
  // Supplied after construction so the service can be assembled before the
  // WebSocket publisher exists.
  let environmentId = ''

  const route = (record: ThreadRecord, sessionId?: string): RuntimeSessionArgs => ({
    providerId: record.providerId,
    threadId: record.thread.threadId,
    workspaceId: record.session.workspaceId,
    cwd: record.cwd,
    ...(sessionId ? { sessionId } : {}),
  })
  // Persist the opaque identity before allowing prompts to use the provider session.
  const persistRuntimeSession = (record: ThreadRecord, providerSessionId: string): string => {
    options.database
      ?.prepare(
        'UPDATE sessions SET provider_id = ?, provider_session_id = ?, updated_at = ? WHERE session_id = ?',
      )
      .run(record.providerId, providerSessionId, Date.now(), record.session.sessionId)
    return providerSessionId
  }

  const threadScope = (record: ThreadRecord) =>
    ({
      type: 'thread',
      environmentId,
      sessionId: record.session.sessionId,
      threadId: record.thread.threadId,
    }) as const

  const rejectProvider = (requestId: string, providerId: string) => {
    const rejection = providerGate.rejection(providerId)
    return rejection ? errorResult(requestId, rejection.code, rejection.message) : undefined
  }

  // Provider callbacks and turn settlement must not fail because a write did:
  // the in-memory turn still settles, and the host decides how to report it.
  const appendRuntimeEvent = (event: ProofEvent) => {
    try {
      appendEvent(event)
    } catch (error) {
      if (!options.onPersistenceError) throw error
      options.onPersistenceError(error, event.name)
    }
  }

  const emitInterrupted = (record: ThreadRecord, turnId: string) => {
    appendRuntimeEvent(
      ProofEventSchemas['turn.interrupted'].parse({
        type: 'event',
        name: 'turn.interrupted',
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        scope: {
          type: 'thread',
          environmentId: environmentId,
          sessionId: record.session.sessionId,
          threadId: record.thread.threadId,
        },
        payload: { turnId },
      }),
    )
  }

  const emitCompleted = (record: ThreadRecord, turnId: string) => {
    appendRuntimeEvent(
      ProofEventSchemas['turn.completed'].parse({
        type: 'event',
        name: 'turn.completed',
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        scope: threadScope(record),
        payload: { turnId },
      }),
    )
  }

  const emitFailed = (
    record: ThreadRecord,
    turnId: string,
    reason: TurnFailureReason = 'provider_error',
  ) => {
    appendRuntimeEvent(
      ProofEventSchemas['turn.failed'].parse({
        type: 'event',
        name: 'turn.failed',
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        scope: threadScope(record),
        payload: {
          turnId,
          reason,
          message:
            reason === 'provider_process_crashed'
              ? 'The provider process crashed before the turn completed.'
              : reason === 'provider_process_exited'
                ? 'The provider process exited before the turn completed.'
                : 'The provider failed to complete the turn.',
        },
      }),
    )
  }

  /**
   * The turn a command id already started, read from the log. Pending events
   * are flushed first so a retry that arrives before the batch was written
   * still finds its turn.
   */
  const findPersistedTurn = (sessionId: string, threadId: string, commandId: string) => {
    if (!options.database) return undefined
    options.flush?.()
    return findTurnByCommandId(options.database, { sessionId, threadId, commandId })
  }

  /** The workspace of a session whose thread is no longer in memory. */
  const persistedWorkspaceId = (sessionId: string) => {
    if (!options.database) return undefined
    options.flush?.()
    return getSessionSummary(options.database, sessionId)?.workspaceId
  }

  const persistCreatedThread = (session: Session, thread: Thread) => {
    const timestamp = new Date().toISOString()
    const created = ProofEventSchemas['session.created'].parse({
      type: 'event',
      name: 'session.created',
      eventId: randomUUID(),
      timestamp,
      scope: { type: 'environment', environmentId },
      payload: { session },
    })
    const threadCreated = ProofEventSchemas['thread.created'].parse({
      type: 'event',
      name: 'thread.created',
      eventId: randomUUID(),
      timestamp,
      scope: { type: 'session', environmentId, sessionId: session.sessionId },
      payload: { thread },
    })
    if (options.appendAtomic) {
      options.appendAtomic([created, threadCreated])
      return
    }
    appendEvent(created)
    appendEvent(threadCreated)
  }

  /**
   * Forget a session and every thread record that belongs to it. Restored
   * sessions can hold several thread records, so cleanup has to be
   * session-wide or a partially available session is left behind.
   */
  const dropSessionRecords = (sessionId: string): ThreadRecord[] => {
    sessions.delete(sessionId)
    const dropped: ThreadRecord[] = []
    for (const [threadId, item] of threads) {
      if (item.session.sessionId !== sessionId) continue
      threads.delete(threadId)
      dropped.push(item)
    }
    return dropped
  }

  /**
   * Rebuild in-memory records for a session that only exists in SQLite, so the
   * runtime loads the stored provider thread instead of creating a second one.
   * A failed load drops the records again, keeping durable history and letting
   * another open retry.
   */
  const restoreSession = (
    session: SessionSummary,
    providerId: ProviderId,
    providerSessionId: string,
    cwd: string,
    restoredThreads: Thread[],
  ) => {
    const records: ThreadRecord[] = []
    for (const thread of restoredThreads) {
      const record: ThreadRecord = {
        session: {
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          title: session.title,
        },
        thread,
        providerId,
        cwd,
        runtimeSession: Promise.resolve().then(() => {
          if (threads.get(thread.threadId) !== record) throw new Error('Session was closed.')
          return runtime
            .ensureSession(route(record, providerSessionId))
            .then((result) => result.sessionId)
        }),
        turns: [],
        messages: [],
        commandTurns: new Map(),
        status: session.status,
        updatedAt: Date.parse(session.updatedAt),
      }
      void record.runtimeSession.catch(() => {
        // One thread failing to load leaves the session half attached, so the
        // whole restore is abandoned and a later open retries it from SQLite.
        const current = sessions.get(session.sessionId)
        if (current && records.includes(current)) dropSessionRecords(session.sessionId)
      })
      records.push(record)
      threads.set(thread.threadId, record)
    }
    if (records[0]) sessions.set(session.sessionId, records[0])
  }

  const rollbackSession = (record: ThreadRecord) => {
    if (sessions.get(record.session.sessionId) !== record) return
    sessions.delete(record.session.sessionId)
    if (threads.get(record.thread.threadId) === record) threads.delete(record.thread.threadId)
    appendRuntimeEvent(
      ProofEventSchemas['session.deleted'].parse({
        type: 'event',
        name: 'session.deleted',
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        scope: { type: 'environment', environmentId },
        payload: { sessionId: record.session.sessionId },
      }),
    )
  }

  const stableId = (ids: Map<string, string>, providerId: string | undefined) => {
    if (!providerId) return undefined
    let hostId = ids.get(providerId)
    if (!hostId) {
      hostId = randomUUID()
      ids.set(providerId, hostId)
    }
    return hostId
  }

  const projectRuntimeEvent = (
    record: ThreadRecord,
    event: RuntimeEvent,
    active: ActiveTurn | undefined,
    completionState?: ProtocolEventContext['completionState'],
    failureReason?: TurnFailureReason,
  ) => {
    const providerToolId =
      event.event === 'tool_call' ||
      event.event === 'tool_call_update' ||
      event.event === 'tool_call_content'
        ? event.data.toolCallId
        : event.event === 'permission_request'
          ? event.data.toolCall.toolCallId
          : undefined
    const providerInteractionId =
      event.event === 'permission_request' ||
      event.event === 'permission_resolved' ||
      event.event === 'question_request' ||
      event.event === 'question_resolved' ||
      event.event === 'plan_review_request' ||
      event.event === 'plan_review_resolved'
        ? event.data.requestId
        : undefined
    const messageId =
      event.event === 'prompt_started' || event.event === 'user_message_chunk'
        ? active?.userMessage.messageId
        : active?.runtimeMessageId
    const projected = projectAgentEvent(event, {
      eventId: randomUUID(),
      environmentId,
      workspaceId: record.session.workspaceId,
      sessionId: record.session.sessionId,
      threadId: record.thread.threadId,
      sessionTitle: record.session.title,
      turnId: active?.turn.turnId,
      messageId,
      interactionId: active ? stableId(active.interactionIds, providerInteractionId) : undefined,
      toolCallId: active ? stableId(active.toolIds, providerToolId) : undefined,
      completionState,
      failureReason,
    })
    if (!projected) return
    // The create command already announced the session, and with a database
    // the user's turn is durable before provider work begins; the provider's
    // own signals would only repeat them.
    if (projected.name === 'session.created') return
    if (options.database && projected.name === 'turn.started') return
    if (projected.name === 'turn.notice') publishTransient(projected)
    else appendRuntimeEvent(projected)
  }

  const touch = (record: ThreadRecord, status?: SessionStatus) => {
    record.updatedAt = Date.now()
    if (status) record.status = status
  }

  const summaryOf = (record: ThreadRecord): SessionSummary => ({
    sessionId: record.session.sessionId,
    workspaceId: record.session.workspaceId,
    title: record.session.title,
    status: record.status,
    providerId: record.providerId,
    updatedAt: new Date(record.updatedAt).toISOString(),
  })

  const service = {
    setEnvironmentId(id: string) {
      environmentId = id
    },

    /**
     * Forget every session of a workspace that is being unregistered. An
     * active turn is asked to stop, best effort; whatever the provider still
     * emits afterwards finds no thread and is dropped. Returns the count.
     */
    closeWorkspaceSessions(workspaceId: string): number {
      let closed = 0
      for (const record of [...sessions.values()]) {
        if (record.session.workspaceId !== workspaceId) continue
        for (const item of dropSessionRecords(record.session.sessionId)) {
          if (!item.activeTurn) continue
          void item.runtimeSession
            .then((sessionId) => runtime.cancel({ ...route(item), sessionId }))
            .catch(() => undefined)
        }
        closed += 1
      }
      return closed
    },

    resolveRuntimeSession(sessionId: string) {
      const record = sessions.get(sessionId)
      if (!record) return undefined
      return record.runtimeSession.then((providerSessionId) => ({
        ...route(record),
        sessionId: providerSessionId,
      }))
    },

    dispatch(command: CommandEnvelope, context?: CommandContext): unknown | undefined {
      if (command.name === 'session.list') {
        const parsed = ProofCommandSchemas['session.list'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid session list request.')
        }
        return ProofResponseSchemas['session.list'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: options.database
            ? listSessionSummaries(options.database, parsed.data.payload)
            : pageSessionSummaries([...sessions.values()].map(summaryOf), parsed.data.payload),
        })
      }

      if (command.name === 'session.create') {
        const parsed = ProofCommandSchemas['session.create'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid session create request.')
        }
        const input = parsed.data.payload
        if (input.environmentId !== environmentId) {
          return errorResult(
            command.requestId,
            'validation',
            'The requested environment does not match this server.',
          )
        }
        let target: WorkspaceRuntimeRoute | undefined
        try {
          target = resolveWorkspace(input.workspaceId, context)
        } catch {
          return errorResult(command.requestId, 'not_found', WORKSPACE_UNAVAILABLE)
        }
        if (!target) return errorResult(command.requestId, 'not_found', 'Workspace not found.')
        // Order matters: a provider this build cannot run is a capability gap,
        // not a missing resource, so it is answered before the health gate.
        if (!Object.hasOwn(providers, input.providerId)) {
          return errorResult(
            command.requestId,
            'capability_missing',
            'This server cannot run the requested provider.',
          )
        }
        const providerRejection = rejectProvider(command.requestId, input.providerId)
        if (providerRejection) return providerRejection
        if (!(target.providers ?? [target.providerId]).includes(input.providerId)) {
          return errorResult(
            command.requestId,
            'validation',
            'The workspace does not offer the requested provider. Choose an available provider.',
          )
        }
        const providerId = input.providerId as ProviderId
        const session: Session = {
          sessionId: randomUUID(),
          workspaceId: parsed.data.payload.workspaceId,
          title: parsed.data.payload.title ?? null,
        }
        const thread: Thread = { threadId: randomUUID(), sessionId: session.sessionId }
        // Announced and durable before it is exposed or started: a failed write
        // means no client learns of a session the host could not serve after a
        // restart, and every connected client sees the session at once.
        try {
          persistCreatedThread(session, thread)
        } catch (error) {
          options.onPersistenceError?.(error, 'session.created')
          return errorResult(
            command.requestId,
            'unavailable',
            'The session could not be saved. Try again.',
          )
        }
        let record!: ThreadRecord
        const runtimeSession = Promise.resolve()
          .then(() => {
            if (sessions.get(session.sessionId) !== record)
              throw new Error('Session creation was cancelled.')
            return runtime.ensureSession(route(record))
          })
          .then((result) => {
            // The client already holds the session: a failing stamp must not
            // turn a successful start into a rollback. The host logs it.
            try {
              target.onSessionStarted?.()
            } catch {
              /* reported by the host's callback; see WorkspaceRuntimeRoute */
            }
            return persistRuntimeSession(record, result.sessionId)
          })
        record = {
          session,
          thread,
          providerId,
          cwd: target.cwd,
          runtimeSession,
          turns: [],
          messages: [],
          commandTurns: new Map(),
          status: 'idle',
          updatedAt: Date.now(),
        }
        sessions.set(session.sessionId, record)
        threads.set(thread.threadId, record)
        void record.runtimeSession.catch(() => rollbackSession(record))
        // Re-enter the existing turn command so validation, runtime scheduling and
        // history ownership remain in one place. No asynchronous gap is exposed.
        let firstTurn
        if (input.firstMessage !== undefined) {
          let result: unknown
          try {
            result = service.dispatch(
              {
                ...command,
                name: 'turn.send',
                payload: {
                  sessionId: session.sessionId,
                  threadId: thread.threadId,
                  text: input.firstMessage,
                },
              },
              context,
            )
          } catch {
            result = errorResult(command.requestId, 'not_found', WORKSPACE_UNAVAILABLE)
          }
          const started = ProofResponseSchemas['turn.send'].safeParse(result)
          if (!started.success) {
            // The session was already announced, so its removal must be too.
            rollbackSession(record)
            return result
          }
          firstTurn = started.data.payload
        }
        return ProofResponseSchemas['session.create'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: { session, thread, ...(firstTurn ? { firstTurn } : {}) },
        })
      }

      if (command.name === 'session.rename' || command.name === 'session.delete') {
        const parsed = ProofCommandSchemas[command.name].safeParse(command)
        if (!parsed.success)
          return errorResult(command.requestId, 'validation', 'Invalid session request.')
        options.flush?.()
        const { sessionId } = parsed.data.payload
        const record = sessions.get(sessionId)
        const session =
          record?.session ??
          (options.database ? getSessionSummary(options.database, sessionId) : undefined)
        if (!session) return errorResult(command.requestId, 'not_found', 'Session not found.')
        const timestamp = new Date().toISOString()
        const event =
          parsed.data.name === 'session.rename'
            ? ProofEventSchemas['session.updated'].parse({
                type: 'event',
                name: 'session.updated',
                eventId: randomUUID(),
                timestamp,
                scope: { type: 'environment', environmentId },
                payload: { sessionId, title: parsed.data.payload.title, titleSource: 'user' },
              })
            : ProofEventSchemas['session.deleted'].parse({
                type: 'event',
                name: 'session.deleted',
                eventId: randomUUID(),
                timestamp,
                scope: { type: 'environment', environmentId },
                payload: { sessionId },
              })
        try {
          appendEvent(event)
        } catch (error) {
          options.onPersistenceError?.(error, event.name)
          return errorResult(
            command.requestId,
            'unavailable',
            'The session change could not be saved. Try again.',
          )
        }
        if (parsed.data.name === 'session.rename') {
          for (const item of threads.values()) {
            if (item.session.sessionId !== sessionId) continue
            item.session.title = parsed.data.payload.title
            item.updatedAt = Date.parse(timestamp)
          }
          return ProofResponseSchemas['session.rename'].parse({
            type: 'response',
            requestId: command.requestId,
            payload: { session: { ...session, title: parsed.data.payload.title } },
          })
        }
        for (const item of dropSessionRecords(sessionId)) {
          if (!item.activeTurn) continue
          item.activeTurn.interruptRequested = true
          item.activeTurn = undefined
          void item.runtimeSession
            .then((id) => runtime.cancel({ ...route(item), sessionId: id }))
            .catch(() => undefined)
        }
        return ProofResponseSchemas['session.delete'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: null,
        })
      }

      if (command.name === 'session.open') {
        const parsed = ProofCommandSchemas['session.open'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid session open request.')
        }
        if (options.database && !sessions.has(parsed.data.payload.sessionId)) {
          options.flush?.()
          const session = getSessionSummary(options.database, parsed.data.payload.sessionId)
          if (!session) return errorResult(command.requestId, 'not_found', 'Session not found.')
          const providerId = session.providerId as ProviderId
          if (!providers[providerId]?.capabilities.canLoadSession) {
            return errorResult(
              command.requestId,
              'capability_missing',
              'Provider cannot resume sessions.',
            )
          }
          const rejection = rejectProvider(command.requestId, providerId)
          if (rejection) return rejection
          const providerSessionId = getProviderSessionId(options.database, session.sessionId)
          if (!providerSessionId) {
            return errorResult(
              command.requestId,
              'unavailable',
              'The provider session identity is unavailable.',
            )
          }
          let target: WorkspaceRuntimeRoute | undefined
          try {
            target = resolveWorkspace(session.workspaceId, context)
          } catch {
            /* unavailable */
          }
          if (!target) return errorResult(command.requestId, 'not_found', WORKSPACE_UNAVAILABLE)
          const restoredThreads = listThreadsForSession(options.database, session.sessionId)
          if (!restoredThreads.length)
            return errorResult(command.requestId, 'not_found', 'Thread not found.')
          restoreSession(session, providerId, providerSessionId, target.cwd, restoredThreads)
          return ProofResponseSchemas['session.open'].parse({
            type: 'response',
            requestId: command.requestId,
            payload: { session, threads: restoredThreads },
          })
        }
        const record = sessions.get(parsed.data.payload.sessionId)
        if (!record) return errorResult(command.requestId, 'not_found', 'Session not found.')
        if (!resolveWorkspace(record.session.workspaceId, context)) {
          return errorResult(
            command.requestId,
            'not_found',
            'The session folder is missing, moved, or inaccessible on this environment. Restore the original folder path or its permissions, then try again. Your session is still listed.',
          )
        }
        const providerRejection = rejectProvider(command.requestId, record.providerId)
        if (providerRejection) return providerRejection
        if (!providers[record.providerId].capabilities.canLoadSession) {
          return errorResult(
            command.requestId,
            'capability_missing',
            'Provider cannot resume sessions.',
          )
        }
        void record.runtimeSession
          .then((sessionId) => runtime.ensureSession(route(record, sessionId)))
          .catch(() => undefined)
        return ProofResponseSchemas['session.open'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: {
            session: options.database
              ? getSessionSummary(options.database, record.session.sessionId)
              : summaryOf(record),
            threads: options.database
              ? listThreadsForSession(options.database, record.session.sessionId)
              : [record.thread],
          },
        })
      }

      if (command.name === 'session.history') {
        const parsed = ProofCommandSchemas['session.history'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid session history request.')
        }
        if (options.database) {
          options.flush?.()
          const page = listSessionHistory(options.database, parsed.data.payload)
          if (!page) return errorResult(command.requestId, 'not_found', 'Thread not found.')
          return ProofResponseSchemas['session.history'].parse({
            type: 'response',
            requestId: command.requestId,
            payload: page,
          })
        }
        const record = threads.get(parsed.data.payload.threadId)
        if (!record || record.session.sessionId !== parsed.data.payload.sessionId) {
          return errorResult(command.requestId, 'not_found', 'Thread not found.')
        }
        const page = pageThreadMessages(record.messages, parsed.data.payload)
        return ProofResponseSchemas['session.history'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: {
            messages: page.messages,
            turns: record.turns,
            interactions: [],
            nextCursor: page.nextCursor,
          },
        })
      }

      if (command.name === 'turn.send') {
        const parsed = ProofCommandSchemas['turn.send'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid prompt request.')
        }
        const input = parsed.data.payload
        // A client's own id makes the send retryable; a client that sends none
        // gets a minted one so every turn is still recorded with exactly one.
        const commandId = input.commandId ?? randomUUID()
        const threadRecord = threads.get(input.threadId)
        const record =
          threadRecord?.session.sessionId === input.sessionId ? threadRecord : undefined
        // Access is settled before anything is answered, a replay included: a
        // caller who cannot reach the workspace must not learn what was sent
        // to it. A thread no longer in memory names its workspace from the log.
        const workspaceId = record?.session.workspaceId ?? persistedWorkspaceId(input.sessionId)
        if (workspaceId === undefined) {
          return errorResult(command.requestId, 'not_found', 'Thread not found.')
        }
        if (!resolveWorkspace(workspaceId, context)) {
          return errorResult(
            command.requestId,
            'not_found',
            'The session folder is unavailable. Restore the original folder path or its permissions, then reopen the session.',
          )
        }
        // A live thread has served every send since this process started, so
        // its own map answers without touching the log. Only a thread that is
        // no longer in memory needs the durable lookup, which is exactly the
        // retry that crosses a restart.
        const replayed = !input.commandId
          ? undefined
          : record
            ? record.commandTurns.get(input.commandId)
            : findPersistedTurn(input.sessionId, input.threadId, input.commandId)
        if (replayed) return turnSendResult(command.requestId, replayed)
        if (!record) {
          return errorResult(command.requestId, 'not_found', 'Thread not found.')
        }
        const providerRejection = rejectProvider(command.requestId, record.providerId)
        if (providerRejection) return providerRejection
        if (record.activeTurn?.turn.state === 'running') {
          return errorResult(command.requestId, 'conflict', 'A turn is already in progress.')
        }
        const turn: Turn = {
          turnId: randomUUID(),
          threadId: record.thread.threadId,
          state: 'running',
        }
        const userMessage: Message = {
          messageId: randomUUID(),
          threadId: record.thread.threadId,
          turnId: turn.turnId,
          role: 'user',
          content: [{ type: 'text', text: input.text }],
        }
        const started: TurnStart = { turn, userMessage, commandId }
        if (options.database) {
          try {
            appendEvent(
              ProofEventSchemas['turn.started'].parse({
                type: 'event',
                name: 'turn.started',
                eventId: randomUUID(),
                timestamp: new Date().toISOString(),
                scope: threadScope(record),
                payload: started,
              }),
            )
          } catch (error) {
            options.onPersistenceError?.(error, 'turn.started')
            return errorResult(
              command.requestId,
              'unavailable',
              'The message could not be saved. Try again.',
            )
          }
        }
        record.turns.push(turn)
        record.messages.push(userMessage)
        record.commandTurns.set(commandId, started)
        touch(record, 'running')
        const active: ActiveTurn = {
          turn,
          userMessage,
          interruptRequested: false,
          toolIds: new Map(),
          interactionIds: new Map(),
        }
        record.activeTurn = active
        void record.runtimeSession
          .then((sessionId) =>
            runtime.prompt({
              ...route(record, sessionId),
              prompt: {
                text: input.text,
                blocks: [{ type: 'text', text: input.text }],
              },
              userMessageId: userMessage.messageId,
            }),
          )
          .then(() => {
            if (
              record.activeTurn === active &&
              !active.interruptRequested &&
              turn.state === 'running'
            ) {
              emitCompleted(record, turn.turnId)
              turn.state = 'completed'
              record.activeTurn = undefined
              touch(record, 'idle')
            }
          })
          .catch(() => {
            if (
              record.activeTurn === active &&
              !active.interruptRequested &&
              turn.state === 'running'
            ) {
              emitFailed(record, turn.turnId)
              turn.state = 'failed'
              record.activeTurn = undefined
              touch(record, 'error')
            }
          })
        return turnSendResult(command.requestId, started)
      }

      if (command.name === 'turn.interrupt') {
        const parsed = ProofCommandSchemas['turn.interrupt'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid interrupt request.')
        }
        const record = threads.get(parsed.data.payload.threadId)
        if (!record || record.session.sessionId !== parsed.data.payload.sessionId) {
          return errorResult(command.requestId, 'not_found', 'Thread not found.')
        }
        const providerRejection = rejectProvider(command.requestId, record.providerId)
        if (providerRejection) return providerRejection
        if (!providers[record.providerId].capabilities.canCancelPrompt) {
          return errorResult(
            command.requestId,
            'capability_missing',
            'Provider cannot interrupt prompts.',
          )
        }
        const active = record.activeTurn
        if (!active || active.turn.turnId !== parsed.data.payload.turnId) {
          return errorResult(command.requestId, 'conflict', 'Turn is not in progress.')
        }
        active.interruptRequested = true
        void record.runtimeSession
          .then((sessionId) => runtime.cancel({ ...route(record), sessionId }))
          .then(() => {
            if (record.activeTurn?.turn.turnId !== active.turn.turnId) return
            active.turn.state = 'interrupted'
            record.activeTurn = undefined
            touch(record, 'idle')
            emitInterrupted(record, active.turn.turnId)
          })
          .catch(() => {
            if (record.activeTurn?.turn.turnId !== active.turn.turnId) return
            // Cancellation failure says nothing about the prompt's terminal
            // state. Keep it active to prevent concurrent provider work and
            // allow the client to retry interrupting the same turn. CAL-34
            // owns projection of the eventual provider failure/completion.
            active.interruptRequested = false
          })
        return ProofResponseSchemas['turn.interrupt'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: { turnId: active.turn.turnId },
        })
      }

      return undefined
    },

    onRuntimeEvent(event: RuntimeEvent) {
      const record = threads.get(event.threadId)
      if (!record) return

      if (event.event === 'prompt_started') {
        const active = record.activeTurn
        if (!active || event.data.userMessageId !== active.userMessage.messageId) return
        active.runtimeMessageId = event.messageId
        projectRuntimeEvent(record, event, active)
        return
      }

      const active = record.activeTurn
      const turnScoped =
        event.event === 'prompt_completed' ||
        event.category === 'stream' ||
        event.category === 'tool' ||
        event.category === 'permission' ||
        event.event === 'question_request' ||
        event.event === 'question_resolved' ||
        event.event === 'plan_review_request' ||
        event.event === 'plan_review_resolved' ||
        event.event === 'plan_update' ||
        event.event === 'subtask_update' ||
        event.category === 'error' ||
        event.event === 'process_exited'
      if (
        turnScoped &&
        (!active ||
          !active.runtimeMessageId ||
          (event.messageId !== undefined && event.messageId !== active.runtimeMessageId))
      ) {
        return
      }

      if (!active) {
        projectRuntimeEvent(record, event, undefined)
        return
      }

      if (event.event === 'prompt_completed') {
        const interrupted =
          active.interruptRequested || /abort|cancel|interrupt/i.test(event.data.stopReason ?? '')
        projectRuntimeEvent(record, event, active, interrupted ? 'interrupted' : 'completed')
        active.turn.state = interrupted ? 'interrupted' : 'completed'
        record.activeTurn = undefined
        touch(record, 'idle')
        return
      }

      if (event.event === 'process_exited') {
        const interrupted = active.interruptRequested
        const reason: TurnFailureReason =
          event.data.signal || event.data.exitCode === null
            ? 'provider_process_crashed'
            : 'provider_process_exited'
        projectRuntimeEvent(record, event, active, interrupted ? 'interrupted' : 'failed', reason)
        active.turn.state = interrupted ? 'interrupted' : 'failed'
        record.activeTurn = undefined
        touch(record, interrupted ? 'idle' : 'error')
        return
      }

      if (
        event.event === 'auth_required' ||
        event.event === 'capability_missing' ||
        ((event.event === 'rpc_error' || event.event === 'runtime_error') &&
          event.data.recoverable !== true)
      ) {
        projectRuntimeEvent(record, event, active, 'failed')
        active.turn.state = 'failed'
        record.activeTurn = undefined
        touch(record, 'error')
        return
      }

      projectRuntimeEvent(record, event, active)
    },
  }
  return service
}
