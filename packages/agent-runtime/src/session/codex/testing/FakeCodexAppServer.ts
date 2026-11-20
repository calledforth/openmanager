import { PassThrough } from 'node:stream'
import type { InitializeParams, InitializeResponse, v2 } from '@openmanager/codex-app-server-protocol'
import type { TerminableChild } from '../../ChildProcessLifecycle.js'
import type {
  ClientMethod,
  ClientParams,
  ClientResult,
  CodexSpawnSpec,
  NotificationMethod,
  NotificationParams,
  ServerRequestMethod,
  ServerRequestParams,
} from '../CodexAppServerClient.js'
import { CodexRpcError, RPC_METHOD_NOT_FOUND, type RpcId } from '../CodexRpcPeer.js'
import { CODEX_RECOMMENDED_VERSION } from '../version.js'
import { buildThread, sandboxPolicy } from './builders.js'
import { FakeCodexThread, type FakeCodexTurn } from './FakeCodexThread.js'

/** `codex app-server` in-process, for tests of anything built on
 * `CodexAppServerClient`.
 *
 * It is a `TerminableChild`: the client writes to its stdin and reads its
 * stdout and stderr exactly as it would a spawned process, and stops it
 * through the same termination ladder. So a test exercises the real framing,
 * correlation and exit handling, and fakes only the one thing it cannot have,
 * a Codex process.
 *
 * A test scripts it from the server's side: answers per method, notifications
 * (directly or through `thread()` and its turns, which emit what Codex 0.170
 * really emits), server requests whose answers it can await, delays, errors and
 * crashes. Everything the client sends is kept in `received` for assertions.
 *
 * It refuses what Codex refuses: any request before `initialize` is answered
 * `-32600 Not initialized`, a second `initialize` `-32600 Already
 * initialized` (codex 0.170 accepts requests between the `initialize` answer
 * and the `initialized` notification, and so does this). A line from the
 * client that is not JSON fails the test run (`allowStrayLines` to keep it
 * quietly in `strayLines` instead).
 *
 * Exit follows a real child's order: `exit` fires first, the pipes close after
 * (unless `closePipesOnExit` is off, to play the late part of a stream by hand).
 *
 * Everything here exists only for tests. */

// ---------------------------------------------------------------------------
// Wire

/** JSON-RPC "invalid request": what Codex answers a request it will not take
 * (`Not initialized`, `thread not found: …`). */
const RPC_INVALID_REQUEST = -32600

export type WireError = { code: number; message: string; data?: unknown }

/** One JSON-RPC message as `codex app-server` frames it: no `jsonrpc` member,
 * a request has `id` and `method`, a notification only `method`, an answer
 * only `id` and `result` or `error`. */
export type WireMessage = {
  id?: RpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: WireError
}

export type WireRequest = { id: RpcId; method: string; params?: unknown }

export const isWireRequest = (m: WireMessage): m is WireRequest =>
  m.id !== undefined && typeof m.method === 'string'
export const isWireNotification = (m: WireMessage): m is { method: string; params?: unknown } =>
  m.id === undefined && typeof m.method === 'string'
export const isWireResponse = (m: WireMessage): m is { id: RpcId; result?: unknown; error?: WireError } =>
  m.id !== undefined && m.method === undefined

/** What a client sent for one method, typed by the generated protocol. */
export type FakeClientRequest<M extends ClientMethod = ClientMethod> = {
  id: RpcId
  method: M
  params: ClientParams<M>
}

/** Answers for the server requests openmanager answers. Like
 * `CodexResponses`, a hand-kept table: the generated protocol has a type per
 * response but nothing linking a method to it. */
export interface CodexServerRequestResults {
  'item/commandExecution/requestApproval': v2.CommandExecutionRequestApprovalResponse
  'item/fileChange/requestApproval': v2.FileChangeRequestApprovalResponse
  'item/permissions/requestApproval': v2.PermissionsRequestApprovalResponse
  'item/tool/requestUserInput': v2.ToolRequestUserInputResponse
  'mcpServer/elicitation/request': v2.McpServerElicitationRequestResponse
  'currentTime/read': v2.CurrentTimeReadResponse
}
export type ServerRequestResult<M extends ServerRequestMethod> = M extends keyof CodexServerRequestResults
  ? CodexServerRequestResults[M]
  : unknown

