import { SERVER_NOTIFICATION_METHODS, SERVER_REQUEST_METHODS } from '@openmanager/codex-app-server-protocol'
import type { HostDeps } from '../../host.js'
import { LineDecoder } from './ndjson.js'

/** A JSON-RPC id as `codex app-server` sends it: either kind is legal, and a
 * server request's id is echoed back exactly as received. */
export type RpcId = string | number

/** An error the other side answered with, or one this side answers with. */
export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    /** The method the failed request was for, when this side sent it. */
    readonly method?: string,
  ) {
    super(message)
    this.name = 'CodexRpcError'
  }
}

/** A request the server never answered in time. The request is forgotten, so
 * a late answer is dropped and counted rather than resolving something
 * nobody is waiting for any more. */
export class CodexRpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`codex app-server did not answer ${method} within ${timeoutMs}ms`)
    this.name = 'CodexRpcTimeoutError'
  }
}

/** The connection is gone: every request still waiting is rejected with
 * this (or with the `cause` given to `close`). */
export class CodexConnectionClosedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CodexConnectionClosedError'
  }
}

/** JSON-RPC's own codes, the ones this peer sends. */
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INTERNAL_ERROR = -32603

export type ServerRequestContext = {
  id: RpcId
  /** Aborted when this request no longer needs an answer: the connection
   * closed, or the server withdrew it (`cancelServerRequest`). The handler
   * should stop waiting (an approval card, say) and let its promise settle;
   * whatever it then returns is not sent. */
  signal: AbortSignal
}

/** Answers one server request. Return the `result`; throw a `CodexRpcError`
 * to answer with that code, anything else to answer `-32603`. */
export type ServerRequestHandler = (params: unknown, context: ServerRequestContext) => unknown

export type ServerRequestHandlerOptions = {
  /** Run outside the concurrency cap. For handlers that answer at once
   * (`currentTime/read`, the refusals), which must never wait behind
   * approvals a person has not answered yet. */
  immediate?: boolean
}

export type ServerNotificationMessage = { method: string; params: unknown }

export type CodexRpcStats = {
  /** Lines that were not JSON, or JSON that was no JSON-RPC message. */
  decodeErrors: number
  /** Lines over the size cap, discarded unread. */
  oversizeLines: number
  /** Answers to requests nobody is waiting for: timed out, or never sent. */
  lateResponses: number
  /** Notifications this protocol version does not know, by method. */
  unknownNotifications: Map<string, number>
  /** Server requests nobody handles, by method. Each was answered `-32601`. */
  unhandledServerRequests: Map<string, number>
  /** Item types the session layer did not recognise, by type. The peer never
   * looks inside items; `countUnknownItem` is how the layer above records
   * them in the same place. */
  unknownItems: Map<string, number>
}

/** The most distinct names one counter keeps; the rest share `OTHER_KEY`.
 * Names come off the wire, so without a bound a misbehaving server could
 * grow the maps for as long as the connection lives. */
export const STATS_KEY_LIMIT = 100
export const OTHER_KEY = '(other)'

export type CodexRpcPeerOptions = {
  /** Writes one serialised message. The caller frames it (adds the newline). */
  write: (line: string) => void
  log: HostDeps['log']
  /** Requests without a timeout of their own get this one. `0` means none —
   * the right setting for `turn/start`, which only returns early, but never
   * for a request whose answer is the result. */
  defaultRequestTimeoutMs: number
  /** How many server requests may be handled at once. More queue in arrival
   * order. Approvals park for as long as a person takes to answer; the cap is
   * what stops a runaway agent from opening unbounded handlers. */
  maxConcurrentServerRequests?: number
  /** Default 64 MiB of text. */
  maxLineChars?: number
}

type Pending = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout | undefined
  cleanup: (() => void) | undefined
}

type Registered = { handler: ServerRequestHandler; immediate: boolean }

type ServerRequestJob = {
  id: RpcId
  method: string
  params: unknown
  handler: ServerRequestHandler
  controller: AbortController
}

const KNOWN_NOTIFICATIONS: ReadonlySet<string> = new Set(SERVER_NOTIFICATION_METHODS)
const KNOWN_SERVER_REQUESTS: ReadonlySet<string> = new Set(SERVER_REQUEST_METHODS)

/** JSON-RPC as `codex app-server` speaks it: one JSON object per line, and no
 * `jsonrpc` member on anything.
 *
 * Knows framing and correlation and nothing about Codex itself. Decoding is
 * tolerant by design (docs/decisions/codex-app-server.md, "Protocol types"):
 * the surface changes weekly, so something unrecognised is counted and
 * dropped, and nothing that arrives on the pipe can fail the connection. Only
 * `close` does that. */
