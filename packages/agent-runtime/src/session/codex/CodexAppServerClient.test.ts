import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerClient,
  CodexProcessExitedError,
  CodexVersionUnsupportedError,
  escapeCmdArgument,
  type CodexAppServerClientOptions,
} from './CodexAppServerClient.js'
import { CodexRpcTimeoutError, RPC_METHOD_NOT_FOUND } from './CodexRpcPeer.js'
import { FakeCodexAppServer } from './testing/FakeCodexAppServer.js'
import { CODEX_RECOMMENDED_VERSION } from './version.js'

// Messages read back off the fake wire are poked at freely in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = Record<string, any>

/** The shared fake (`testing/FakeCodexAppServer.ts`) with nothing scripted:
 * these tests play the server's side line by line. `written` is what the
 * client sent, `reply` frames messages onto stdout in one chunk, and `die`
 * ends the process with a code or a signal. Exit works as a real child's,
 * including a child that ignores SIGTERM and pipes that close only after
 * `exit` (`closePipesOnExit = false` holds them open to play the late part of
 * the stream by hand). */
class FakeChild extends FakeCodexAppServer {
  constructor() {
    // These tests play the handshake (or skip it) by hand.
    super({ initialize: false, unscripted: 'ignore', requireHandshake: false })
  }

  get written(): Wire[] {
    return this.received as Wire[]
  }

  reply(...messages: unknown[]): void {
    this.writeLine(messages.map((message) => `${JSON.stringify(message)}\n`).join(''))
  }

  /** The requests the client sent, by method. */
  sentRequests(method: string): Wire[] {
    return this.written.filter((message) => message.method === method && 'id' in message)
  }

  die(signal: NodeJS.Signals | null, code: number | null = null): void {
    if (signal) this.crash({ signal })
    else if (code === 0) this.exit(0)
    else this.crash({ code: code ?? 1 })
  }
}

/** Let the PassThrough pipes deliver. They emit on process.nextTick, which
 * fake timers leave alone, so this works with either kind of timer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => process.nextTick(resolve))
}

/** One real event-loop turn: data a pipe has not delivered yet. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

function build(options: Partial<CodexAppServerClientOptions> = {}) {
  const child = new FakeChild()
  const log = vi.fn()
  const client = new CodexAppServerClient(child, {
    log,
    terminateGraceMs: 2_000,
    requestTimeoutMs: 0,
    ...options,
  })
  return { child, client, log }
}

function initializeResult(userAgent: string) {
  return {
    userAgent,
    codexHome: '/home/user/.codex',
    platformFamily: 'unix',
    platformOs: 'linux',
  }
}

/** Run the handshake against a server that answers with `result`. */
async function handshakeWith(result: unknown, options: Partial<CodexAppServerClientOptions> = {}) {
  const built = build(options)
  const promise = built.client.initialize({ clientVersion: '1.2.3' })
  // Attach a handler now so a rejection is never reported as unhandled.
  const outcome = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  await flush()
  const [request] = built.child.sentRequests('initialize')
  built.child.reply({ id: request!.id, result })
  await flush()
  return { ...built, request: request!, outcome: await outcome }
}

const handshake = (userAgent: string, options: Partial<CodexAppServerClientOptions> = {}) =>
  handshakeWith(initializeResult(userAgent), options)

