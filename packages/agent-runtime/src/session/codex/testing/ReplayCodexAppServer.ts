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

export type ReplayCodexAppServerOptions = Omit<FakeCodexAppServerOptions, 'initialize' | 'unscripted'> & {
  /** `instant` (the default) plays the server's lines as soon as the
   * recording reaches them, which keeps tests fast and deterministic.
   * `recorded` keeps the recorded gaps between them, divided by `speed`. */
  pace?: 'instant' | 'recorded'
  speed?: number
}

/** One client message the recording expected, and the one the client sent. */
export type ReplayMatch = { recorded: WireMessage; actual: WireMessage }

/** A fake `codex app-server` that plays a recording (see `fixture.ts`) to the
 * real client.
 *
 * It walks the recording in order. A server line is played when the walk
 * reaches it. A client line is a wait: the walk stops until the client has
 * sent a matching message, so the server never runs ahead of what the client
 * has actually done. Matching is by kind and method, in order, never by raw
 * id: the client numbers its own requests, and the recorded answer goes back
 * under the id the client used. Server requests keep their recorded ids (the
 * server owns those), so the client's answer is matched by that id.
 *
 * A client message arriving before the walk needs it waits in an inbox; one
 * the recording has no place for stays there, and after the end of the
 * recording a request is answered `-32601`. Either way it shows up in
 * `unmatched`, which a test asserts is empty to prove the client sent exactly
 * what Codex was recorded receiving. `matched` pairs each recorded client
 * message with the real one, for asserting on params.
 *
 * When a test hangs, `waitingFor` says which client message the replay is
 * still waiting for. */
export class ReplayCodexAppServer extends FakeCodexAppServer {
  readonly fixture: CodexFixture
  readonly matched: ReplayMatch[] = []
  /** Resolves when the recording has been played to its end. */
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
    super({ ...options, initialize: false, unscripted: 'ignore' })
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

  /** Client messages the recording had no place for. */
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

  protected override onClientMessage(message: WireMessage): void {
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
            return
          }
        }
        this.play(entry)
        this.cursor++
      }
    } finally {
      this.busy = false
    }
    if (this.finished || this.exited) this.end()
  }

  /** Take the client message `recorded` waits for out of the inbox. */
  private consume(recorded: WireMessage): boolean {
    const index = this.inbox.findIndex((actual) => matches(recorded, actual))
    if (index === -1) return false
    const [actual] = this.inbox.splice(index, 1)
    if (isWireRequest(recorded)) this.ids.set(String(recorded.id), actual!.id!)
    this.matched.push({ recorded, actual: actual! })
    return true
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

  private end(): void {
    this.cursor = this.fixture.entries.length
    this.finish()
  }
}

function matches(recorded: WireMessage, actual: WireMessage): boolean {
  if (isWireRequest(recorded)) return isWireRequest(actual) && actual.method === recorded.method
  if (isWireNotification(recorded)) return isWireNotification(actual) && actual.method === recorded.method
  return isWireResponse(actual) && String(actual.id) === String(recorded.id)
}
