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
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import {
  FakeClaudeSdk,
  FakeConnectionFactory,
  type FakeAcpConnection,
} from '@agentpack/runtime/testing'
import { startServer } from '../../src/server.ts'
import type { Delivery } from '../../src/event-delivery.ts'
import { DATABASE_FILENAME } from '../../src/db/database.ts'
import { isDerivedRecord, scopeKey } from '../../src/db/event-repository.ts'
import {
  FragmentAssembler,
  type ProofEvent,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import {
  listAllSessionSummaries,
  readThreadState,
  listThreadsForSession,
} from '../../src/db/session-store.ts'
import {
  DELIVERIES_FILENAME,
  type AuditRow,
  type ChildConfig,
  type ChildEvent,
  type ChildMessage,
  type ChildRequest,
  type KillAt,
  type ScriptStep,
  type ServerThreadRead,
  type SocketSample,
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

// ---------------------------------------------------------------------------
// Delivery log (test-only): which socket held which subscription, what each
// publish owed and handed to which socket, and the values responses carried.
// The server's own objects are only observed: its `ws` sends and messages,
// and its `sockets.publish` (wrapped below, once the server exists).
// ---------------------------------------------------------------------------

const deliveryFile = join(config.dataDir, DELIVERIES_FILENAME)
/** The audit's newest `seq`, once the server (and so the database) exists. */
let auditHead = (): number => 0
const socketKey = (ws: WebSocket) => `${process.pid}:${socketId(ws)}`
const deliver = (ws: WebSocket | undefined, record: Record<string, unknown>) => {
  let head = -1
  try {
    head = auditHead()
  } catch {
    // The database is closed: the process is shutting down.
  }
  appendFileSync(
    deliveryFile,
    `${JSON.stringify({
      ...(ws ? { s: socketKey(ws), port: remotePortOf(ws) } : {}),
      ...record,
      a: head,
      at: Date.now(),
    })}\n`,
  )
}
/** Granted subscriptions per socket: subscription id → scope key. */
const granted = new Map<WebSocket, Map<string, string>>()
/** Commands received and not yet answered, per socket, by request id. */
const asked = new Map<
  WebSocket,
  Map<string, { name: string; key: string | null; subscriptionId?: string }>
>()
/** The sockets the publish running now handed its record to. */
let publishing: Set<WebSocket> | undefined
const keyOf = (scope: unknown): string | null => {
  try {
    return scope ? scopeKey(scope as SubscriptionScope) : null
  } catch {
    return null
  }
}
const forget = (ws: WebSocket) => {
  if (granted.delete(ws) || asked.delete(ws)) deliver(ws, { k: 'closed' })
  asked.delete(ws)
}

/** What a response hands the client that it takes as session times and workspace recency. */
function carriedOf(payload: Record<string, unknown>) {
  const workspaces: Record<string, string | null> = {}
  const sessions: Record<string, string> = {}
  const values = (list: unknown): unknown[] =>
    Array.isArray(list) ? list : list && typeof list === 'object' ? Object.values(list) : []
  const takeWorkspaces = (list: unknown) => {
    for (const item of values(list) as Array<{ workspaceId?: unknown; lastActivityAt?: unknown }>) {
      if (typeof item?.workspaceId === 'string') {
        workspaces[item.workspaceId] =
          typeof item.lastActivityAt === 'string' ? item.lastActivityAt : null
      }
    }
  }
  const takeSessions = (list: unknown) => {
    for (const item of values(list) as Array<{ sessionId?: unknown; updatedAt?: unknown }>) {
      if (typeof item?.sessionId === 'string' && typeof item.updatedAt === 'string') {
        sessions[item.sessionId] = item.updatedAt
      }
    }
  }
  takeWorkspaces(payload.workspaces)
  takeSessions(payload.sessions)
  takeSessions(payload.session ? [payload.session] : [])
  const state = (payload.snapshot as { state?: Record<string, unknown> } | undefined)?.state
  takeWorkspaces(state?.workspaces)
  takeSessions(state?.sessions)
  const session = payload.session as { sessionId?: string; workspaceId?: string } | undefined
  const announced =
    typeof payload.announcedAt === 'string' && session?.workspaceId && session.sessionId
      ? { workspaceId: session.workspaceId, at: payload.announcedAt }
      : null
  // The answer's session is a bare Session; the client files it at announcedAt.
  if (announced && session?.sessionId) sessions[session.sessionId] = announced.at
  return { workspaces, sessions, announced }
}

/** A response the server sends: settle the request it answers. */
function answered(ws: WebSocket, encoded: string) {
  const head = encoded.slice(0, 400)
  if (!head.includes('"type":"response"')) return
  const requestId = /"requestId":"([^"]+)"/.exec(head)?.[1]
  const request = requestId ? asked.get(ws)?.get(requestId) : undefined
  if (!request || !requestId) return
  asked.get(ws)!.delete(requestId)
  let message: { payload?: Record<string, unknown>; error?: { code?: string } }
  try {
    message = JSON.parse(encoded) as typeof message
  } catch {
    return
  }
  const payload = message.payload ?? {}
  if (request.name === 'subscription.unsubscribe') {
    const subscriptions = granted.get(ws)
    const key = request.subscriptionId ? subscriptions?.get(request.subscriptionId) : undefined
    if (request.subscriptionId) subscriptions?.delete(request.subscriptionId)
    deliver(ws, { k: 'end', key: key ?? null })
    return
  }
  if (request.name === 'subscription.subscribe' || request.name === 'subscription.replay') {
    const subscriptionId = payload.subscriptionId
    const key = keyOf(payload.scope) ?? request.key
    if (typeof subscriptionId !== 'string' || !key) {
      deliver(ws, { k: 'refuse', key: request.key, code: message.error?.code ?? null })
      return
    }
    let subscriptions = granted.get(ws)
    if (!subscriptions) granted.set(ws, (subscriptions = new Map()))
    subscriptions.set(subscriptionId, key)
    const mode = payload.mode === 'replay' || payload.mode === 'snapshot' ? payload.mode : 'live'
    const base =
      mode === 'replay'
        ? ((payload.to as { sequence?: number } | undefined)?.sequence ?? null)
        : mode === 'snapshot'
          ? ((payload.snapshot as { cursor?: { sequence?: number } } | undefined)?.cursor
              ?.sequence ?? null)
          : null
    const replayed = Array.isArray(payload.events)
      ? (payload.events as Array<{ cursor: { sequence: number } }>).map(
          (record) => record.cursor.sequence,
        )
      : []
    deliver(ws, { k: 'grant', key, mode, base, replayed })
  }
  const carried = carriedOf(payload)
  if (
    Object.keys(carried.workspaces).length > 0 ||
    Object.keys(carried.sessions).length > 0 ||
    carried.announced
  ) {
    deliver(ws, { k: 'carried', ...carried })
  }
}

