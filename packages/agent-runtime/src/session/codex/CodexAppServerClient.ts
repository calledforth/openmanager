import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  ClientRequest,
  InitializeParams,
  InitializeResponse,
  ServerNotification,
  ServerRequest,
  v2,
} from '@openmanager/codex-app-server-protocol'
import type { HostDeps } from '../../host.js'
import {
  ChildProcessLifecycle,
  spawned,
  treeKiller,
  type TerminableChild,
} from '../ChildProcessLifecycle.js'
import type { ProcessExit, TerminationRequest } from '../lifecycle.js'
import {
  CodexConnectionClosedError,
  CodexRpcError,
  CodexRpcPeer,
  RPC_METHOD_NOT_FOUND,
  type CodexRpcStats,
  type RpcId,
  type ServerRequestContext,
  type ServerRequestHandlerOptions,
} from './CodexRpcPeer.js'
import type { CodexExecutable } from './executable.js'
import { LineDecoder } from './ndjson.js'
import { checkCodexVersion, CODEX_MIN_VERSION, type CodexVersionCheck } from './version.js'

// ---------------------------------------------------------------------------
// Typing over the generated unions

export type ClientMethod = ClientRequest['method']
export type ClientParams<M extends ClientMethod> = Extract<ClientRequest, { method: M }>['params']

/** Answers for the methods openmanager calls. The generated protocol has a
 * type per response but no method-to-response map, so this is the one
 * hand-kept table; a method missing from it answers `unknown`. */
export interface CodexResponses {
  initialize: InitializeResponse
  'thread/start': v2.ThreadStartResponse
  'thread/resume': v2.ThreadResumeResponse
  'thread/archive': v2.ThreadArchiveResponse
  'thread/unarchive': v2.ThreadUnarchiveResponse
  'thread/name/set': v2.ThreadSetNameResponse
  'thread/settings/update': v2.ThreadSettingsUpdateResponse
  'turn/start': v2.TurnStartResponse
  'turn/steer': v2.TurnSteerResponse
  'turn/interrupt': v2.TurnInterruptResponse
  'account/read': v2.GetAccountResponse
  'model/list': v2.ModelListResponse
}
export type ClientResult<M extends ClientMethod> = M extends keyof CodexResponses
  ? CodexResponses[M]
  : unknown

export type NotificationMethod = ServerNotification['method']
export type NotificationParams<M extends NotificationMethod> = Extract<
  ServerNotification,
  { method: M }
>['params']

export type ServerRequestMethod = ServerRequest['method']
export type ServerRequestParams<M extends ServerRequestMethod> = Extract<
  ServerRequest,
  { method: M }
>['params']

// ---------------------------------------------------------------------------
// Errors

/** The process is gone. Carries the exit and the last of stderr, which is
 * usually the only account of why. */