/** Outcome of a promise without awaiting it forever. */
function track<T>(promise: Promise<T>) {
  const state: { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = {
    status: 'pending',
  }
  promise.then(
    (value) => Object.assign(state, { status: 'resolved', value }),
    (error: unknown) => Object.assign(state, { status: 'rejected', error }),
  )
  return state
}

const APPROVAL = 'item/commandExecution/requestApproval'

afterEach(() => vi.useRealTimers())

describe('CodexAppServerClient initialize', () => {
  it('sends the handshake openmanager depends on, then initialized', async () => {
    const userAgent = 'OpenManager/0.170.0 (Ubuntu 24.4.0; x86_64) unknown (OpenManager; 1.2.3)'
    const { child, client, request, outcome } = await handshake(userAgent)

    expect(request).not.toHaveProperty('jsonrpc')
    expect(request.params).toMatchObject({
      // Becomes the originator of our threads in the user's Codex history.
      clientInfo: { name: 'OpenManager', version: '1.2.3' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    expect(request.params.capabilities.optOutNotificationMethods).toContain('turn/diff/updated')

    // `initialized` follows the answer, never precedes it.
    const initIndex = child.written.indexOf(request)
    const initializedIndex = child.written.findIndex((m) => m.method === 'initialized')
    expect(initializedIndex).toBeGreaterThan(initIndex)
    expect(child.written[initializedIndex]).toEqual({ method: 'initialized' })

    expect(outcome.ok).toBe(true)
    const expected = {
      userAgent,
      codexHome: '/home/user/.codex',
      platformFamily: 'unix',
      platformOs: 'linux',
      version: { version: '0.170.0', status: 'supported' },
    }
    expect(outcome.ok && outcome.value).toEqual(expected)
    expect(client.info).toEqual(expected)
  })

  it('refuses a codex below the minimum, leaving the process to the caller', async () => {
    const { child, outcome } = await handshake('OpenManager/0.150.0 (Linux; x86_64)')
    expect(outcome.ok).toBe(false)
    const error = !outcome.ok ? outcome.error : undefined
    expect(error).toBeInstanceOf(CodexVersionUnsupportedError)
    expect(error).toMatchObject({ version: '0.150.0' })
    expect(child.signals).toEqual([])
  })

  it('runs an outdated codex with status outdated', async () => {
    const { outcome } = await handshake('OpenManager/0.165.0 (Linux; x86_64)')
    expect(outcome.ok && outcome.value.version).toEqual({ version: '0.165.0', status: 'outdated' })
  })

  it('reports the pinned version as supported', async () => {
    const { outcome } = await handshake(`OpenManager/${CODEX_RECOMMENDED_VERSION} (Linux; x86_64)`)
    expect(outcome.ok && outcome.value.version).toEqual({
      version: CODEX_RECOMMENDED_VERSION,
      status: 'supported',
    })
  })

  it('runs with status unknown and a warning when the userAgent is unreadable', async () => {
    const { outcome, log } = await handshake('totally garbage agent')
    expect(outcome.ok && outcome.value.version).toEqual({ status: 'unknown' })
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'codex',
        level: 'warn',
        data: { userAgent: 'totally garbage agent' },
      }),
    )
  })

  it('runs a source build (0.0.0) with status unknown rather than refusing it', async () => {
    const { outcome } = await handshake('OpenManager/0.0.0 (Linux; x86_64)')
    expect(outcome.ok && outcome.value.version).toEqual({ version: '0.0.0', status: 'unknown' })
  })

  it.each([
    ['a string', 'nope'],
    ['null', null],
    ['no userAgent', { codexHome: '/h' }],
    ['a numeric userAgent', { userAgent: 170, codexHome: '/h' }],
    ['no codexHome', { userAgent: 'OpenManager/0.170.0 (Linux)' }],
  ])('rejects a handshake answer with %s, and never sends initialized', async (_label, result) => {
    const { child, outcome, client } = await handshakeWith(result)
    expect(outcome.ok).toBe(false)
    const error = !outcome.ok ? (outcome.error as Error) : undefined
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toMatch(/initialize/)
    expect(child.written.some((m) => m.method === 'initialized')).toBe(false)
    expect(client.info).toBeUndefined()
  })
})

describe('CodexAppServerClient built-in server requests', () => {
  it('answers currentTime/read with unix seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-20T12:00:00.750Z'))
    const { child } = build()
    child.reply({ id: 'time-1', method: 'currentTime/read', params: {} })
    await flush()
    expect(child.answerTo('time-1')).toEqual({
      id: 'time-1',
      result: { currentTimeAt: Math.floor(Date.parse('2026-11-20T12:00:00.750Z') / 1000) },
    })
  })

  it('refuses token refresh, attestation and dynamic tool calls at once', async () => {
    const { child } = build()
    const declined = ['account/chatgptAuthTokens/refresh', 'attestation/generate', 'item/tool/call']
    child.reply(...declined.map((method, i) => ({ id: i + 1, method, params: {} })))
    await flush()
    for (const id of [1, 2, 3])
      expect(child.answerTo(id)).toEqual({
        id,
        error: { code: RPC_METHOD_NOT_FOUND, message: expect.stringContaining('OpenManager') },
      })
  })

  it('answers the built-ins while approvals saturate the cap', async () => {
    // An approval waits on a person. The clock and the refusals must not
    // wait behind it, or Codex stalls on a question it could have had
    // answered in a microsecond.
    const { child, client } = build({ maxConcurrentServerRequests: 1 })
    const parked = vi.fn(() => new Promise(() => undefined))
    client.handle(APPROVAL, parked)
    child.reply(
      { id: 'a1', method: APPROVAL, params: {} },
      { id: 'a2', method: APPROVAL, params: {} },
      { id: 't', method: 'currentTime/read', params: {} },
      { id: 'r1', method: 'account/chatgptAuthTokens/refresh', params: {} },
      { id: 'r2', method: 'attestation/generate', params: {} },
      { id: 'r3', method: 'item/tool/call', params: {} },
    )
    await flush()
    expect(parked).toHaveBeenCalledTimes(1)
    expect(child.answerTo('t')).toMatchObject({ result: { currentTimeAt: expect.any(Number) } })
    for (const id of ['r1', 'r2', 'r3'])
      expect(child.answerTo(id)).toMatchObject({ error: { code: RPC_METHOD_NOT_FOUND } })
    expect(child.answerTo('a1')).toBeUndefined()
    expect(child.answerTo('a2')).toBeUndefined()
  })

  it('lets the caller replace a built-in handler', async () => {
    const { child, client } = build()
    client.handle('item/tool/call', () => ({ contentItems: [], success: true }))
    child.reply({ id: 9, method: 'item/tool/call', params: {} })
    await flush()
    expect(child.answerTo(9)).toEqual({ id: 9, result: { contentItems: [], success: true } })
  })
})

