import { randomUUID } from 'node:crypto'
import {
  ProofCommandSchemas,
  ProofEventSchemas,
  ProofResponseSchemas,
  type CommandEnvelope,
  type ErrorCode,
  type EventEnvelope,
  type Message,
  type Session,
  type Thread,
  type Turn,
} from '@openmanager/protocol/node'
import {
  providers,
  type AgentRuntime,
  type HostDeps,
  type RuntimeSessionArgs,
} from '@agentpack/runtime/node'

type ProviderId = keyof typeof providers
type RuntimeEvent = Parameters<HostDeps['emitEvent']>[0]
type ProviderGate = {
  rejection(providerId: string): { code: ErrorCode; message: string } | undefined
}
export type WorkspaceRuntimeRoute = { providerId: string; cwd: string }
export type WorkspaceRuntimeResolver = (workspaceId: string) => WorkspaceRuntimeRoute | undefined
type ActiveTurn = {
  turn: Turn
  userMessage: Message
  interruptRequested: boolean
  runtimeMessageId?: string
}
type ThreadRecord = {
  session: Session
  thread: Thread
  providerId: ProviderId
  cwd: string
  runtimeSession: Promise<string>
  turns: Turn[]
  messages: Message[]
  activeTurn?: ActiveTurn
}

const errorResult = (requestId: string, code: ErrorCode, message: string) => ({
  type: 'error' as const,
  requestId,
  error: { code, message },
})

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
  publishEvent: (event: EventEnvelope) => void,
  resolveWorkspace: WorkspaceRuntimeResolver = (workspaceId) => ({
    providerId: 'opencode',
    cwd: workspaceId,
  }),
) {
  const sessions = new Map<string, ThreadRecord>()
  const threads = new Map<string, ThreadRecord>()

  const route = (record: ThreadRecord, sessionId?: string): RuntimeSessionArgs => ({
    providerId: record.providerId,
    threadId: record.thread.threadId,
    workspaceId: record.session.workspaceId,
    cwd: record.cwd,
    ...(sessionId ? { sessionId } : {}),
  })

  const rejectProvider = (requestId: string, providerId: string) => {
    const rejection = providerGate.rejection(providerId)
    return rejection ? errorResult(requestId, rejection.code, rejection.message) : undefined
  }

  const emitInterrupted = (record: ThreadRecord, turnId: string) => {
    publishEvent(
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

  const emitTurnFailed = (record: ThreadRecord, turnId: string) => {
    publishEvent(
      ProofEventSchemas['turn.failed'].parse({
        type: 'event',
        name: 'turn.failed',
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        scope: {
          type: 'thread',
          environmentId,
          sessionId: record.session.sessionId,
          threadId: record.thread.threadId,
        },
        payload: { turnId, message: 'The turn could not be interrupted.' },
      }),
    )
  }

  const rollbackSession = (record: ThreadRecord) => {
    if (sessions.get(record.session.sessionId) !== record) return
    sessions.delete(record.session.sessionId)
    if (threads.get(record.thread.threadId) === record) threads.delete(record.thread.threadId)
    publishEvent(
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

  // The environment identity is supplied after construction so the service
  // can be assembled before the WebSocket publisher exists.
  let environmentId = ''

  return {
    setEnvironmentId(id: string) {
      environmentId = id
    },

    dispatch(command: CommandEnvelope): unknown | undefined {
      if (command.name === 'session.create') {
        const parsed = ProofCommandSchemas['session.create'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid session create request.')
        }
        const target = resolveWorkspace(parsed.data.payload.workspaceId)
        if (!target) return errorResult(command.requestId, 'not_found', 'Workspace not found.')
        const providerRejection = rejectProvider(command.requestId, target.providerId)
        if (providerRejection) return providerRejection
        const providerId = target.providerId as ProviderId
        const session: Session = {
          sessionId: randomUUID(),
          workspaceId: parsed.data.payload.workspaceId,
          title: parsed.data.payload.title ?? null,
        }
        const thread: Thread = { threadId: randomUUID(), sessionId: session.sessionId }
        let record!: ThreadRecord
        const runtimeSession = Promise.resolve()
          .then(() => runtime.ensureSession(route(record)))
          .then((result) => result.sessionId)
        record = {
          session,
          thread,
          providerId,
          cwd: target.cwd,
          runtimeSession,
          turns: [],
          messages: [],
        }
        sessions.set(session.sessionId, record)
        threads.set(thread.threadId, record)
        void record.runtimeSession.catch(() => rollbackSession(record))
        return ProofResponseSchemas['session.create'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: { session, thread },
        })
      }

      if (command.name === 'session.open') {
        const parsed = ProofCommandSchemas['session.open'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid session open request.')
        }
        const record = sessions.get(parsed.data.payload.sessionId)
        if (!record) return errorResult(command.requestId, 'not_found', 'Session not found.')
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
            session: record.session,
            threads: [record.thread],
            messages: record.messages,
            turns: record.turns,
            interactions: [],
          },
        })
      }

      if (command.name === 'turn.send') {
        const parsed = ProofCommandSchemas['turn.send'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid prompt request.')
        }
        const record = threads.get(parsed.data.payload.threadId)
        if (!record || record.session.sessionId !== parsed.data.payload.sessionId) {
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
          content: [{ type: 'text', text: parsed.data.payload.text }],
        }
        record.turns.push(turn)
        record.messages.push(userMessage)
        record.activeTurn = { turn, userMessage, interruptRequested: false }
        void record.runtimeSession
          .then((sessionId) =>
            runtime.prompt({
              ...route(record, sessionId),
              prompt: {
                text: parsed.data.payload.text,
                blocks: [{ type: 'text', text: parsed.data.payload.text }],
              },
              userMessageId: userMessage.messageId,
            }),
          )
          .then(() => {
            if (
              record.activeTurn?.turn.turnId === turn.turnId &&
              !record.activeTurn.interruptRequested &&
              turn.state === 'running'
            ) {
              turn.state = 'completed'
              record.activeTurn = undefined
            }
          })
          .catch(() => {
            if (
              record.activeTurn?.turn.turnId === turn.turnId &&
              !record.activeTurn.interruptRequested &&
              turn.state === 'running'
            ) {
              turn.state = 'failed'
              record.activeTurn = undefined
            }
          })
        return ProofResponseSchemas['turn.send'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: { turn, userMessage },
        })
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
            emitInterrupted(record, active.turn.turnId)
          })
          .catch(() => {
            if (record.activeTurn?.turn.turnId !== active.turn.turnId) return
            active.turn.state = 'failed'
            record.activeTurn = undefined
            emitTurnFailed(record, active.turn.turnId)
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
      if (event.event === 'prompt_started') {
        const active = threads.get(event.threadId)?.activeTurn
        if (!active || event.data.userMessageId !== active.userMessage.messageId) return
        active.runtimeMessageId = event.messageId
        return
      }
      if (event.event !== 'prompt_completed') return
      const record = threads.get(event.threadId)
      const active = record?.activeTurn
      if (
        !record ||
        !active ||
        !active.runtimeMessageId ||
        event.messageId !== active.runtimeMessageId
      ) {
        return
      }
      const interrupted =
        active.interruptRequested || /abort|cancel|interrupt/i.test(event.data.stopReason ?? '')
      active.turn.state = interrupted ? 'interrupted' : 'completed'
      record.activeTurn = undefined
      if (interrupted) emitInterrupted(record, active.turn.turnId)
    },
  }
}
