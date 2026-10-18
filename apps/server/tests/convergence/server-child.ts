/**
 * The environment server under test, in a process of its own so a test can
 * crash it (hard kill) or restart it (graceful stop, then respawn) on the
 * same data directory.
 *
 * It runs the real `startServer` with title generation and health probes off.
 * The only provider is a fake ACP agent driven from the test over IPC. Run by
 * plain Node (type stripping), not by vitest.
 *
 * Everything here that reaches into the server reads the objects
 * `startServer` returns, or wraps `ws` methods in this process. Nothing under
 * `src/` changes for it.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import {
  FakeClaudeSdk,
  FakeConnectionFactory,
  type FakeAcpConnection,
} from '@agentpack/runtime/testing'
import { startServer } from '../../src/server.ts'
import { DATABASE_FILENAME } from '../../src/db/database.ts'
import {
  listSessionHistory,
  listSessionSummaries,
  listThreadsForSession,
} from '../../src/db/session-store.ts'
import type {
  ChildConfig,
  ChildEvent,
  ChildMessage,
  ChildRequest,
  ScriptStep,
  ServerThreadRead,
  SocketSample,
} from './child-protocol.ts'

const config = JSON.parse(process.env.CONVERGENCE_CHILD_CONFIG ?? '') as ChildConfig
const started = performance.now()
const now = () => Math.round(performance.now() - started)

const send = (message: ChildMessage) => {
  if (process.connected) process.send?.(message)
}
const emit = (event: ChildEvent) => send(event)

process.on('uncaughtException', (error) => {
  emit({
    type: 'fatal',
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  })
  setTimeout(() => process.exit(1), 50)
})
// The test process is the only reason to exist.
process.on('disconnect', () => process.exit(0))

// ---------------------------------------------------------------------------
// Quiet tracking: anything the server publishes, anything the provider does,
// and anything a client sends counts as activity.
// ---------------------------------------------------------------------------

let lastActivity = performance.now()
/** Provider calls running now; quiet needs none. */
let inFlight = 0
const touch = () => {
  lastActivity = performance.now()
}

// ---------------------------------------------------------------------------
// Socket instrumentation, from inside this process: which sockets the server
// holds, what they buffer, and every close the server itself initiates.
// ---------------------------------------------------------------------------

const sockets = new Map<WebSocket, number>()
let nextSocket = 1
const socketId = (ws: WebSocket) => {
  let id = sockets.get(ws)
  if (id === undefined) {
    id = nextSocket++
    sockets.set(ws, id)
  }
  return id
}
const remotePortOf = (ws: WebSocket) =>
  (ws as unknown as { _socket?: { remotePort?: number } })._socket?.remotePort
const prototype = WebSocket.prototype as unknown as {
  send: (...args: unknown[]) => void
  close: (code?: number, reason?: string) => void
  terminate: () => void
  emit: (event: string | symbol, ...args: unknown[]) => boolean
}
const originalSend = prototype.send
prototype.send = function (this: WebSocket, ...args: unknown[]) {
  socketId(this)
  return originalSend.apply(this, args)
}
const originalClose = prototype.close
prototype.close = function (this: WebSocket, code?: number, reason?: string) {
  // `ws` answers a peer's close frame by calling close() with the peer's
  // reason as a Buffer; only the server's own closes pass a string.
  if (this.readyState === WebSocket.OPEN && typeof reason !== 'object') {
    emit({
      type: 'serverClose',
      socket: socketId(this),
      remotePort: remotePortOf(this),
      code,
      reason: reason ?? '',
      at: now(),
    })
  }
  return originalClose.call(this, code, reason)
}
const originalEmit = prototype.emit
prototype.emit = function (this: WebSocket, event: string | symbol, ...args: unknown[]) {
  if (event === 'message') touch()
  if (event === 'close') sockets.delete(this)
  return originalEmit.call(this, event, ...args)
}

// ---------------------------------------------------------------------------
// The fake ACP provider.
// ---------------------------------------------------------------------------

interface ActivePrompt {
  providerSessionId: string
  connection: FakeAcpConnection
  finish: (stopReason: string) => void
  /** Numbers tool ids of scripted prompts. */
  index: number
}

let newSessionDelayMs = config.newSessionDelayMs
let autoScript: ScriptStep[] | null = null
let promptCount = 0
const providerSessions = new Map<string, FakeAcpConnection>()
/** Provider session id → when its `session/new` resolved (epoch ms). */
const resolvedAt = new Map<string, number>()
const activePrompts = new Map<string, ActivePrompt>()

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const providerSessionIdOf = (params: unknown): string => {
  const id = (params as { sessionId?: unknown } | null)?.sessionId
  if (typeof id !== 'string') throw new Error('The runtime sent no provider session id.')
  return id
}