/** The client's answer to a server request. */
export type FakeServerAnswer<M extends ServerRequestMethod = ServerRequestMethod> = {
  id: RpcId
  result?: ServerRequestResult<M>
  error?: WireError
}

/** A server request on the wire, waiting for (or holding) the client's answer. */
export type FakeServerRequest<M extends ServerRequestMethod = ServerRequestMethod> = {
  id: RpcId
  method: M
  params: ServerRequestParams<M>
  /** Never settles if the client does not answer; rejects if the fake exits
   * first. */
  answered: Promise<FakeServerAnswer<M>>
}

// ---------------------------------------------------------------------------
// Scripting

/** How the fake answers one client method: a fixed result, or a function of
 * the request. Throw a `CodexRpcError` (or use `fail`) to answer with an
 * error; return a promise to answer later. */
export type Responder<M extends ClientMethod> =
  | ClientResult<M>
  | ((params: ClientParams<M>, request: FakeClientRequest<M>) => ClientResult<M> | Promise<ClientResult<M>>)

export type RespondOptions<M extends ClientMethod> = {
  /** Answer this many times, then fall back to what was scripted before (a
   * persistent responder, or the unscripted default). Default: every time. */
  times?: number
  /** Wait this long before answering. Uses `setTimeout`, so fake timers
   * control it. */
  delayMs?: number
  /** Runs right after the answer is written: what Codex sends next (the
   * `thread/started` that follows a `thread/start` answer, say). */
  after?: (request: FakeClientRequest<M>, result: ClientResult<M>) => void
}

type Scripted = {
  responder: Responder<ClientMethod>
  remaining: number
  delayMs: number
  after: ((request: FakeClientRequest, result: unknown) => void) | undefined
}

export type FakeCodexAppServerOptions = {
  pid?: number
  /** Codex version the handshake reports. Default: the pinned protocol's. */
  version?: string
  /** The whole `initialize.userAgent`, overriding `version`. Codex builds it
   * from the client's name: `<clientInfo.name>/<version> (<os>) …`. */
  userAgent?: string
  codexHome?: string
  platformFamily?: string
  platformOs?: string
  /** Answer `initialize` automatically. Off to script the handshake by hand
   * (`respond('initialize', …)`) or leave it unanswered. Default true. */
  initialize?: boolean
  /** Refuse requests before `initialize` (and a second `initialize`) as
   * Codex does. Off for a test that deliberately skips the handshake.
   * Default true. */
  requireHandshake?: boolean
  /** Keep client lines that are not JSON in `strayLines` without failing the
   * test. By default each one is thrown, asynchronously, so the run fails. */
  allowStrayLines?: boolean
  /** Ignore SIGTERM, so the termination ladder has to escalate. */
  ignoreSigterm?: boolean
  /** Close stdout and stderr after `exit`, as a real child does. Default true. */
  closePipesOnExit?: boolean
  /** First id for server requests. Codex numbers them from 0 in every
   * process, so two fakes collide on ids just as two real processes do. */
  firstServerRequestId?: number
  /** A request nothing is scripted for: answered `-32601` (`error`, the
   * default, what Codex does for a method it does not know) or never
   * answered (`ignore`). */
  unscripted?: 'error' | 'ignore'
}

export class FakeCodexAppServer implements TerminableChild {
  readonly pid: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  /** Everything the client sent, parsed, in order. */
  readonly received: WireMessage[] = []
  /** Everything this fake wrote to stdout, in order. */
  readonly sent: WireMessage[] = []
  /** Signals `kill` was called with, in order. */
  readonly signals: NodeJS.Signals[] = []
  /** Answers to server requests this fake never sent, or answered twice. */
  readonly strayAnswers: WireMessage[] = []
  /** Requests answered `-32601` (or ignored) because nothing was scripted. */
  readonly unscripted: WireRequest[] = []
  /** Lines from the client that were not JSON. */
  readonly strayLines: string[] = []