export class CodexRpcPeer {
  readonly stats: CodexRpcStats = {
    decodeErrors: 0,
    oversizeLines: 0,
    lateResponses: 0,
    unknownNotifications: new Map(),
    unhandledServerRequests: new Map(),
    unknownItems: new Map(),
  }

  private nextId = 1
  private readonly pending = new Map<string, Pending>()
  private readonly handlers = new Map<string, Registered>()
  private readonly notificationListeners = new Set<(message: ServerNotificationMessage) => void>()
  private readonly queue: ServerRequestJob[] = []
  /** Server requests whose handler is running, by `String(id)`. */
  private readonly running = new Map<string, ServerRequestJob>()
  /** How many of `running` count against the cap (immediate ones do not). */
  private capped = 0
  private readonly maxConcurrent: number
  private readonly lines: LineDecoder
  private closedWith: Error | undefined

  constructor(private readonly options: CodexRpcPeerOptions) {
    this.maxConcurrent = Math.max(1, options.maxConcurrentServerRequests ?? 8)
    this.lines = new LineDecoder((line) => this.receive(line), {
      maxLineChars: options.maxLineChars ?? 64 * 1024 * 1024,
      onOversize: (chars, head) => this.oversize(chars, head),
    })
  }

  get closed(): boolean {
    return this.closedWith !== undefined
  }

  /** Bytes from the server's stdout, in order. */
  feed(chunk: Buffer | string): void {
    if (this.closed) return
    this.lines.push(chunk)
  }

  /** The server's stdout ended: deliver a final unterminated line, if any. */
  endOfInput(): void {
    if (this.closed) return
    this.lines.end()
  }