const connections: FakeConnectionFactory = new FakeConnectionFactory((spec) => {
  const connection = () => {
    const found = connections.connections.find((candidate) => candidate.spec === spec)
    if (!found) throw new Error('The fake connection is not registered yet.')
    return found
  }
  // A provider call in flight is activity for as long as it runs (a slow
  // `session/new` ends in a row write). A prompt is the exception: it stays
  // open for the whole turn, and its output is traced step by step.
  const traced =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>, { longLived = false } = {}) =>
    async (...args: A): Promise<R> => {
      touch()
      if (!longLived) inFlight += 1
      try {
        return await fn(...args)
      } finally {
        if (!longLived) inFlight -= 1
        touch()
      }
    }
  return {
    initialize: traced(async () => ({
      protocolVersion: 1,
      authMethods: [],
      // Resume loads the stored provider session, so a host session keeps
      // one provider id across restarts and the fake can find it.
      agentCapabilities: { loadSession: true },
    })),
    newSession: traced(async () => {
      if (newSessionDelayMs > 0) await sleep(newSessionDelayMs)
      const sessionId = `fake-${randomUUID()}`
      providerSessions.set(sessionId, connection())
      resolvedAt.set(sessionId, Date.now())
      return { sessionId }
    }),
    loadSession: traced(async (params) => {
      providerSessions.set(providerSessionIdOf(params), connection())
      return {}
    }),
    listSessions: traced(async () => ({ sessions: [] })),
    setSessionMode: traced(async () => ({})),
    setSessionConfigOption: traced(async () => ({ configOptions: [] })),
    request: traced(async () => ({})),
    cancel: traced(async (params) => {
      activePrompts.get(providerSessionIdOf(params))?.finish('cancelled')
      return {}
    }),
    prompt: traced(
      async (params) => {
        const providerSessionId = providerSessionIdOf(params)
        const index = ++promptCount
        const stopReason = await new Promise<string>((resolve) => {
          const active: ActivePrompt = {
            providerSessionId,
            connection: connection(),
            index,
            finish: (reason) => {
              if (activePrompts.get(providerSessionId) === active) {
                activePrompts.delete(providerSessionId)
              }
              resolve(reason)
            },
          }
          activePrompts.set(providerSessionId, active)
          if (autoScript) void runScript(active, autoScript)
        })
        return { stopReason }
      },
      { longLived: true },
    ),
  }
})

async function update(active: ActivePrompt, update: Record<string, unknown>): Promise<void> {
  touch()
  await active.connection.sessionUpdate({ sessionId: active.providerSessionId, update })
  touch()
}

const text = (value: string) => ({ type: 'text', text: value })

async function runScript(active: ActivePrompt, steps: ScriptStep[]): Promise<void> {
  try {
    for (const [index, step] of steps.entries()) {
      if (step.op === 'text') {
        await update(active, { sessionUpdate: 'agent_message_chunk', content: text(step.text) })
      } else if (step.op === 'thought') {
        await update(active, { sessionUpdate: 'agent_thought_chunk', content: text(step.text) })
      } else if (step.op === 'tool') {
        const toolCallId = `tool-${active.index}-${index}`
        await update(active, {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: step.title ?? 'Read file',
          kind: 'read',
          status: 'in_progress',
        })
        if (step.status !== 'in_progress') {
          await update(active, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: step.status,
          })
        }
      } else {
        active.finish(step.stopReason ?? 'end_turn')
      }
    }
  } catch (error) {
    emit({ type: 'fatal', error: `scripted prompt failed: ${String(error)}` })
  }
}

// ---------------------------------------------------------------------------
// The server.
// ---------------------------------------------------------------------------

// The runtime checks that a Claude executable exists before the fake SDK
// takes over; any executable will do.
process.env.CLAUDE_CODE_BIN = process.execPath

const claudeSdk = new FakeClaudeSdk()
const server = await startServer({
  port: 0,
  dataDir: config.dataDir,
  logLevel: 'error',
  workspaces: [config.workspaceRoot],
  allowedHosts: config.allowedHosts,
  generateTitles: false,
  probeProviders: false,
  runtimeOptions: {
    connections,
    claudeSdk,
    // Model listing through a provider's CLI: nothing to list, nothing spawned.
    execFile: async () => ({ stdout: '', stderr: '' }),
    // Health probes off: they would spawn connections on their own schedule.
    health: { schedule: () => ({ cancel() {} }) },
  },
})

// Rate limits guard against abuse; the scenarios build hundreds of sessions
// and turns from one device, which is not what this harness measures.
Object.assign(server.rateLimiter, {
  consume: () => ({ allowed: true, remaining: Number.MAX_SAFE_INTEGER }),
  blocked: () => ({ allowed: true, remaining: Number.MAX_SAFE_INTEGER }),
})
// Everything the server sends is activity.
const sockets$ = server.sockets as unknown as Record<string, (...args: unknown[]) => unknown>
for (const name of ['publish', 'publishEvent', 'publishToFollowers']) {
  const original = sockets$[name]!.bind(server.sockets)
  sockets$[name] = (...args: unknown[]) => {
    touch()
    return original(...args)
  }
}