  ignoreSigterm: boolean
  closePipesOnExit: boolean

  private readonly options: FakeCodexAppServerOptions
  private readonly scripts = new Map<string, Scripted[]>()
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  private readonly pending = new Map<
    string,
    { method: string; resolve: (answer: WireMessage) => void; reject: (error: Error) => void }
  >()
  private readonly waiters = new Set<(message: WireMessage) => boolean>()
  private readonly claimed = new Set<WireMessage>()
  private nextServerRequestId: number
  private initializeReceived = false

  constructor(options: FakeCodexAppServerOptions = {}) {
    this.options = options
    this.pid = options.pid ?? 4242
    this.ignoreSigterm = options.ignoreSigterm ?? false
    this.closePipesOnExit = options.closePipesOnExit ?? true
    this.nextServerRequestId = options.firstServerRequestId ?? 0

    let buffered = ''
    this.stdin.on('data', (chunk: Buffer) => {
      buffered += String(chunk)
      for (let nl = buffered.indexOf('\n'); nl !== -1; nl = buffered.indexOf('\n')) {
        const line = buffered.slice(0, nl)
        buffered = buffered.slice(nl + 1)
        if (line.trim()) this.receiveLine(line)
      }
    })
  }

  get exited(): boolean {
    return this.exitCode !== null || this.signalCode !== null
  }

  // ------------------------------------------------------------- scripting

  /** Script the answer to client requests of `method`. A later `respond` for
   * the same method is used first, so a test can override a default for a
   * number of calls (`times`) and fall back afterwards. */
  respond<M extends ClientMethod>(method: M, responder: Responder<M>, options: RespondOptions<M> = {}): this {
    const list = this.scripts.get(method) ?? []
    list.unshift({
      responder: responder as Responder<ClientMethod>,
      remaining: options.times ?? Number.POSITIVE_INFINITY,
      delayMs: options.delayMs ?? 0,
      after: options.after as Scripted['after'],
    })
    this.scripts.set(method, list)
    return this
  }

  /** Answer `method` with an error. */
  fail(method: ClientMethod, code: number, message: string, options: { times?: number; data?: unknown } = {}): this {
    return this.respond(
      method,
      () => {
        throw new CodexRpcError(code, message, options.data)
      },
      options.times !== undefined ? { times: options.times } : {},
    )
  }

  /** A thread this fake can speak for. Nothing is sent until its methods are
   * called; `parentThreadId` makes it a subagent's thread. */
  thread(overrides: Partial<v2.Thread> = {}): FakeCodexThread {
    return new FakeCodexThread(this, buildThread(overrides))
  }

