import {
  ProofEventSchemas,
  type Environment,
  type Interaction,
  type InteractionResponse,
  type Message,
  type ProofEvent,
  type Session,
  type Thread,
  type Turn,
  type TurnFailureReason,
  type Workspace,
} from '@openmanager/protocol'
import { EnvironmentClientError } from './errors'
import {
  applyActiveSession,
  applyActiveThread,
  applyConnection,
  applyEnvironment,
  applyEvent,
  applySessionCreated,
  applyThreadHydration,
  applyWorkspaceList,
  applyWorkspaceRemoved,
  createInitialState,
  createThreadState,
  deriveSessionStatus,
  selectSessionList,
} from './state'
import { createEnvironmentStore } from './store'
import type {
  ConnectionState,
  EnvironmentClient,
  EnvironmentCommandName,
  EnvironmentCommands,
  EnvironmentState,
  ThreadTarget,
} from './types'
import { WIRE_COMMANDS } from './wire'

export interface MockSeedSession {
  session: Session
  threads?: Thread[]
  turns?: Turn[]
  messages?: Message[]
}

export interface MockSeed {
  environment?: Environment
  workspaces?: Workspace[]
  sessions?: MockSeedSession[]
  activeSessionId?: string | null
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
  /** Resolves once all scheduled streaming has drained. */
  settle(): Promise<void>
}

const ALL_COMMANDS = Object.keys(WIRE_COMMANDS) as EnvironmentCommandName[]

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
  const respond =
    options.respond === undefined
      ? (turn: MockTurnContext) => splitChunks(`You said: ${turn.text}`)
      : options.respond
  const capabilities = new Set(options.capabilities ?? ALL_COMMANDS)
  const environment: Environment = options.seed?.environment ?? {
    environmentId: 'mock-environment',
    name: 'Mock environment',
  }
  const store = createEnvironmentStore(seedState(environment, options.seed, capabilities))
  const calls: MockCommandCall[] = []
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
    store.update((state) => applyEvent(state, parsed))
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
        const workspace: Workspace = { workspaceId: input.path, name: input.name }
        emit({
          ...base(),
          name: 'workspace.updated',
          scope: envScope(),
          payload: { workspace },
        })
        return workspace
      }),
    removeWorkspace: (workspaceId) =>
      run('removeWorkspace', workspaceId, () => {
        if (!store.getState().workspaces[workspaceId]) {
          throw new EnvironmentClientError('not_found', 'Workspace not found.')
        }
        cancelScriptsForThreads(
          selectSessionList(store.getState(), workspaceId).flatMap(
            (session) => session.threadIds,
          ),
        )
        store.update((state) => applyWorkspaceRemoved(state, workspaceId))
      }),
    listSessions: (workspaceId) =>
      run('listSessions', workspaceId, () => selectSessionList(store.getState(), workspaceId)),
    createSession: (input) =>
      run('createSession', input, () => {
        if (!store.getState().workspaces[input.workspaceId]) {
          throw new EnvironmentClientError('not_found', 'Workspace not found.')
        }
        const session: Session = {
          sessionId: nextId(),
          workspaceId: input.workspaceId,
          title: input.title ?? null,
        }
        const thread: Thread = { threadId: nextId(), sessionId: session.sessionId }
        emit({ ...base(), name: 'session.created', scope: envScope(), payload: { session } })
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
        store.update((state) => applySessionCreated(state, { session, thread }))
        return { session, thread }
      }),
    openSession: (sessionId) =>
      run('openSession', sessionId, () => {
        const session = store.getState().sessions[sessionId]
        if (!session) throw new EnvironmentClientError('not_found', 'Session not found.')
        store.update((state) => {
          let next = state
          for (const threadId of session.threadIds) {
            next = applyThreadHydration(next, threadId, 'ready')
          }
          return applyActiveSession(next, sessionId)
        })
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
          payload: { sessionId, title },
        })
      }),
    deleteSession: (sessionId) =>
      run('deleteSession', sessionId, () => {
        const session = store.getState().sessions[sessionId]
        if (!session) throw new EnvironmentClientError('not_found', 'Session not found.')
        cancelScriptsForThreads(session.threadIds)
        emit({ ...base(), name: 'session.deleted', scope: envScope(), payload: { sessionId } })
      }),
    sendTurn: (input) =>
      run('sendTurn', input, () => {
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
          content: [{ type: 'text', text: input.text }],
        }
        emit({
          ...base(),
          name: 'turn.started',
          scope: threadScope(input),
          payload: { turn, userMessage },
        })
        const context: MockTurnContext = { ...input, turnId: turn.turnId }
        const chunks = respond ? respond(context) : null
        if (chunks) scriptReply(context, chunks)
        return { turn, userMessage }
      }),
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
  }

  return {
    commands,
    calls,
    getState: store.getState,
    subscribe: store.subscribe,
    supports: (command) => capabilities.has(command),
    setActiveSession: (sessionId) => store.update((state) => applyActiveSession(state, sessionId)),
    setActiveThread: (threadId) => store.update((state) => applyActiveThread(state, threadId)),
    connect: () =>
      store.update((state) =>
        applyConnection(state, {
          phase: 'connected',
          hasConnected: true,
          failure: null,
          capabilities: [...capabilities].map((command) => WIRE_COMMANDS[command]),
        }),
      ),
    disconnect: () =>
      store.update((state) => applyConnection(state, { phase: 'closed', failure: null })),
    dispose: () => {
      disposed = true
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
    settle,
  }
}

function seedState(
  environment: Environment,
  seed: MockSeed | undefined,
  capabilities: ReadonlySet<EnvironmentCommandName>,
): EnvironmentState {
  let state = applyEnvironment(createInitialState(), environment)
  state = applyConnection(state, {
    phase: 'connected',
    hasConnected: true,
    capabilities: [...capabilities].map((command) => WIRE_COMMANDS[command]),
  })
  state = applyWorkspaceList(state, seed?.workspaces ?? [])
  for (const entry of seed?.sessions ?? []) {
    const threads = entry.threads ?? [{ threadId: `${entry.session.sessionId}-thread`, sessionId: entry.session.sessionId }]
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
  }
  for (const session of Object.values(state.sessions)) {
    const threads = session.threadIds.map((id) => state.threads[id]!)
    const status = deriveSessionStatus(threads)
    if (status !== session.status) {
      state = { ...state, sessions: { ...state.sessions, [session.sessionId]: { ...session, status } } }
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