describe('CodexAppServerClient caller handlers', () => {
  it('passes handler options through, so an immediate handler skips the cap', async () => {
    const { child, client } = build({ maxConcurrentServerRequests: 1 })
    client.handle(APPROVAL, () => new Promise(() => undefined))
    client.handle('item/tool/requestUserInput', () => ({ answers: {} }), { immediate: true })
    child.reply(
      { id: 1, method: APPROVAL, params: {} },
      { id: 2, method: 'item/tool/requestUserInput', params: {} },
    )
    await flush()
    expect(child.answerTo(2)).toEqual({ id: 2, result: { answers: {} } })
  })

  it('cancels a server request the server withdrew', async () => {
    const { child, client } = build()
    let signal: AbortSignal | undefined
    client.handle(APPROVAL, (_params, context) => {
      signal = context.signal
      return new Promise((resolve) => context.signal.addEventListener('abort', () => resolve('stale')))
    })
    child.reply({ id: 'w', method: APPROVAL, params: {} })
    await flush()
    expect(client.cancelServerRequest('w')).toBe(true)
    expect(signal!.aborted).toBe(true)
    await flush()
    expect(child.answerTo('w')).toBeUndefined()
    expect(client.cancelServerRequest('w')).toBe(false)
  })
})

describe('CodexAppServerClient notifications', () => {
  it('routes by method with on(), and everything with onAny()', async () => {
    const { child, client } = build()
    const started = vi.fn()
    const all = vi.fn()
    client.on('turn/started', started)
    client.onAny(all)
    child.reply(
      { method: 'turn/started', params: { threadId: 't', turn: { id: 'u' } } },
      { method: 'turn/completed', params: { threadId: 't' } },
    )
    await flush()
    expect(started).toHaveBeenCalledWith({ threadId: 't', turn: { id: 'u' } })
    expect(started).toHaveBeenCalledTimes(1)
    expect(all.mock.calls.map(([m]) => m.method)).toEqual(['turn/started', 'turn/completed'])
  })
})