  /** Send a request and wait for its answer. Rejects with `CodexRpcError` for
   * an error answer, `CodexRpcTimeoutError` when none arrives in time, the
   * signal's reason when aborted, the serialisation error when `params`
   * cannot be sent, and the close reason when the connection goes first. */
  request(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.closedWith) return Promise.reject(this.closedWith)
    const signal = options.signal
    if (signal?.aborted) return Promise.reject(signal.reason)
    const id = this.nextId++
    let line: string
    try {
      line = JSON.stringify(params === undefined ? { id, method } : { id, method, params })
    } catch (error) {
      // The caller's own params (a BigInt, a cycle). Nothing was sent, so
      // nothing will ever answer: fail now rather than wait out a timeout.
      return Promise.reject(error)
    }
    const key = String(id)
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.options.defaultRequestTimeoutMs
      const entry: Pending = { method, resolve, reject, timer: undefined, cleanup: undefined }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.forget(key)
          reject(new CodexRpcTimeoutError(method, timeoutMs))
        }, timeoutMs)
        entry.timer.unref?.()
      }
      if (signal) {
        const onAbort = (): void => {
          this.forget(key)
          reject(signal.reason)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        entry.cleanup = () => signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(key, entry)
      this.write(line)
    })
  }

  /** Send a notification. Silently dropped once closed: there is nobody to
   * tell, and the caller learns of the close from `exited`. Throws if
   * `params` cannot be serialised, which is the caller's bug. */
  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.write(JSON.stringify(params === undefined ? { method } : { method, params }))
  }

  /** Answer server requests for `method`. One handler per method; a second
   * registration replaces the first. Returns an unregister. */
  handle(
    method: string,
    handler: ServerRequestHandler,
    options: ServerRequestHandlerOptions = {},
  ): () => void {
    const registered: Registered = { handler, immediate: options.immediate === true }
    this.handlers.set(method, registered)
    return () => {
      if (this.handlers.get(method) === registered) this.handlers.delete(method)
    }
  }

  /** The server no longer wants an answer to request `id` (it sent
   * `serverRequest/resolved`: the turn was interrupted, or another client
   * answered). A queued request is dropped before its handler ever runs; a
   * running one has its signal aborted and its eventual result discarded.
   * Returns whether the id was known. */
  cancelServerRequest(id: RpcId): boolean {
    const key = String(id)
    const index = this.queue.findIndex((job) => String(job.id) === key)
    if (index !== -1) {
      this.queue.splice(index, 1)
      return true
    }
    const job = this.running.get(key)
    if (!job) return false
    job.controller.abort(new CodexConnectionClosedError('codex withdrew the request'))
    return true
  }

  /** Every notification this protocol version knows, in arrival order.
   * Listeners run synchronously; one that throws is logged and the rest still
   * run, so a bug in one consumer cannot reorder or drop events for another. */
  onNotification(listener: (message: ServerNotificationMessage) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  /** Record an item type the layer above did not recognise. */
  countUnknownItem(type: string): void {
    bump(this.stats.unknownItems, type)
  }

  /** Reject everything waiting, abort running handlers, and drop queued
   * server requests (there is no pipe left to answer them on). Idempotent;
   * the first reason wins. */
  close(reason: Error): void {
    if (this.closedWith) return
    this.closedWith = reason
    for (const [key, entry] of this.pending) {
      this.pending.delete(key)
      if (entry.timer) clearTimeout(entry.timer)
      entry.cleanup?.()
      entry.reject(reason)
    }
    this.queue.length = 0
    for (const job of this.running.values()) job.controller.abort(reason)
  }

  private receive(line: string): void {
    // A listener may close the peer part-way through a chunk; the lines after
    // that are for nobody.
    if (this.closed) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.decodeError('Line from codex app-server is not JSON', line)
      return
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.decodeError('Message from codex app-server is not an object', line)
      return
    }
    const record = message as Record<string, unknown>
    const method = typeof record.method === 'string' ? record.method : undefined
    const id = isRpcId(record.id) ? record.id : undefined

    if (method !== undefined && id !== undefined) this.serverRequest(id, method, record.params)
    else if (method !== undefined) this.notification(method, record.params)
    else if (id !== undefined && ('result' in record || 'error' in record))
      this.response(id, record)
    else this.decodeError('Message from codex app-server is no JSON-RPC message', line)
  }

  /** A line too big to hold. Its start says whose it was, so whoever is
   * waiting on it is told rather than left hanging: a server request is
   * refused, and a caller awaiting a response is rejected. */
  private oversize(chars: number, head: string): void {
    this.stats.oversizeLines++
    const { id: parsedId, method } = topLevelFields(head)
    this.warn('Discarded an oversize line from codex app-server', { chars, id: parsedId, method })
    if (parsedId === undefined) return
    const message = `Message too large for OpenManager (${chars} characters)`
    if (method !== undefined) {
      this.answerError(parsedId, RPC_INTERNAL_ERROR, message)
      return
    }
    const key = String(parsedId)
    const entry = this.pending.get(key)
    if (!entry) return
    this.forget(key)
    entry.reject(new CodexRpcError(RPC_INTERNAL_ERROR, message, undefined, entry.method))
  }

  private response(id: RpcId, record: Record<string, unknown>): void {
    const key = String(id)
    const entry = this.pending.get(key)
    if (!entry) {
      this.stats.lateResponses++
      this.options.log({
        scope: 'codex',
        level: 'info',
        message: 'Dropped an answer to a request nobody is waiting for',
        data: { id },
      })
      return
    }
    this.forget(key)
    if ('error' in record && record.error !== undefined && record.error !== null) {
      const error = record.error as { code?: unknown; message?: unknown; data?: unknown }
      entry.reject(
        new CodexRpcError(
          typeof error.code === 'number' ? error.code : RPC_INTERNAL_ERROR,
          typeof error.message === 'string' ? error.message : 'codex app-server returned an error',
          error.data,
          entry.method,
        ),
      )
      return
    }
    entry.resolve(record.result)
  }

  private notification(method: string, params: unknown): void {
    if (!KNOWN_NOTIFICATIONS.has(method)) {
      if (bump(this.stats.unknownNotifications, method) === 1)
        this.options.log({
          scope: 'codex',
          level: 'info',
          message: 'Ignoring a notification this protocol version does not know',
          data: { method },
        })
      return
    }
    for (const listener of this.notificationListeners) {
      try {
        listener({ method, params })
      } catch (error) {
        this.options.log({
          scope: 'codex',
          level: 'error',
          message: 'A codex notification listener threw',
          data: { method, error: String(error) },
        })
      }
    }
  }

  private serverRequest(id: RpcId, method: string, params: unknown): void {
    const registered = this.handlers.get(method)
    if (!registered) {
      // Answered at once, never queued behind the cap: a request nobody
      // handles must not wait for approvals to drain before it is refused.
      bump(this.stats.unhandledServerRequests, method)
      this.options.log({
        scope: 'codex',
        level: KNOWN_SERVER_REQUESTS.has(method) ? 'info' : 'warn',
        message: 'Refused a codex server request nobody handles',
        data: { method },
      })
      this.answerError(id, RPC_METHOD_NOT_FOUND, `OpenManager does not handle ${method}`)
      return
    }
    const job: ServerRequestJob = {
      id,
      method,
      params,
      handler: registered.handler,
      controller: new AbortController(),
    }
    if (registered.immediate) {
      this.start(job, false)
      return
    }
    this.queue.push(job)
    this.drain()
  }

  private drain(): void {
    while (!this.closed && this.capped < this.maxConcurrent && this.queue.length > 0)
      this.start(this.queue.shift()!, true)
  }

  private start(job: ServerRequestJob, counted: boolean): void {
    const key = String(job.id)
    this.running.set(key, job)
    if (counted) this.capped++
    void this.run(job).finally(() => {
      if (this.running.get(key) === job) this.running.delete(key)
      if (counted) {
        this.capped--
        this.drain()
      }
    })
  }

  private async run({ id, method, params, handler, controller }: ServerRequestJob): Promise<void> {
    const answered = (): boolean => this.closed || controller.signal.aborted
    try {
      const result = await handler(params, { id, signal: controller.signal })
      if (answered()) return
      let line: string
      try {
        line = JSON.stringify({ id, result: result ?? null })
      } catch (error) {
        // The server is waiting on this id; an answer it cannot use still
        // beats none at all.
        this.options.log({
          scope: 'codex',
          level: 'error',
          message: 'A codex server request handler returned a result that cannot be sent',
          data: { method, error: String(error) },
        })
        this.answerError(id, RPC_INTERNAL_ERROR, `OpenManager failed to answer ${method}`)
        return
      }
      this.write(line)
    } catch (error) {
      if (answered()) return
      if (error instanceof CodexRpcError) {
        this.answerError(id, error.code, error.message, error.data)
        return
      }
      this.options.log({
        scope: 'codex',
        level: 'error',
        message: 'A codex server request handler threw',
        data: { method, error: String(error) },
      })
      this.answerError(id, RPC_INTERNAL_ERROR, `OpenManager failed to handle ${method}`)
    }
  }

  private answerError(id: RpcId, code: number, message: string, data?: unknown): void {
    const error = data === undefined ? { code, message } : { code, message, data }
    let line: string
    try {
      line = JSON.stringify({ id, error })
    } catch {
      line = JSON.stringify({ id, error: { code, message } })
    }
    this.write(line)
  }

  private forget(key: string): void {
    const entry = this.pending.get(key)
    if (!entry) return
    this.pending.delete(key)
    if (entry.timer) clearTimeout(entry.timer)
    entry.cleanup?.()
  }

  private write(line: string): void {
    try {
      this.options.write(line)
    } catch (error) {
      // A dead pipe. The process exit closes the peer with the real reason;
      // until then the write is simply lost.
      this.warn('Could not write to codex app-server', { error: String(error) })
    }
  }

  private decodeError(message: string, line: string): void {
    this.stats.decodeErrors++
    this.warn(message, { line: line.length > 500 ? `${line.slice(0, 500)}…` : line })
  }

  private warn(message: string, data: unknown): void {
    this.options.log({ scope: 'codex', level: 'warn', message, data })
  }
}