let readDatabase: DatabaseSync | undefined
const database = () =>
  (readDatabase ??= new DatabaseSync(join(config.dataDir, DATABASE_FILENAME), { readOnly: true }))

const providerSessionFor = (sessionId: string): string | undefined => {
  const row = database()
    .prepare('SELECT provider_session_id FROM sessions WHERE session_id = ?')
    .get(sessionId) as { provider_session_id: string | null } | undefined
  return row?.provider_session_id ?? undefined
}

/** The prompt a host session's provider is running, once it has started. */
async function promptOf(sessionId: string, timeoutMs = 10_000): Promise<ActivePrompt> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const providerSessionId = providerSessionFor(sessionId)
    const active = providerSessionId ? activePrompts.get(providerSessionId) : undefined
    if (active) return active
    if (performance.now() > deadline) {
      throw new Error(`No prompt is running for session ${sessionId}.`)
    }
    await sleep(10)
  }
}

function readThread(sessionId: string, threadId: string): ServerThreadRead {
  const pages = []
  let cursor: { ordinal: number } | undefined
  for (;;) {
    const page = listSessionHistory(database(), {
      sessionId,
      threadId,
      ...(cursor ? { cursor } : {}),
    })
    if (!page) throw new Error(`Thread ${threadId} is not in session ${sessionId}.`)
    pages.push(page)
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  const oldestFirst = [...pages].reverse()
  return {
    turns: pages[0]!.turns,
    messages: oldestFirst.flatMap((page) => page.messages),
    reasoning: oldestFirst.flatMap((page) => page.reasoning),
    tools: oldestFirst.flatMap((page) => page.tools),
    order: oldestFirst.flatMap((page) => page.order),
    interactions: pages[0]!.interactions.map(({ turnId, interaction }) => ({
      turnId,
      interaction,
    })),
  }
}

async function handle(request: ChildRequest): Promise<unknown> {
  switch (request.op) {
    case 'emitText':
      return update(await promptOf(request.sessionId), {
        sessionUpdate: 'agent_message_chunk',
        content: text(request.text),
      })
    case 'emitThought':
      return update(await promptOf(request.sessionId), {
        sessionUpdate: 'agent_thought_chunk',
        content: text(request.text),
      })
    case 'openTool':
      return update(await promptOf(request.sessionId), {
        sessionUpdate: 'tool_call',
        toolCallId: request.toolCallId,
        title: request.title ?? 'Run tests',
        kind: 'execute',
        status: 'in_progress',
      })
    case 'updateTool':
      return update(await promptOf(request.sessionId), {
        sessionUpdate: 'tool_call_update',
        toolCallId: request.toolCallId,
        status: request.status,
      })
    case 'askPermission': {
      const active = await promptOf(request.sessionId)
      touch()
      // Answered later by a client; the request itself is what the test needs.
      void active.connection
        .requestPermission({
          sessionId: active.providerSessionId,
          toolCall: {
            toolCallId: request.toolCallId,
            title: request.title ?? 'Edit files',
            kind: 'edit',
          },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        })
        .catch(() => undefined)
        .finally(touch)
      return null
    }
    case 'askQuestion': {
      const active = await promptOf(request.sessionId)
      touch()
      void active.connection
        .extMethod('cursor/ask_question', {
          questions: [
            {
              id: request.questionId,
              prompt: 'Which one?',
              options: [
                { id: 'a', label: 'A' },
                { id: 'b', label: 'B' },
              ],
            },
          ],
        })
        .catch(() => undefined)
        .finally(touch)
      return null
    }
    case 'completeTurn':
      touch()
      ;(await promptOf(request.sessionId)).finish(request.stopReason ?? 'end_turn')
      return null
    case 'crashProvider': {
      const providerSessionId = providerSessionFor(request.sessionId)
      const connection = providerSessionId ? providerSessions.get(providerSessionId) : undefined
      if (!connection) throw new Error(`No provider process for session ${request.sessionId}.`)
      touch()
      await connection.crash(1)
      return null
    }
    case 'emitUnstorableImage':
      return update(await promptOf(request.sessionId), {
        sessionUpdate: 'agent_message_chunk',
        // Not base64: the artifact store refuses it ("Invalid generated image").
        content: { type: 'image', mimeType: 'image/png', data: 'not base64!' },
      })
    case 'emitSubtask': {
      const active = await promptOf(request.sessionId)
      await update(active, {
        sessionUpdate: 'tool_call',
        toolCallId: request.toolCallId,
        title: 'task',
        kind: 'think',
        status: 'in_progress',
      })
      await update(active, {
        sessionUpdate: 'tool_call_update',
        toolCallId: request.toolCallId,
        status: 'completed',
        rawInput: { subagent_type: 'general', description: 'Child work' },
        rawOutput: { output: '', metadata: { sessionId: request.childProviderSessionId } },
      })
      return null
    }
    case 'streamText': {
      const active = await promptOf(request.sessionId)
      const tickMs = 50
      const chunk = 'x'.repeat(Math.max(1, Math.round((request.bytesPerSecond * tickMs) / 1000)))
      const end = performance.now() + request.durationMs
      let next = performance.now()
      let bytes = 0
      while (performance.now() < end && activePrompts.get(active.providerSessionId) === active) {
        await update(active, { sessionUpdate: 'agent_message_chunk', content: text(chunk) })
        bytes += chunk.length
        next += tickMs
        await sleep(Math.max(0, next - performance.now()))
      }
      return { bytes }
    }
    case 'emitTextThenUnstorableImage': {
      const active = await promptOf(request.sessionId)
      // Both before anything yields to a timer: the text's batch (100 ms) is
      // still open when the image's notice goes out.
      touch()
      await Promise.all([
        active.connection.sessionUpdate({
          sessionId: active.providerSessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: text(request.text) },
        }),
        active.connection.sessionUpdate({
          sessionId: active.providerSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'image', mimeType: 'image/png', data: 'not base64!' },
          },
        }),
      ])
      touch()
      return null
    }
    case 'claudeWaitPrompt': {
      const deadline = performance.now() + 10_000
      while ((claudeSdk.queries.at(-1)?.prompts.length ?? 0) < request.prompts) {
        if (performance.now() > deadline) throw new Error('The Claude session was never prompted.')
        await sleep(10)
      }
      return null
    }
    case 'claudeBackground':
      touch()
      claudeSdk.last.emitBackgroundTasks(request.tasks)
      return null
    case 'claudeComplete': {
      touch()
      const query = claudeSdk.last
      const prompt = query.prompts.at(-1) as { uuid?: string } | undefined
      query.emitResult({ ...(prompt?.uuid ? { userMessageUuid: prompt.uuid } : {}) })
      return null
    }
    case 'setNewSessionDelay':
      newSessionDelayMs = request.ms
      return null
    case 'setAutoScript':
      autoScript = request.steps
      return null
    case 'waitQuiet': {
      const deadline = performance.now() + request.timeoutMs
      while (inFlight > 0 || performance.now() - lastActivity < request.quietMs) {
        if (performance.now() > deadline) throw new Error('The server never went quiet.')
        await sleep(20)
      }
      return null
    }
    case 'readThread':
      return readThread(request.sessionId, request.threadId)
    case 'readStamps': {
      const rows = database()
        .prepare('SELECT session_id, provider_session_id FROM sessions')
        .all() as Array<{ session_id: string; provider_session_id: string | null }>
      const stamps: Record<string, number> = {}
      for (const row of rows) {
        const at = row.provider_session_id ? resolvedAt.get(row.provider_session_id) : undefined
        if (at !== undefined) stamps[row.session_id] = at
      }
      return stamps
    }
    case 'readSessionThreads':
      return listThreadsForSession(database(), request.sessionId).map((thread) => thread.threadId)
    case 'readSessions': {
      // The server's own summary, `waitingOn` and `inBackground` included
      // (sessionRowToSummary → readSessionActivity), never re-derived here.
      const sessions = []
      let cursor: { updatedAt: string; sessionId: string } | undefined
      for (;;) {
        const page = listSessionSummaries(database(), { limit: 100, ...(cursor ? { cursor } : {}) })
        sessions.push(...page.sessions)
        if (!page.nextCursor) return sessions
        cursor = page.nextCursor
      }
    }
    case 'sampleSockets':
      return [...sockets.entries()]
        .filter(([ws]) => ws.readyState === WebSocket.OPEN)
        .map(([ws, socket]): SocketSample => ({
          socket,
          remotePort: remotePortOf(ws),
          readyState: ws.readyState,
          bufferedAmount: ws.bufferedAmount,
        }))
    case 'shutdown':
      await server.close()
      readDatabase?.close()
      setTimeout(() => process.exit(0), 0)
      return null
  }
}

process.on('message', (message: ChildRequest) => {
  void handle(message).then(
    (result) => send({ type: 'reply', id: message.id, ok: true, result: result ?? null }),
    (error: unknown) =>
      send({
        type: 'reply',
        id: message.id,
        ok: false,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      }),
  )
})

emit({
  type: 'ready',
  port: server.port,
  environmentId: server.identity.environmentId,
  pid: process.pid,
})
