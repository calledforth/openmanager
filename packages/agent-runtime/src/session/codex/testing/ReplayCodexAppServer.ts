import { isDeepStrictEqual } from 'node:util'
import type { RpcId } from '../CodexRpcPeer.js'
import {
  FakeCodexAppServer,
  isWireNotification,
  isWireRequest,
  isWireResponse,
  type FakeCodexAppServerOptions,
  type WireMessage,
} from './FakeCodexAppServer.js'
import { readCodexFixture, type CodexFixture, type CodexFixtureEntry, type CodexFixtureName } from './fixture.js'

export type ReplayCodexAppServerOptions = Omit<
  FakeCodexAppServerOptions,
  'initialize' | 'unscripted' | 'requireHandshake'
> & {
  /** `instant` (the default) plays the server's lines as soon as the
   * recording reaches them, which keeps tests fast and deterministic.
   * `recorded` keeps the recorded gaps between them, divided by `speed`. */
  pace?: 'instant' | 'recorded'
  speed?: number
}

/** One client message the recording expected, and the one the client sent. */
export type ReplayMatch = { recorded: WireMessage; actual: WireMessage }

/** Where the client parted from the recording.
 *
 * - `order`: the client sent `actual` when the recording expected `expected`
 *   next. A request is answered `-32600` at once, so the client fails fast
 *   instead of waiting for an answer that will never come.
 * - `answer`: the client answered a server request (`actual`) differently from
 *   the recording (`recorded`): another `result`, or another error code.
 * - `params` (only from `assertPlayedAsRecorded({ params: true })`): a request
 *   or notification matched by method but carried other params. */
export type ReplayMismatch =
  | { kind: 'order'; expected: WireMessage; actual: WireMessage }
  | { kind: 'answer'; recorded: WireMessage; actual: WireMessage }
  | { kind: 'params'; recorded: WireMessage; actual: WireMessage }

/** A fake `codex app-server` that plays a recording (see `fixture.ts`) to the
 * real client, and checks the client says what Codex was recorded hearing.
 *
 * It walks the recording in order. A server line is played when the walk
 * reaches it. A client line is a wait: the walk stops until the client has
 * sent a message, so the server never runs ahead of what the client has
 * actually done. That message must be the one the recording has next, matched
 * by kind and method, never by raw id: the client numbers its own requests,
 * and the recorded answer goes back under the id the client used. Server
 * requests keep their recorded ids (the server owns those), so the client's
 * answer is matched by that id, and its `result` (or error code) is compared
 * with the recorded one.
 *
 * Client messages are taken strictly in the order they arrive. One that is not
 * what the recording expects next is an `order` mismatch, and dropped (a
 * request is refused with `-32600`); an answer unlike the recorded one is an
 * `answer` mismatch, and the walk goes on. A request the test scripted with
 * `respond` is answered from the script and is not part of the recording.
 * After the end of the recording a request is answered `-32601` and kept in
 * `unmatched`, as is anything still waiting when the test looks.
 *
 * `assertPlayedAsRecorded()` checks all of it at the end of a test: the whole
 * recording played, nothing unmatched, no mismatches (and, opted into, the
 * same params). Params are not compared by default: ids, versions and paths
 * legitimately differ between a recording and a replay. `matched` pairs each
 * recorded client message with the real one, for finer assertions.
 *
 * When a test hangs, `waitingFor` says which client message the replay is
 * still waiting for. */
export class ReplayCodexAppServer extends FakeCodexAppServer {
  readonly fixture: CodexFixture
  readonly matched: ReplayMatch[] = []
  readonly mismatches: ReplayMismatch[] = []
  /** Resolves when the recording has been played to its end, or the process
   * has exited. */
  readonly done: Promise<void>

  private readonly pace: 'instant' | 'recorded'
  private readonly speed: number
  private readonly inbox: WireMessage[] = []
  private readonly afterEnd: WireMessage[] = []
  /** Recorded client request id → the id the client really used. */
  private readonly ids = new Map<string, RpcId>()
  private cursor = 0
  private lastPlayedAtMs = 0
  private busy = false
  private timer: NodeJS.Timeout | undefined
  private finish!: () => void

  constructor(fixture: CodexFixture | CodexFixtureName, options: ReplayCodexAppServerOptions = {}) {
    // The recording holds the handshake, and the walk checks its order.
    super({ ...options, initialize: false, unscripted: 'ignore', requireHandshake: false })
    this.fixture = typeof fixture === 'string' ? readCodexFixture(fixture) : fixture
    this.pace = options.pace ?? 'instant'
    this.speed = options.speed ?? 1
    this.done = new Promise<void>((resolve) => {
      this.finish = resolve
    })
    // Anything the server said before the client's first message.
    queueMicrotask(() => this.advance())
  }

  get finished(): boolean {
    return this.cursor >= this.fixture.entries.length
  }

  /** Client messages the recording had no place for: sent after its end, or
   * still waiting for the walk. */
  get unmatched(): WireMessage[] {
    return [...this.inbox, ...this.afterEnd]
  }

  /** The recorded client message the replay is waiting for, if it is. */
  get waitingFor(): WireMessage | undefined {
    const entry = this.fixture.entries[this.cursor]
    return entry?.from === 'client' ? entry.message : undefined
  }

  /** The recorded client messages, in order. */
  recordedClientMessages(): WireMessage[] {
    return this.fixture.entries.flatMap((entry) => (entry.from === 'client' ? [entry.message] : []))
  }