/** `id` and `method` from the *top level* of a JSON object that may be cut
 * off part-way. A nested `"id"` (an item's own id inside a notification) or a
 * `"method"` key inside a result must not be mistaken for the envelope's, or
 * a notification gets an error answer the server never asked for and a
 * response is taken for a request. Scans only up to the first nested value
 * whose key is `params`, `result` or `error`, since Codex writes the envelope
 * fields first; anything later is unreadable in a truncated head anyway. */
export function topLevelFields(head: string): { id?: RpcId; method?: string } {
  const found: { id?: RpcId; method?: string } = {}
  let depth = 0
  let i = 0
  let expectKey = false
  let key: string | undefined
  const readString = (): string | undefined => {
    let end = i + 1
    while (end < head.length) {
      const char = head[end]
      if (char === '\\') end += 2
      else if (char === '"') break
      else end++
    }
    if (end >= head.length) return undefined
    const raw = head.slice(i, end + 1)
    i = end + 1
    try {
      return JSON.parse(raw) as string
    } catch {
      return undefined
    }
  }
  while (i < head.length) {
    const char = head[i]!
    if (char === '"') {
      const text = readString()
      if (text === undefined) break
      if (depth === 1 && expectKey) {
        key = text
        expectKey = false
      } else if (depth === 1 && key !== undefined) {
        if (key === 'id') found.id = text
        else if (key === 'method') found.method = text
        key = undefined
      }
      continue
    }
    if (char === '{' || char === '[') {
      if (depth === 1 && key !== undefined && ['params', 'result', 'error'].includes(key)) break
      depth++
      if (depth === 1) expectKey = true
      key = depth === 1 ? undefined : key
    } else if (char === '}' || char === ']') {
      depth--
    } else if (char === ',' && depth === 1) {
      expectKey = true
      key = undefined
    } else if (depth === 1 && key !== undefined && /[-\d]/.test(char)) {
      const number = /^-?\d+/.exec(head.slice(i))?.[0]
      if (number !== undefined) {
        if (key === 'id') found.id = Number(number)
        i += number.length
        key = undefined
        continue
      }
    }
    i++
  }
  return found
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

/** Count one more `key`, folding names past `STATS_KEY_LIMIT` into
 * `OTHER_KEY`. Returns the new count for the bucket counted. */
function bump(counts: Map<string, number>, key: string): number {
  const bucket = counts.has(key) || counts.size < STATS_KEY_LIMIT ? key : OTHER_KEY
  const next = (counts.get(bucket) ?? 0) + 1
  counts.set(bucket, next)
  return next
}