/** A command the server received: remember it until it is answered. */
function received(ws: WebSocket, data: unknown) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : typeof data === 'string' ? data : ''
  if (!text || text.length > 256 * 1024 || !text.includes('"command"')) return
  let message: {
    type?: string
    name?: string
    requestId?: string
    payload?: Record<string, unknown>
  }
  try {
    message = JSON.parse(text) as typeof message
  } catch {
    return
  }
  if (message.type !== 'command' || !message.name || !message.requestId) return
  const key = keyOf(message.payload?.scope)
  let pending = asked.get(ws)
  if (!pending) asked.set(ws, (pending = new Map()))
  pending.set(message.requestId, {
    name: message.name,
    key,
    ...(typeof message.payload?.subscriptionId === 'string'
      ? { subscriptionId: message.payload.subscriptionId }
      : {}),
  })
  if (message.name.startsWith('subscription.')) {
    deliver(ws, { k: 'request', name: message.name, key, requestId: message.requestId })
  }
}

const prototype = WebSocket.prototype as unknown as {
  send: (...args: unknown[]) => void
  close: (code?: number, reason?: string) => void
  terminate: () => void
  emit: (event: string | symbol, ...args: unknown[]) => boolean
}
const originalSend = prototype.send
/** Fragmented messages in progress, per socket (protocol v19 framing). */
const assemblers = new Map<WebSocket, FragmentAssembler>()
prototype.send = function (this: WebSocket, ...args: unknown[]) {
  socketId(this)
  let text: string | undefined
  if (typeof args[0] === 'string') text = args[0]
  else if (Buffer.isBuffer(args[0])) {
    let assembler = assemblers.get(this)
    if (!assembler) assemblers.set(this, (assembler = new FragmentAssembler()))
    const whole = assembler.push(new Uint8Array(args[0]))
    if (whole) text = Buffer.from(whole).toString('utf8')
  }
  if (text !== undefined) {
    if (publishing && text.startsWith('{"type":"event","name":"subscription.event"')) {
      publishing.add(this)
    }
    answered(this, text)
  }
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
  forget(this)
  return originalClose.call(this, code, reason)
}
const originalTerminate = prototype.terminate
prototype.terminate = function (this: WebSocket) {
  forget(this)
  return originalTerminate.call(this)
}
const originalEmit = prototype.emit
prototype.emit = function (this: WebSocket, event: string | symbol, ...args: unknown[]) {
  if (event === 'message') {
    touch()
    received(this, args[0])
  }
  if (event === 'close') {
    sockets.delete(this)
    forget(this)
  }
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

// A restart: what the server writes while it boots (recovery) comes after
// this marker and before the 'boot' one below. The first boot has no audit.
if (existsSync(join(config.dataDir, DATABASE_FILENAME))) {
  try {
    const writer = new DatabaseSync(join(config.dataDir, DATABASE_FILENAME))
    try {
      writer.exec('PRAGMA busy_timeout = 10000')
      writer.exec("INSERT INTO convergence_audit (kind) VALUES ('start')")
    } finally {
      writer.close()
    }
  } catch {
    // Not created yet: the first boot ended before the audit was installed.
  }
}

const claudeSdk = new FakeClaudeSdk()
// The crash-window seam: a kill inside a chosen event-log commit.
let armedKill: KillAt | undefined = config.killAt ? { ...config.killAt } : undefined
const killAtCommit =
  (phase: KillAt['phase']) =>
  (records: readonly { event: ProofEvent }[]): void => {
    const armed = armedKill
    if (!armed || armed.phase !== phase) return
    const matches = (event: ProofEvent) =>
      event.name === armed.name && !(armed.producer && isDerivedRecord(event))
    if (!records.some((record) => matches(record.event))) return
    if ((armed.skip ?? 0) > 0) {
      armed.skip = (armed.skip ?? 0) - 1
      return
    }
    process.kill(process.pid, 'SIGKILL')
  }

const server = await startServer({
  commitHooks: { beforeCommit: killAtCommit('before'), afterCommit: killAtCommit('after') },
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
// Everything the server sends is activity. Every item leaves the delivery
// queue through `deliver`, which is also where the S13 seam drops a record.
let dropArmed: string | undefined
const dropped: Array<{ threadId: string; sequence: number; event: string }> = []
{
  const send = server.sockets.deliver.bind(server.sockets)
  server.sockets.deliver = (item: Delivery) => {
    touch()
    const scope = item.kind === 'record' ? item.record.cursor.scope : undefined
    if (
      dropArmed !== undefined &&
      item.kind === 'record' &&
      scope?.type === 'thread' &&
      scope.threadId === dropArmed &&
      item.record.event.name === 'message.delta'
    ) {
      dropArmed = undefined
      dropped.push({
        threadId: scope.threadId,
        sequence: item.record.cursor.sequence,
        event: item.record.event.name,
      })
      return
    }
    send(item)
  }
}

let readDatabase: DatabaseSync | undefined
const database = () =>
  (readDatabase ??= new DatabaseSync(join(config.dataDir, DATABASE_FILENAME), { readOnly: true }))

// ---------------------------------------------------------------------------
// Provenance audit (test-only): triggers on this temp database log every
// event appended, every write to a session's `updated_at` or provider
// identity, and every workspace `last_used_at`, in one order (`seq`). The
// projection writes a session's time inside the transaction that appends
// its event (event-repository.ts, `writeScope`), so a write and the event
// that announces it sit side by side; a write no event announces is what
// the runtime stamp and boot recovery do. Installed once, right after the
// first boot and before any client connects; a restart finds them in place
// and its boot-time recovery is audited too. Nothing under `src/` changes.
// ---------------------------------------------------------------------------

{
  const writer = new DatabaseSync(join(config.dataDir, DATABASE_FILENAME))
  try {
    writer.exec('PRAGMA busy_timeout = 10000')
    writer.exec(`
      CREATE TABLE IF NOT EXISTS convergence_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        op TEXT,
        scope_key TEXT,
        sequence INTEGER,
        event_name TEXT,
        event_id TEXT,
        ts INTEGER,
        session_id TEXT,
        workspace_id TEXT,
        thread_id TEXT,
        title INTEGER,
        status TEXT,
        last_activity_at TEXT,
        old_value INTEGER,
        new_value INTEGER,
        old_provider TEXT,
        new_provider TEXT
      );
      CREATE TRIGGER IF NOT EXISTS convergence_event AFTER INSERT ON event_log BEGIN
        INSERT INTO convergence_audit (
          kind, scope_key, sequence, event_name, event_id, ts, session_id, workspace_id,
          thread_id, title, status, last_activity_at
        ) VALUES (
          'event', NEW.scope_key, NEW.sequence, NEW.event_name, NEW.event_id, NEW.created_at,
          COALESCE(
            json_extract(NEW.event_json, '$.scope.sessionId'),
            json_extract(NEW.event_json, '$.payload.sessionId'),
            json_extract(NEW.event_json, '$.payload.session.sessionId')
          ),
          COALESCE(
            json_extract(NEW.event_json, '$.payload.workspace.workspaceId'),
            json_extract(NEW.event_json, '$.payload.session.workspaceId'),
            json_extract(NEW.event_json, '$.payload.workspaceId')
          ),
          json_extract(NEW.event_json, '$.scope.threadId'),
          json_type(NEW.event_json, '$.payload.title') IS NOT NULL,
          json_extract(NEW.event_json, '$.payload.status'),
          json_extract(NEW.event_json, '$.payload.workspace.lastActivityAt')
        );
      END;
      CREATE TRIGGER IF NOT EXISTS convergence_session_insert AFTER INSERT ON sessions BEGIN
        INSERT INTO convergence_audit (kind, op, session_id, workspace_id, new_value, new_provider)
        VALUES ('session', 'insert', NEW.session_id, NEW.workspace_id, NEW.updated_at,
          NEW.provider_session_id);
      END;
      CREATE TRIGGER IF NOT EXISTS convergence_session_update
        AFTER UPDATE OF updated_at, provider_session_id ON sessions
        WHEN NEW.updated_at IS NOT OLD.updated_at
          OR NEW.provider_session_id IS NOT OLD.provider_session_id
      BEGIN
        INSERT INTO convergence_audit (
          kind, op, session_id, workspace_id, old_value, new_value, old_provider, new_provider
        ) VALUES ('session', 'update', NEW.session_id, NEW.workspace_id, OLD.updated_at,
          NEW.updated_at, OLD.provider_session_id, NEW.provider_session_id);
      END;
      CREATE TRIGGER IF NOT EXISTS convergence_session_delete AFTER DELETE ON sessions BEGIN
        INSERT INTO convergence_audit (kind, op, session_id, workspace_id, old_value)
        VALUES ('session', 'delete', OLD.session_id, OLD.workspace_id, OLD.updated_at);
      END;
      CREATE TRIGGER IF NOT EXISTS convergence_workspace_used
        AFTER UPDATE OF last_used_at ON workspaces
        WHEN NEW.last_used_at IS NOT OLD.last_used_at
      BEGIN
        INSERT INTO convergence_audit (kind, workspace_id, old_value, new_value)
        VALUES ('workspace', NEW.workspace_id, OLD.last_used_at, NEW.last_used_at);
      END;
      INSERT INTO convergence_audit (kind) VALUES ('boot');
    `)
  } finally {
    writer.close()
  }
}
auditHead = () =>
  (database().prepare('SELECT MAX(seq) AS seq FROM convergence_audit').get() as { seq: number }).seq

function readAudit(): AuditRow[] {
  const rows = database().prepare('SELECT * FROM convergence_audit ORDER BY seq').all() as Array<
    Record<string, string | number | null>
  >
  return rows.map((row): AuditRow => {
    const seq = row.seq as number
    switch (row.kind) {
      case 'event':
        return {
          seq,
          kind: 'event',
          scopeKey: row.scope_key as string,
          sequence: row.sequence as number,
          name: row.event_name as string,
          eventId: row.event_id as string,
          ts: row.ts as number,
          sessionId: row.session_id as string | null,
          workspaceId: row.workspace_id as string | null,
          threadId: row.thread_id as string | null,
          title: row.title === 1,
          status: row.status as string | null,
          lastActivityAt: row.last_activity_at as string | null,
        }
      case 'session':
        return {
          seq,
          kind: 'session',
          op: row.op as 'insert' | 'update' | 'delete',
          sessionId: row.session_id as string,
          workspaceId: row.workspace_id as string,
          old: row.old_value as number | null,
          new: row.new_value as number | null,
          oldProvider: row.old_provider as string | null,
          newProvider: row.new_provider as string | null,
        }
      case 'workspace':
        return {
          seq,
          kind: 'workspace',
          workspaceId: row.workspace_id as string,
          old: row.old_value as number | null,
          new: row.new_value as number | null,
        }
      default:
        return { seq, kind: row.kind as 'start' | 'boot' }
    }
  })
}

// Every durable record the server publishes: who held its scope, who got it.
// A record the S13 seam drops shows as withheld: owed, open, not sent.
{
  const previous = server.sockets.deliver.bind(server.sockets)
  server.sockets.deliver = (item: Delivery) => {
    if (item.kind !== 'record') return previous(item)
    const record = item.record
    const key = keyOf(record.cursor.scope)
    const owed: WebSocket[] = []
    const pending: string[] = []
    for (const [ws, subscriptions] of granted) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if ([...subscriptions.values()].includes(key ?? '')) owed.push(ws)
    }
    for (const [ws, requests] of asked) {
      for (const request of requests.values()) {
        if (request.key === key && request.name !== 'subscription.unsubscribe') {
          pending.push(socketKey(ws))
        }
      }
    }
    const sent = new Set<WebSocket>()
    publishing = sent
    try {
      return previous(item)
    } finally {
      publishing = undefined
      deliver(undefined, {
        k: 'publish',
        key,
        seq: record.cursor.sequence,
        name: record.event.name,
        owed: owed.map(socketKey),
        pending,
        sent: [...sent].map(socketKey),
        // Owed, not handed over, and still open: the server's own loss. A
        // socket the send closed instead (slow_consumer) is not in it.
        withheld: owed
          .filter((ws) => !sent.has(ws) && ws.readyState === WebSocket.OPEN)
          .map(socketKey),
      })
    }
  }
}

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
  const thread = readThreadState(database(), { sessionId, threadId })
  if (!thread) throw new Error(`Thread ${threadId} is not in session ${sessionId}.`)
  return {
    turns: thread.turns,
    messages: thread.messages,
    reasoning: thread.reasoning,
    tools: thread.tools,
    order: thread.order,
    interactions: thread.interactions,
    listing: thread.listing,
  }
}

/** What the current `streamText` has handed the server so far (S15's achieved rate). */
let streamed = { bytes: 0, startedAt: 0 }

async function handle(request: ChildRequest): Promise<unknown> {
  switch (request.op) {
    case 'emitText':
      return update(await promptOf(request.sessionId), {
        sessionUpdate: 'agent_message_chunk',
        content: text(request.text),
      })
    case 'emitCommands':
      return update(await promptOf(request.sessionId), {
        sessionUpdate: 'available_commands_update',
        availableCommands: request.names.map((name) => ({ name, description: `Run ${name}` })),
      })
    case 'emitSetting':
      return update(await promptOf(request.sessionId), {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            type: 'select',
            id: request.settingId,
            name: request.settingId,
            currentValue: request.currentValue,
            options: [{ value: request.currentValue, name: request.currentValue }],
          },
        ],
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
      streamed = { bytes: 0, startedAt: performance.now() }
      while (performance.now() < end && activePrompts.get(active.providerSessionId) === active) {
        await update(active, { sessionUpdate: 'agent_message_chunk', content: text(chunk) })
        bytes += chunk.length
        streamed.bytes = bytes
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
    case 'readSessionThreads':
      return listThreadsForSession(database(), request.sessionId).map((thread) => thread.threadId)
    case 'readSessions': {
      // The server's own summary, `waitingOn` and `inBackground` included
      // (sessionRowToSummary → readSessionActivity), never re-derived here.
      return listAllSessionSummaries(database())
    }
    case 'readAudit':
      return readAudit()
    case 'readUnidentified':
      return (
        database()
          .prepare('SELECT session_id FROM sessions WHERE provider_session_id IS NULL')
          .all() as Array<{ session_id: string }>
      ).map((row) => row.session_id)
    case 'sampleSockets': {
      // What each connection's writer holds: queued (not yet written) and
      // in flight (written, not yet acknowledged), §7.2 (e).
      const flow = new Map(server.sockets.flowStats().map((stats) => [stats.ws, stats]))
      return [...sockets.entries()]
        .filter(([ws]) => ws.readyState === WebSocket.OPEN)
        .map(([ws, socket]): SocketSample => {
          const stats = flow.get(ws)
          return {
            socket,
            remotePort: remotePortOf(ws),
            readyState: ws.readyState,
            bufferedAmount: ws.bufferedAmount,
            queued: stats?.queued ?? 0,
            inFlight: stats?.inFlight ?? 0,
            window: stats?.window ?? 0,
            lagging: stats?.lagging.length ?? 0,
          }
        })
    }
    case 'readStreamed':
      return {
        bytes: streamed.bytes,
        elapsedMs: streamed.startedAt ? Math.round(performance.now() - streamed.startedAt) : 0,
      }
    case 'armKill':
      armedKill = request.at ? { ...request.at } : undefined
      return null
    case 'dropNextRecord':
      dropArmed = request.threadId
      return null
    case 'readDropped':
      return dropped
    case 'raiseReplayFloor': {
      const writer = new DatabaseSync(join(config.dataDir, DATABASE_FILENAME))
      writer
        .prepare('UPDATE event_streams SET replay_floor = head_sequence WHERE thread_id = ?')
        .run(request.threadId)
      writer.close()
      return null
    }
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