export class CodexProcessExitedError extends CodexConnectionClosedError {
  constructor(
    readonly exit: ProcessExit,
    readonly stderrTail: string,
  ) {
    const how = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.exitCode}`
    const tail = stderrTail.trim()
    const reason = tail ? telling(tail) : ''
    super(`codex app-server exited (${how})${reason ? `: ${reason}` : ''}`)
    this.name = 'CodexProcessExitedError'
  }
}

/** The CLI answered the handshake but is older than openmanager runs. */
export class CodexVersionUnsupportedError extends Error {
  constructor(readonly version: string) {
    super(`Codex ${version} is too old. Update Codex to ${CODEX_MIN_VERSION} or later.`)
    this.name = 'CodexVersionUnsupportedError'
  }
}

// ---------------------------------------------------------------------------
// The client

/** Notifications openmanager never acts on, suppressed at the source
 * (docs/decisions/codex-app-server.md, "Notifications"). */
export const CODEX_OPTED_OUT_NOTIFICATIONS: readonly NotificationMethod[] = [
  // The whole turn diff on every change; rebuilt from file-change items.
  'turn/diff/updated',
  // Remote control is out of scope: openmanager is the remote.
  'remoteControl/status/changed',
]

/** Server requests refused on purpose, answered at once with an error so the
 * server never waits on them. */
const DECLINED_SERVER_REQUESTS: ReadonlyArray<{ method: ServerRequestMethod; why: string }> = [
  // We never hand Codex ChatGPT tokens; its own login owns them.
  {
    method: 'account/chatgptAuthTokens/refresh',
    why: 'OpenManager does not manage Codex tokens',
  },
  // Attestation is declined explicitly (and not requested in initialize).
  { method: 'attestation/generate', why: 'OpenManager does not provide attestation' },
  // Dynamic tools wait on the openmanager MCP server decision.
  { method: 'item/tool/call', why: 'OpenManager registers no dynamic tools' },
]

export type CodexAppServerClientOptions = {
  log: HostDeps['log']
  /** Grace between SIGTERM and SIGKILL. */
  terminateGraceMs: number
  /** Default for requests that name no timeout of their own. */
  requestTimeoutMs: number
  /** Kill the whole process tree first (win32). */
  killTree?: (pid: number) => Promise<boolean>
  maxConcurrentServerRequests?: number
  /** How much of stderr to keep for error reports. Default 16 KiB. */
  stderrTailChars?: number
  /** After the process exits, how long to wait for stdout and stderr to be
   * read to the end before failing what is still waiting. Node fires `exit`
   * before the pipes are drained, and the last lines are the ones that
   * matter: a final answer, or the panic that explains the crash. Default
   * 500ms. */
  exitDrainMs?: number
}

export type CodexHandshake = {
  userAgent: string
  codexHome: string
  platformFamily: string
  platformOs: string
  version: CodexVersionCheck
}

/** One `codex app-server` process and the JSON-RPC connection to it.
 *
 * Owns the process and the wire, nothing above: no threads, no turns, no
 * events in openmanager's shape. A session runtime builds on this, and so
 * does the service process for work outside sessions.
 *
 * A crash is noticed from the process's own `exit`, not from the next RPC
 * failing: every request still waiting is rejected with
 * `CodexProcessExitedError` at once, and `exited` resolves. (T3 Code leaves
 * them hanging.) */
export class CodexAppServerClient {
  readonly exited: Promise<ProcessExit>
  private readonly peer: CodexRpcPeer
  private readonly lifecycle: ChildProcessLifecycle
  private stderr = ''
  private readonly stderrTailChars: number
  private handshake: CodexHandshake | undefined

  constructor(
    private readonly child: TerminableChild,
    private readonly options: CodexAppServerClientOptions,
  ) {
    this.stderrTailChars = options.stderrTailChars ?? 16 * 1024
    // The tree killer is chosen where the process is spawned
    // (`startCodexAppServer`), never defaulted here: this client may wrap a
    // child that is not an OS process (a test double), and `taskkill` on its
    // made-up pid would at best do nothing and at worst kill a stranger.
    const killTree = options.killTree
    this.lifecycle = new ChildProcessLifecycle(child, {
      graceMs: options.terminateGraceMs,
      log: options.log,
      scope: 'codex',
      label: 'codex app-server',
      ...(killTree ? { killTree } : {}),
    })
    this.peer = new CodexRpcPeer({
      write: (line) => {
        child.stdin.write(`${line}\n`)
      },
      log: options.log,
      defaultRequestTimeoutMs: options.requestTimeoutMs,
      ...(options.maxConcurrentServerRequests !== undefined
        ? { maxConcurrentServerRequests: options.maxConcurrentServerRequests }
        : {}),
    })

    const stdoutDone = streamDone(child.stdout)
    const stderrDone = streamDone(child.stderr)
    child.stdout.on('data', (chunk: Buffer | string) => this.peer.feed(chunk))
    child.stdout.on('end', () => this.peer.endOfInput())
    // Drained continuously: a child blocked on a full stderr pipe stops
    // answering on stdout too. Split into whole lines (and whole characters)
    // before anything is logged.
    // Bounded like stdout: a CLI redrawing a spinner with `\r` never ends a
    // line, and the decoder must not hold that forever.
    const stderrLines = new LineDecoder((line) => this.onStderrLine(line), {
      maxLineChars: 64 * 1024,
      onOversize: (chars, head) => this.onStderrLine(`${head.slice(0, 1000)}… (${chars} characters)`),
    })
    child.stderr.on('data', (chunk: Buffer | string) => stderrLines.push(chunk))
    child.stderr.on('end', () => stderrLines.end())
    // A write after the child died raises EPIPE on stdin. The exit closes the
    // peer with the real reason; without a listener the error would crash
    // the host instead. The same goes for the read side.
    for (const [name, stream] of [
      ['stdin', child.stdin],
      ['stdout', child.stdout],
      ['stderr', child.stderr],
    ] as const)
      stream.on('error', (error: Error) =>
        options.log({
          scope: 'codex',
          level: 'warn',
          message: `codex app-server ${name} failed`,
          data: { error: String(error) },
        }),
      )

    const drainMs = options.exitDrainMs ?? 500
    this.exited = this.lifecycle.exited.then(async (exit) => {
      await settleWithin(Promise.all([stdoutDone, stderrDone]), drainMs)
      this.peer.close(new CodexProcessExitedError(exit, this.stderr))
      return exit
    })

    this.peer.handle(
      'currentTime/read',
      () => ({ currentTimeAt: Math.floor(Date.now() / 1000) }),
      { immediate: true },
    )
    for (const { method, why } of DECLINED_SERVER_REQUESTS)
      this.peer.handle(
        method,
        () => {
          throw new CodexRpcError(RPC_METHOD_NOT_FOUND, why)
        },
        { immediate: true },
      )
  }

  get pid(): number | undefined {
    return this.lifecycle.pid
  }

  /** What `initialize` answered, once it has. */
  get info(): CodexHandshake | undefined {
    return this.handshake
  }

  get stats(): CodexRpcStats {
    return this.peer.stats
  }

  /** The last of stderr, bounded. */
  get stderrTail(): string {
    return this.stderr
  }

  /** `initialize`, then `initialized`. Rejects with
   * `CodexVersionUnsupportedError` below the minimum version — the process
   * is left running, and the caller decides whether to stop it. */
  async initialize(args: {
    clientVersion: string
    timeoutMs?: number
  }): Promise<CodexHandshake> {
    const params: InitializeParams = {
      clientInfo: { name: 'OpenManager', title: 'OpenManager', version: args.clientVersion },
      capabilities: {
        // Ordered approval choices and the auto reviewer live only here.
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [...CODEX_OPTED_OUT_NOTIFICATIONS],
        // `openai/form` is declared together with the elicitation handler,
        // never before it (docs/decisions/codex-app-server.md).
      },
    }
    const response: unknown = await this.request('initialize', params, {
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    })
    if (!isInitializeResponse(response))
      throw new Error(
        `codex app-server answered initialize with something unexpected: ${JSON.stringify(response)?.slice(0, 200)}`,
      )
    this.peer.notify('initialized')
    const version = checkCodexVersion(response.userAgent)
    this.handshake = {
      userAgent: response.userAgent,
      codexHome: response.codexHome,
      platformFamily: response.platformFamily,
      platformOs: response.platformOs,
      version,
    }
    if (version.status === 'unsupported' && version.version)
      throw new CodexVersionUnsupportedError(version.version)
    if (version.status === 'unknown')
      this.options.log({
        scope: 'codex',
        level: 'warn',
        message: 'Could not read the codex version from initialize',
        data: { userAgent: response.userAgent },
      })
    return this.handshake
  }

  request<M extends ClientMethod>(
    method: M,
    params: ClientParams<M>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ClientResult<M>> {
    return this.peer.request(method, params, options) as Promise<ClientResult<M>>
  }

  /** Every notification of one method, in arrival order. */
  on<M extends NotificationMethod>(
    method: M,
    listener: (params: NotificationParams<M>) => void,
  ): () => void {
    return this.peer.onNotification((message) => {
      if (message.method === method) listener(message.params as NotificationParams<M>)
    })
  }

  /** Every notification, in arrival order. */
  onAny(listener: (message: { method: string; params: unknown }) => void): () => void {
    return this.peer.onNotification(listener)
  }

  /** Answer server requests of one method. Replaces any earlier handler,
   * including the built-in refusals. */
  handle<M extends ServerRequestMethod>(
    method: M,
    handler: (params: ServerRequestParams<M>, context: ServerRequestContext) => unknown,
    options?: ServerRequestHandlerOptions,
  ): () => void {
    return this.peer.handle(
      method,
      (params, context) => handler(params as ServerRequestParams<M>, context),
      options,
    )
  }

  /** The server withdrew request `id` (`serverRequest/resolved`). */
  cancelServerRequest(id: RpcId): boolean {
    return this.peer.cancelServerRequest(id)
  }

  countUnknownItem(type: string): void {
    this.peer.countUnknownItem(type)
  }

  /** Stop the process through the shared termination ladder. Requests still
   * waiting are rejected with the exit. */
  terminate(request: TerminationRequest): Promise<ProcessExit> {
    return this.lifecycle.terminate(request).then(() => this.exited)
  }

  private onStderrLine(line: string): void {
    this.stderr = `${this.stderr}${line}\n`.slice(-this.stderrTailChars)
    const clean = stripAnsi(line).trim()
    if (!clean) return
    this.options.log({
      scope: 'codex',
      level: /\bERROR\b|panicked at/.test(clean) ? 'warn' : 'info',
      message: 'codex app-server stderr',
      data: { text: clean },
    })
  }
}

// ---------------------------------------------------------------------------
// Spawning

export type CodexSpawnSpec = {
  executable: CodexExecutable
  cwd: string
  env: Readonly<Record<string, string>>
  /** `-c key=value` overrides, placed before `app-server` as the CLI requires. */
  config?: readonly string[]
  spawnTimeoutMs: number
  /** An `error` event from the child after it started. */
  onError?: (error: Error) => void
}

/** Spawn `codex [-c …] app-server`, resolved once Node reports it running.
 *
 * Only a `.cmd` shim goes through a shell; a native binary is spawned
 * directly on every platform, so the child the ladder kills is Codex itself
 * and not a `cmd.exe` in front of it. */
export async function spawnCodexAppServer(spec: CodexSpawnSpec): Promise<ChildProcessWithoutNullStreams> {
  const args = [...(spec.config ?? []).flatMap((entry) => ['-c', entry]), 'app-server']
  const options = { cwd: spec.cwd, env: { ...spec.env }, windowsHide: true }
  const child = spec.executable.needsShell
    ? spawn(
        [escapeCmdCommand(spec.executable.command), ...args.map(escapeCmdArgument)].join(' '),
        { ...options, shell: true },
      )
    : spawn(spec.executable.command, args, options)
  await spawned(child, { label: 'codex app-server', spawnTimeoutMs: spec.spawnTimeoutMs })
  // `spawned` removes its own `error` listener. A later one (a `kill` that
  // fails with EPERM) would otherwise be an unhandled event and crash the host.
  child.on('error', (error) => spec.onError?.(error))
  return child
}

/** Spawn, connect and handshake in one step, stopping the process again if
 * any part fails. */
export async function startCodexAppServer(
  spec: CodexSpawnSpec & { clientVersion: string; initializeTimeoutMs: number },
  options: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  const child = await spawnCodexAppServer({
    ...spec,
    onError: (error) =>
      options.log({
        scope: 'codex',
        level: 'warn',
        message: 'codex app-server process error',
        data: { error: String(error) },
      }),
  })
  const client = new CodexAppServerClient(child, {
    ...options,
    // On Windows the tree goes too, shell or not: Codex's MCP servers and
    // command shells are its descendants, and nothing else reaps them.
    ...(process.platform === 'win32' && !options.killTree
      ? { killTree: treeKiller(options.terminateGraceMs) }
      : {}),
  })
  try {
    await client.initialize({
      clientVersion: spec.clientVersion,
      timeoutMs: spec.initializeTimeoutMs,
    })
    return client
  } catch (error) {
    await client.terminate({ reason: 'start_failed' }).catch(() => undefined)
    throw error
  }
}

/** `cmd.exe` metacharacters, escaped with `^`. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** Escape one argument for a command line run through `cmd.exe` that ends in
 * a `.cmd` shim, the way `cross-spawn` does: quote it for the C runtime's
 * argument parser (backslashes before a quote doubled, quotes escaped), then
 * `^`-escape every `cmd` metacharacter — twice, because the shim's own
 * `%*` hands the line through `cmd` a second time. Only reached when the
 * native binary behind a shim could not be found. */
export function escapeCmdArgument(arg: string): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  quoted = `"${quoted}"`
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1')
}

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1')
}

function isInitializeResponse(value: unknown): value is InitializeResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.userAgent === 'string' && typeof record.codexHome === 'string'
}

/** Resolves when a readable has ended or closed, whichever comes first. */
function streamDone(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise<void>((resolve) => {
    stream.once('end', () => resolve())
    stream.once('close', () => resolve())
  })
}

/** Wait for `promise`, but no longer than `ms`. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    void promise.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function stripAnsi(text: string): string {
  // CSI sequences (colours, cursor) and OSC sequences (titles, hyperlinks).
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** What in stderr best explains a crash.
 *
 * A Rust panic first: since Rust 1.73 it prints `thread '…' panicked at
 * <file>:<line>:<col>:` and the message on the *next* line, followed by a
 * `note: run with RUST_BACKTRACE=1` hint that explains nothing. Then an
 * `ERROR` log line, but only from the last few lines: an old one from
 * startup (the bubblewrap warning every Linux run prints) says nothing about
 * why the process died minutes later. Otherwise the last line. */
function telling(tail: string): string {
  const lines = tail
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line && !line.startsWith('note:'))
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!/panicked at/.test(lines[index]!)) continue
    const next = lines[index + 1]
    return next && lines[index]!.endsWith(':') ? `${lines[index]} ${next}` : lines[index]!
  }
  const recent = lines.slice(-5)
  const error = [...recent].reverse().find((line) => /\bERROR\b|^error:/.test(line))
  return error ?? lines.at(-1) ?? ''
}