  /** Throw unless the client said exactly what Codex was recorded hearing:
   * the recording played to its end, in order, with the recorded answers to
   * server requests and nothing left over. `params: true` also requires each
   * request and notification to carry the recorded params. Call it once the
   * test is done with the client (after `await server.done`). */
  assertPlayedAsRecorded(options: { params?: boolean } = {}): void {
    const problems: string[] = []
    if (!this.finished)
      problems.push(
        `the recording stopped at entry ${this.cursor + 1} of ${this.fixture.entries.length}` +
          (this.waitingFor ? `, waiting for the client to send ${describe(this.waitingFor)}` : ''),
      )
    const mismatches = [...this.mismatches]
    if (options.params)
      for (const { recorded, actual } of this.matched)
        if (!isWireResponse(recorded) && !isDeepStrictEqual(actual.params, recorded.params))
          mismatches.push({ kind: 'params', recorded, actual })
    for (const mismatch of mismatches) problems.push(describeMismatch(mismatch))
    for (const message of this.unmatched) problems.push(`the recording has no place for ${JSON.stringify(message)}`)
    if (problems.length > 0)
      throw new Error(`${this.fixture.header.scenario} was not played as recorded:\n- ${problems.join('\n- ')}`)
  }

  protected override onClientMessage(message: WireMessage): void {
    // Outside the recording: what the test scripted itself.
    if (
      (isWireRequest(message) && this.hasScript(message.method)) ||
      (isWireResponse(message) && this.awaitsAnswer(message.id))
    ) {
      super.onClientMessage(message)
      return
    }
    if (this.finished) {
      this.afterEnd.push(message)
      if (isWireRequest(message))
        this.send({
          id: message.id,
          error: { code: -32601, message: `replay: ${message.method} is not in the recording` },
        })
      return
    }
    this.inbox.push(message)
    this.advance()
  }

  protected override onExit(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.finish()
  }

  private advance(): void {
    if (this.busy || this.timer) return
    this.busy = true
    try {
      while (!this.finished && !this.exited) {
        const entry = this.fixture.entries[this.cursor]!
        if (entry.from === 'client') {
          if (!this.consume(entry.message)) return
          // Gaps are kept from the client's message too: what the server
          // says next is usually its reaction to it.
          this.lastPlayedAtMs = entry.atMs
          this.cursor++
          continue
        }
        if (this.pace === 'recorded') {
          const wait = Math.max(0, (entry.atMs - this.lastPlayedAtMs) / this.speed)
          if (wait > 0) {
            this.lastPlayedAtMs = entry.atMs
            this.timer = setTimeout(() => {
              this.timer = undefined
              this.play(entry)
              this.cursor++
              this.advance()
            }, wait)
            // A replay left waiting must not keep the test process alive.
            this.timer.unref()
            return
          }
        }
        this.play(entry)
        this.cursor++
      }
    } finally {
      this.busy = false
    }
    if (this.finished || this.exited) this.finish()
  }

  /** Take the client message `recorded` waits for: the oldest one in the
   * inbox. Anything older that is not it was sent out of order. */
  private consume(recorded: WireMessage): boolean {
    for (let actual = this.inbox.shift(); actual !== undefined; actual = this.inbox.shift()) {
      if (!matches(recorded, actual)) {
        this.mismatches.push({ kind: 'order', expected: recorded, actual })
        if (isWireRequest(actual))
          this.send({
            id: actual.id,
            error: {
              code: -32600,
              message: `replay: expected ${describe(recorded)} next, not ${describe(actual)}`,
            },
          })
        continue
      }
      if (isWireRequest(recorded)) this.ids.set(String(recorded.id), actual.id!)
      if (isWireResponse(recorded) && !sameAnswer(recorded, actual))
        this.mismatches.push({ kind: 'answer', recorded, actual })
      this.matched.push({ recorded, actual })
      return true
    }
    return false
  }

  private play(entry: Exclude<CodexFixtureEntry, { from: 'client' }>): void {
    this.lastPlayedAtMs = entry.atMs
    if ('message' in entry) {
      const message = entry.message
      if (isWireResponse(message)) {
        const id = this.ids.get(String(message.id)) ?? message.id
        this.send({ ...message, id })
      } else this.send(message)
    } else if ('stderr' in entry) this.writeStderr(`${entry.stderr}\n`)
    else if ('raw' in entry) this.writeLine(`${entry.raw}\n`)
    // The recorder shutting Codex down: the end of the recording. The process
    // stays up until the test stops it.
    else if (entry.exit.cause === 'client') return
    else if (entry.exit.signal) this.crash({ signal: entry.exit.signal })
    else this.crash({ code: entry.exit.code ?? 1 })
  }

}

function sameAnswer(recorded: WireMessage, actual: WireMessage): boolean {
  if (recorded.error || actual.error) return recorded.error?.code === actual.error?.code
  return isDeepStrictEqual(actual.result, recorded.result)
}

function describe(message: WireMessage): string {
  if (isWireRequest(message)) return `request ${message.method}`
  if (isWireNotification(message)) return `notification ${message.method}`
  return `the answer to server request ${String(message.id)}`
}

function describeMismatch(mismatch: ReplayMismatch): string {
  switch (mismatch.kind) {
    case 'order':
      return `expected ${describe(mismatch.expected)}, the client sent ${JSON.stringify(mismatch.actual)}`
    case 'answer':
      return `${describe(mismatch.recorded)} was ${JSON.stringify(mismatch.actual)}, recorded as ${JSON.stringify(mismatch.recorded)}`
    case 'params':
      return `${describe(mismatch.recorded)} had params ${JSON.stringify(mismatch.actual.params)}, recorded as ${JSON.stringify(mismatch.recorded.params)}`
  }
}

function matches(recorded: WireMessage, actual: WireMessage): boolean {
  if (isWireRequest(recorded)) return isWireRequest(actual) && actual.method === recorded.method
  if (isWireNotification(recorded)) return isWireNotification(actual) && actual.method === recorded.method
  return isWireResponse(actual) && String(actual.id) === String(recorded.id)
}