  /** Answer every `thread/start` with a new thread and every `turn/start`
   * on one of those threads with a new turn, announcing each the way Codex
   * does (`thread/started`; `thread/status/changed` and `turn/started`). A
   * `turn/start` for any other thread is refused as Codex refuses it (`-32600
   * thread not found`). What happens in the turn is
   * the test's to script: `onTurn` gets each one as it starts. Enough for code
   * that only needs a session to come up.
   *
   * `turn/steer` is answered as Codex 0.170 answers it (probed): the running
   * turn takes the input and echoes it at once as a `userMessage` carrying
   * the `clientUserMessageId`; a turn id that is not the running one, or no
   * running turn, is `-32600` with Codex's own words. */
  serveThreads(onTurn?: (turn: FakeCodexTurn) => void): this {
    const threads = new Map<string, FakeCodexThread>()
    const turns = new Map<string, FakeCodexTurn>()
    this.respond(
      'thread/start',
      (params) => {
        const thread = this.thread({
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.model ? { model: params.model } : {}),
          ephemeral: params.ephemeral ?? false,
        })
        threads.set(thread.id, thread)
        return thread.startResponse({
          ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
          sandbox: sandboxPolicy(params.sandbox),
        })
      },
      { after: (_request, result) => threads.get(result.thread.id)?.started() },
    )
    this.respond(
      'turn/start',
      (params) => {
        const thread = threads.get(params.threadId)
        // What codex 0.170 answers for a thread it has not started or resumed.
        if (!thread) throw new CodexRpcError(RPC_INVALID_REQUEST, `thread not found: ${params.threadId}`)
        const turn = thread.turn()
        turns.set(turn.id, turn)
        return turn.startResponse()
      },
      {
        after: (_request, result) => {
          const turn = turns.get(result.turn.id)
          if (!turn) return
          turn.started()
          onTurn?.(turn)
        },
      },
    )
    this.respond(
      'turn/steer',
      (params) => {
        const running = [...turns.values()].find(
          (turn) => turn.threadId === params.threadId && turn.turn.status === 'inProgress',
        )
        if (!running) throw new CodexRpcError(-32600, 'no active turn to steer')
        if (running.id !== params.expectedTurnId)
          throw new CodexRpcError(
            -32600,
            `expected active turn id \`${params.expectedTurnId}\` but found \`${running.id}\``,
          )
        return { turnId: running.id }
      },
      {
        after: (request, result) =>
          turns.get(result.turnId)?.userMessage(request.params.input, {
            clientId: request.params.clientUserMessageId ?? null,
          }),
      },
    )
    return this
  }

  // ------------------------------------------------------------- emitting

  /** Write one message to stdout. Dropped once the pipes are closed. */
  send(message: WireMessage): void {
    if (this.stdout.writableEnded) return
    this.sent.push(message)
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  /** Write a raw line (malformed JSON, an oversize line, half a message). */
  writeLine(line: string): void {
    if (this.stdout.writableEnded) return
    this.stdout.write(line)
  }

  notify<M extends NotificationMethod>(method: M, params: NotificationParams<M>): void {
    this.send({ method, params })
  }

  /** Send a server request. Ids count up from `firstServerRequestId` unless
   * one is given. */
  request<M extends ServerRequestMethod>(
    method: M,
    params: ServerRequestParams<M>,
    options: { id?: RpcId } = {},
  ): FakeServerRequest<M> {
    const id = options.id ?? this.nextServerRequestId++
    const answered = new Promise<FakeServerAnswer<M>>((resolve, reject) => {
      this.pending.set(String(id), {
        method,
        resolve: (answer) => resolve(answer as FakeServerAnswer<M>),
        reject,
      })
    })
    // Rejected on exit; a test that never awaits the answer must not see that
    // as an unhandled rejection.
    answered.catch(() => undefined)
    this.send({ id, method, params })
    return { id, method, params, answered }
  }

  /** `serverRequest/resolved`: Codex no longer wants an answer to `id` (it was
   * answered, or the turn ended). */
  resolved(threadId: string, requestId: RpcId): void {
    this.notify('serverRequest/resolved', { threadId, requestId })
  }

  writeStderr(text: string): void {
    if (this.stderr.writableEnded) return
    this.stderr.write(text)
  }

  // ------------------------------------------------------------- waiting

  /** Requests the client sent, optionally of one method. */
  requests<M extends ClientMethod>(method?: M): FakeClientRequest<M>[] {
    return this.received.filter(
      (m) => isWireRequest(m) && (method === undefined || m.method === method),
    ) as FakeClientRequest<M>[]
  }

  /** Notifications the client sent (`initialized`). */
  notifications(method?: string): WireMessage[] {
    return this.received.filter((m) => isWireNotification(m) && (method === undefined || m.method === method))
  }

  /** The client's answer to server request `id`, if it has answered. */
  answerTo(id: RpcId): WireMessage | undefined {
    return this.received.find((m) => isWireResponse(m) && m.id === id)
  }

  /** The first message from the client, already received or still to come,
   * that matches. */
  waitFor(predicate: (message: WireMessage) => boolean): Promise<WireMessage> {
    const found = this.received.find(predicate)
    if (found) return Promise.resolve(found)
    return new Promise((resolve) => {
      const waiter = (message: WireMessage): boolean => {
        if (!predicate(message)) return false
        resolve(message)
        return true
      }
      this.waiters.add(waiter)
    })
  }

  /** The next request of `method` that no earlier `nextRequest` returned. */
  async nextRequest<M extends ClientMethod>(method: M): Promise<FakeClientRequest<M>> {
    // Claimed in the predicate, so two callers waiting at once get two
    // different requests.
    const message = await this.waitFor((m) => {
      if (!isWireRequest(m) || m.method !== method || this.claimed.has(m)) return false
      this.claimed.add(m)
      return true
    })
    return message as FakeClientRequest<M>
  }

  // ------------------------------------------------------------- process

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (signal === 'SIGTERM' && this.ignoreSigterm) return true
    this.settleExit(signal, null)
    return true
  }

  /** Exit cleanly, or with `code`. */
  exit(code = 0): void {
    this.settleExit(null, code)
  }

  /** Die the way a broken Codex does: stderr first (a panic, an error log),
   * then the exit. Default: exit code 1. */
  crash(options: { code?: number; signal?: NodeJS.Signals; stderr?: string } = {}): void {
    if (options.stderr) this.writeStderr(options.stderr.endsWith('\n') ? options.stderr : `${options.stderr}\n`)
    this.settleExit(options.signal ?? null, options.signal ? null : (options.code ?? 1))
  }

  /** End stdout and stderr by hand (after `closePipesOnExit = false`). */
  closePipes(): void {
    this.stdout.end()
    this.stderr.end()
  }

  on(_event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this {
    this.exitListeners.push(listener)
    return this
  }

  private settleExit(signal: NodeJS.Signals | null, code: number | null): void {
    if (this.exited) return
    this.signalCode = signal
    this.exitCode = code
    for (const listener of this.exitListeners) listener(code, signal)
    // A dead process asks nothing more: its questions go unanswered.
    for (const [id, { method, reject }] of this.pending)
      reject(new Error(`fake codex app-server exited before the client answered ${method} (id ${id})`))
    this.pending.clear()
    this.onExit()
    if (this.closePipesOnExit) this.closePipes()
  }

  /** Runs once the process has exited, before the pipes close. */
  protected onExit(): void {}

  // ------------------------------------------------------------- receiving

  private receiveLine(line: string): void {
    let message: WireMessage
    try {
      message = JSON.parse(line) as WireMessage
    } catch {
      // The client only ever writes JSON. Thrown outside the client's write
      // call, so the test run fails without the client seeing an error.
      this.strayLines.push(line)
      if (!this.options.allowStrayLines)
        queueMicrotask(() => {
          throw new Error(`fake codex app-server: the client wrote a line that is not JSON: ${line}`)
        })
      return
    }
    this.received.push(message)
    for (const waiter of this.waiters) if (waiter(message)) this.waiters.delete(waiter)
    // A dead process reads nothing more.
    if (this.exited) return
    this.onClientMessage(message)
  }

  /** What the server does with one message from the client. The replay
   * harness replaces this; the scripted fake dispatches to `respond`. */
  protected onClientMessage(message: WireMessage): void {
    if (isWireResponse(message)) {
      const key = String(message.id)
      const pending = this.pending.get(key)
      if (!pending) {
        this.strayAnswers.push(message)
        return
      }
      this.pending.delete(key)
      pending.resolve(message)
      return
    }
    if (isWireRequest(message)) void this.answer(message)
  }

  /** Whether this fake sent server request `id` and still waits for its
   * answer. */
  protected awaitsAnswer(id: RpcId): boolean {
    return this.pending.has(String(id))
  }

  /** Whether a `respond` script would answer the next request of `method`. */
  protected hasScript(method: string): boolean {
    return this.scripts.get(method)?.some((entry) => entry.remaining > 0) ?? false
  }

  private async answer(request: WireRequest): Promise<void> {
    if (this.options.requireHandshake !== false) {
      const refusal =
        request.method === 'initialize'
          ? this.initializeReceived
            ? 'Already initialized'
            : undefined
          : this.initializeReceived
            ? undefined
            : 'Not initialized'
      if (request.method === 'initialize') this.initializeReceived = true
      if (refusal) {
        this.send({ id: request.id, error: { code: RPC_INVALID_REQUEST, message: refusal } })
        return
      }
    }
    const scripted = this.takeScript(request.method)
    if (!scripted) {
      if (request.method === 'initialize' && this.options.initialize !== false) {
        this.send({ id: request.id, result: this.initializeResult(request.params as InitializeParams) })
        return
      }
      this.unscripted.push(request)
      if (this.options.unscripted === 'ignore') return
      this.send({
        id: request.id,
        error: { code: RPC_METHOD_NOT_FOUND, message: `fake codex app-server: nothing scripted for ${request.method}` },
      })
      return
    }
    const typed = { ...request, params: request.params } as FakeClientRequest
    let result: unknown
    try {
      if (scripted.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, scripted.delayMs))
      const { responder } = scripted
      result =
        typeof responder === 'function'
          ? await (responder as (params: unknown, request: FakeClientRequest) => unknown)(typed.params, typed)
          : responder
      this.send({ id: request.id, result: result ?? {} })
    } catch (error) {
      const rpc = error instanceof CodexRpcError ? error : undefined
      this.send({
        id: request.id,
        error: {
          code: rpc?.code ?? -32603,
          message: error instanceof Error ? error.message : String(error),
          ...(rpc?.data !== undefined ? { data: rpc.data } : {}),
        },
      })
      return
    }
    scripted.after?.(typed, result ?? {})
  }

  private takeScript(method: string): Scripted | undefined {
    const list = this.scripts.get(method)
    if (!list) return undefined
    const index = list.findIndex((entry) => entry.remaining > 0)
    if (index === -1) return undefined
    const entry = list[index]!
    entry.remaining--
    return entry
  }

  private initializeResult(params: InitializeParams | undefined): InitializeResponse {
    const name = params?.clientInfo?.name ?? 'OpenManager'
    const version = this.options.version ?? CODEX_RECOMMENDED_VERSION
    return {
      userAgent:
        this.options.userAgent ??
        `${name}/${version} (Fake OS; x86_64) fake (${name}; ${params?.clientInfo?.version ?? '0.0.0'})`,
      codexHome: this.options.codexHome ?? '/home/user/.codex',
      platformFamily: this.options.platformFamily ?? 'unix',
      platformOs: this.options.platformOs ?? 'linux',
    }
  }
}