describe('CodexAppServerClient process exit', () => {
  it('rejects a request in flight when the child crashes, with the exit code and last stderr line', async () => {
    const { child, client } = build()
    const inFlight = track(client.request('model/list', {}))
    child.stderr.write('starting up\n')
    child.stderr.write('\u001b[31mERROR\u001b[0m thread main panicked: boom\n')
    await flush()

    child.die(null, 1)
    await expect(client.exited).resolves.toMatchObject({ exitCode: 1, signal: null, forced: false })
    expect(inFlight.status).toBe('rejected')
    const error = inFlight.error as CodexProcessExitedError
    expect(error).toBeInstanceOf(CodexProcessExitedError)
    expect(error.message).toContain('exit code 1')
    expect(error.message).toContain('ERROR thread main panicked: boom')
    expect(error.message).not.toContain('\u001b')
    expect(error.exit).toMatchObject({ exitCode: 1 })

    // After the crash nothing is sent and nothing waits.
    const writtenBefore = child.written.length
    await expect(client.request('model/list', {})).rejects.toBeInstanceOf(CodexProcessExitedError)
    await flush()
    expect(child.written).toHaveLength(writtenBefore)
  })

  it('includes stderr that is read after the exit event', async () => {
    // Node fires `exit` before the pipes are drained; the panic is usually
    // the last thing written and so the last thing read.
    const { child, client } = build()
    child.closePipesOnExit = false
    const inFlight = track(client.request('model/list', {}))
    await flush()
    child.die(null, 101)
    await nextTurn()
    expect(inFlight.status).toBe('pending')
    child.stderr.end("thread 'main' panicked at core/src/lib.rs:1:5:\n")
    child.stdout.end()
    await client.exited
    await flush()
    expect(inFlight.status).toBe('rejected')
    expect((inFlight.error as Error).message).toContain('exit code 101')
    expect((inFlight.error as Error).message).toContain('panicked at core/src/lib.rs:1:5')
  })

  it('resolves a request whose answer is read after the exit event', async () => {
    // The server answered and then exited; the answer was still in the pipe
    // when `exit` fired. It is an answer, not a crash.
    const { child, client } = build()
    child.closePipesOnExit = false
    const answered = track(client.request('model/list', {}))
    const unanswered = track(client.request('account/read', {}))
    await flush()
    child.die(null, 0)
    await nextTurn()
    child.stdout.end('{"id":1,"result":{"data":["gpt"]}}\n')
    child.stderr.end()
    await client.exited
    await flush()
    expect(answered).toMatchObject({ status: 'resolved', value: { data: ['gpt'] } })
    expect(unanswered.status).toBe('rejected')
    expect(unanswered.error).toBeInstanceOf(CodexProcessExitedError)
  })

  it('stops waiting for the pipes exitDrainMs after exit', async () => {
    // A grandchild holding the pipes open must not keep callers waiting on a
    // process that is already dead.
    vi.useFakeTimers()
    const { child, client } = build({ exitDrainMs: 300 })
    child.closePipesOnExit = false
    const inFlight = track(client.request('model/list', {}))
    const exited = track(client.exited)
    await flush()
    child.die(null, 1)
    await flush()

    await vi.advanceTimersByTimeAsync(299)
    expect(inFlight.status).toBe('pending')
    expect(exited.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(exited).toMatchObject({ status: 'resolved', value: { exitCode: 1 } })
    expect(inFlight.status).toBe('rejected')
    expect(inFlight.error).toBeInstanceOf(CodexProcessExitedError)
  })

  it('names the panic, not the RUST_BACKTRACE note, from a real Rust panic tail', async () => {
    const { child, client } = build()
    const inFlight = track(client.request('model/list', {}))
    child.stderr.write(
      '\u001b[2m2026-11-20T12:00:00Z\u001b[0m \u001b[32m INFO\u001b[0m codex_app_server: listening\n' +
        "thread 'main' panicked at src/x.rs:1:2:\n" +
        'boom\n' +
        'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n',
    )
    await flush()
    child.die(null, 101)
    await client.exited
    await flush()
    const message = (inFlight.error as Error).message
    expect(message).toContain("thread 'main' panicked at src/x.rs:1:2")
    expect(message).not.toContain('RUST_BACKTRACE')
    expect(message).not.toContain('listening')
  })

  // Since Rust 1.73 a panic prints its location on the `panicked at …:` line
  // and the panic *message* on the next; the reason must survive.
  it('includes the panic message that follows the panicked-at line', async () => {
    const { child, client } = build()
    const inFlight = track(client.request('model/list', {}))
    child.stderr.write(
      "thread 'main' panicked at src/x.rs:1:2:\nboom\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n",
    )
    await flush()
    child.die(null, 101)
    await client.exited
    await flush()
    expect((inFlight.error as Error).message).toContain('boom')
  })

  it('times out a stalled request and drops the late answer', async () => {
    vi.useFakeTimers()
    const { child, client } = build({ requestTimeoutMs: 5_000 })
    const stalled = track(client.request('model/list', {}))
    await flush()
    const [request] = child.sentRequests('model/list')

    await vi.advanceTimersByTimeAsync(4_999)
    expect(stalled.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(stalled.status).toBe('rejected')
    expect(stalled.error).toBeInstanceOf(CodexRpcTimeoutError)
    expect(stalled.error).toMatchObject({ method: 'model/list', timeoutMs: 5_000 })

    child.reply({ id: request!.id, result: { data: [] } })
    await flush()
    expect(client.stats.lateResponses).toBe(1)
  })

  it('escalates to SIGKILL when the child ignores SIGTERM, and rejects what was waiting', async () => {
    vi.useFakeTimers()
    const { child, client } = build({ terminateGraceMs: 2_000 })
    child.ignoreSigterm = true
    const waiting = track(client.request('model/list', {}))
    const terminated = track(client.terminate({ reason: 'disposed' }))
    await flush()
    expect(child.signals).toEqual(['SIGTERM'])

    await vi.advanceTimersByTimeAsync(1_999)
    expect(child.signals).toEqual(['SIGTERM'])
    expect(waiting.status).toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await expect(client.exited).resolves.toMatchObject({ signal: 'SIGKILL', forced: true })
    await flush()
    expect(terminated).toMatchObject({ status: 'resolved', value: { forced: true } })
    expect(waiting.status).toBe('rejected')
    expect(waiting.error).toBeInstanceOf(CodexProcessExitedError)
    expect((waiting.error as Error).message).toContain('signal SIGKILL')
  })

  it('stops a cooperative child with SIGTERM alone', async () => {
    vi.useFakeTimers()
    const { child, client } = build()
    await expect(client.terminate({ reason: 'disposed' })).resolves.toMatchObject({
      signal: 'SIGTERM',
      forced: false,
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(child.signals).toEqual(['SIGTERM'])
  })
})

describe('CodexAppServerClient stderr', () => {
  it('keeps a bounded tail of stderr', async () => {
    const { child, client } = build({ stderrTailChars: 64 })
    for (let i = 0; i < 50; i++) {
      child.stderr.write(`line ${String(i).padStart(2, '0')} ${'.'.repeat(20)}\n`)
      await flush()
      expect(client.stderrTail.length).toBeLessThanOrEqual(64)
    }
    expect(client.stderrTail.endsWith(`line 49 ${'.'.repeat(20)}\n`)).toBe(true)
    expect(client.stderrTail).not.toContain('line 00')
  })

  it('logs each stderr line with ANSI codes stripped, ERROR lines as warnings', async () => {
    const { child, log } = build()
    child.stderr.write(
      '\u001b[2m2026-11-20T12:00:00Z\u001b[0m \u001b[32m INFO\u001b[0m booted\r\n' +
        '\u001b[1;31mERROR\u001b[0m codex_core: bubblewrap missing\n\n' +
        // A terminal title (OSC), which a colour-only stripper leaves behind.
        '\u001b]0;codex\u0007ready\n',
    )
    await flush()
    const stderrLogs = log.mock.calls
      .map(([entry]) => entry as { level: string; message: string; data: { text: string } })
      .filter((entry) => entry.message === 'codex app-server stderr')
    expect(stderrLogs).toEqual([
      expect.objectContaining({ level: 'info', data: { text: '2026-11-20T12:00:00Z  INFO booted' } }),
      expect.objectContaining({ level: 'warn', data: { text: 'ERROR codex_core: bubblewrap missing' } }),
      expect.objectContaining({ level: 'info', data: { text: 'ready' } }),
    ])
    for (const entry of stderrLogs) expect(entry.data.text).not.toContain('\u001b')
  })

  it('logs a line split across chunks once, whole, with split characters intact', async () => {
    const { child, client, log } = build()
    const bytes = Buffer.from('ERROR codex_core: Größe € überschritten\n', 'utf8')
    const euro = bytes.indexOf(0xe2)
    child.stderr.write(bytes.subarray(0, 10))
    await flush()
    child.stderr.write(bytes.subarray(10, euro + 1))
    await flush()
    child.stderr.write(bytes.subarray(euro + 1))
    await flush()
    const texts = log.mock.calls
      .map(([entry]) => entry as { message: string; data: { text: string } })
      .filter((entry) => entry.message === 'codex app-server stderr')
      .map((entry) => entry.data.text)
    expect(texts).toEqual(['ERROR codex_core: Größe € überschritten'])
    expect(client.stderrTail).toBe('ERROR codex_core: Größe € überschritten\n')
  })

  it('survives an EPIPE on stdin', () => {
    const { child, log } = build()
    child.stdin.emit('error', new Error('write EPIPE'))
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', data: { error: 'Error: write EPIPE' } }),
    )
  })
})

describe('CodexAppServerClient stdout', () => {
  it('delivers a final unterminated line when stdout ends', async () => {
    const { child, client } = build()
    const answered = client.request('model/list', {})
    await flush()
    child.stdout.end('{"id":1,"result":{"data":[]}}')
    await expect(answered).resolves.toEqual({ data: [] })
  })

  it('reassembles a message split across stdout chunks, including a split character', async () => {
    const { child, client } = build()
    const answered = client.request('model/list', {})
    await flush()
    const bytes = Buffer.from('{"id":1,"result":{"name":"Größe €"}}\n', 'utf8')
    const cut = bytes.indexOf(0xe2) + 1
    child.stdout.write(bytes.subarray(0, cut))
    await flush()
    child.stdout.write(bytes.subarray(cut))
    await expect(answered).resolves.toEqual({ name: 'Größe €' })
  })
})

describe('escapeCmdArgument', () => {
  // A `.cmd` shim passes its arguments through cmd.exe twice (the shell, then
  // the shim's own `%*`), so every metacharacter, quotes included, is
  // ^-escaped twice: `"` becomes `^^^"`.
  it('quotes a plain word', () => {
    expect(escapeCmdArgument('app-server')).toBe('^^^"app-server^^^"')
  })

  it('escapes the space in a value with spaces', () => {
    expect(escapeCmdArgument('a b')).toBe('^^^"a^^^ b^^^"')
  })

  it('backslash-escapes embedded quotes for the C runtime, then ^-escapes them', () => {
    expect(escapeCmdArgument('model="gpt-5"')).toBe('^^^"model=\\^^^"gpt-5\\^^^"^^^"')
    // Backslashes before a quote are doubled, plus one for the quote itself.
    expect(escapeCmdArgument('a\\"b')).toBe('^^^"a\\\\\\^^^"b^^^"')
  })

  it('doubles trailing backslashes so they do not escape the closing quote', () => {
    expect(escapeCmdArgument('C:\\dir\\')).toBe('^^^"C:\\dir\\\\^^^"')
    // Backslashes elsewhere are literal and left alone.
    expect(escapeCmdArgument('C:\\a\\b')).toBe('^^^"C:\\a\\b^^^"')
  })

  it('escapes % so cmd cannot expand a variable', () => {
    expect(escapeCmdArgument('%PATH%')).toBe('^^^"^^^%PATH^^^%^^^"')
  })

  it('escapes command separators and redirections', () => {
    const escaped = escapeCmdArgument('x & del /q * | y > z')
    for (const meta of ['&', '|', '>', '*']) expect(escaped).toContain(`^^^${meta}`)
    expect(escaped).not.toMatch(/(?<!\^)[&|>]/)
  })
})