/** Hands out fake app-servers where production code would spawn one.
 *
 * `spawn` has the shape of `spawnCodexAppServer` (a spec in, a running child
 * out), so a session runtime, the service process or the boot probe that takes
 * its spawner as a dependency can be given `factory.spawn` and every process
 * it starts is a fake the test can reach through `servers` / `last`. `setup`
 * scripts each one before the client sees it. */
export class FakeCodexAppServerFactory {
  readonly servers: FakeCodexAppServer[] = []
  readonly specs: CodexSpawnSpec[] = []
  /** Set to make the next `spawn` reject: a missing or unstartable binary. */
  failWith: Error | undefined

  constructor(
    private readonly setup: (server: FakeCodexAppServer, spec: CodexSpawnSpec | undefined) => FakeCodexAppServer | void = () => undefined,
    private readonly options: FakeCodexAppServerOptions = {},
  ) {}

  /** Bound, so it can be passed around on its own. */
  readonly spawn = async (spec?: CodexSpawnSpec): Promise<FakeCodexAppServer> => {
    if (this.failWith) {
      const error = this.failWith
      this.failWith = undefined
      throw error
    }
    if (spec) this.specs.push(spec)
    const created = new FakeCodexAppServer({ pid: 4242 + this.servers.length, ...this.options })
    const server = this.setup(created, spec) ?? created
    this.servers.push(server)
    return server
  }

  get last(): FakeCodexAppServer {
    const server = this.servers.at(-1)
    if (!server) throw new Error('no fake codex app-server has been spawned yet')
    return server
  }
}
