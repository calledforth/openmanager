import { createServer, connect, type Server, type Socket } from 'node:net'

/**
 * A TCP proxy that stands in for the network between a browser and the
 * environment. Its URL stays the same while the server child behind it is
 * restarted on a new port.
 *
 * Each direction of each connection is a byte pump: it reads from one socket
 * into a queue of at most `bufferBytes`, plus the one socket read that
 * crossed it (at most 64 KiB), and stops reading when the queue is full, so
 * TCP backpressure reaches the sender the way it does behind cloudflared,
 * which forwards an upgraded connection as a byte stream. The queue drains at
 * `bytesPerSecond` (or as fast as the receiver takes it), after `latencyMs`.
 *
 * WebSocket frames are inspected beside that stream, never instead of it, in
 * both directions: bytes go to the pump as they are read, and the inspector
 * keeps a frame's header and at most the first `INSPECT_HEAD_BYTES` of its
 * payload, so a frame much larger than the bound is never assembled.
 *
 * The one exception is the upstream gate. While a gate is set, an upstream
 * frame within `GATE_HOLD_BUDGET` (the server's own 64 KiB inbound limit) is
 * assembled whole so the gate can decide before the server sees a byte of
 * it; a larger frame streams on ungated. Bytes of a frame being assembled
 * count in `backlog()` as `inspecting`; a frame the gate holds counts in `up`.
 */

export type Direction = 'down' | 'up'

export interface Shape {
  /** Undefined: as fast as the receiving socket takes bytes. */
  bytesPerSecond?: number
  /** Read-ahead bound before the pump stops reading from its source. */
  bufferBytes: number
  latencyMs: number
}

/** Fields of a frame too large to parse whole, read from its head. */
export interface FrameFields {
  type?: string
  name?: string
  requestId?: string
  mode?: string
  reason?: string
  scopeType?: string
  threadId?: string
}

/** One WebSocket frame seen on the wire. */
export interface FrameRecord {
  connection: number
  direction: Direction
  /** Milliseconds since the proxy started, when the frame's last byte was read from its sender. */
  at: number
  opcode: number
  size: number
  /** Text frames whose payload fits the inspector's head, parsed. */
  json?: unknown
  /** Larger text frames: the first value of each field their head names. */
  fields?: FrameFields
  close?: { code: number; reason: string }
}

/** Decides whether an upstream text frame may pass now. */
export type Gate = (text: string, connection: number) => Promise<void> | undefined

const DEFAULT_BUFFER_BYTES = 4 * 1024 * 1024
const TICK_MS = 10
/** Tokens a pump may bank; covers a late timer (Windows ticks at ~16 ms) without bursting. */
const BURST_MS = 50
/** The most of one downstream frame's payload the inspector keeps. */
export const INSPECT_HEAD_BYTES = 64 * 1024
/**
 * The most a gated upstream frame may be, header included: the server's own
 * inbound limit (64 KiB payload). A larger frame streams on ungated; the
 * server would refuse it anyway.
 */
export const GATE_HOLD_BUDGET = 64 * 1024 + 14

interface QueuedChunk {
  data: Buffer
  readyAt: number
  /** Nothing from this chunk on is written until it settles (the gate). */
  barrier?: Promise<void>
}

interface InspectedFrame {
  opcode: number
  size: number
  /** The payload, unmasked, up to the inspector's retain limit. */
  head: Buffer
  /** Whether `head` is the whole payload. */
  whole: boolean
}

/**
 * Follows WebSocket framing over a byte stream, chunk by chunk, and hands
 * every byte on through `forward` as soon as it is read, except:
 *   - up to 14 header bytes and 3 bytes of the HTTP preamble's end, while
 *     they are still incomplete;
 *   - a frame `hold(frame size)` says to hold, which is kept whole (it must
 *     fit `holdBudget`) and handed on with its parsed head at its last byte,
 *     so a gate can decide before the far side sees any of it.
 * Beside that it keeps at most `retain` payload bytes of the frame in
 * progress for inspection. `held` counts every byte it keeps.
 */
class Inspector {
  private phase: 'http' | 'header' | 'payload' = 'http'
  private tail: Buffer = Buffer.alloc(0)
  private header: Buffer = Buffer.alloc(0)
  private opcode = 0
  private remaining = 0
  private size = 0
  private mask: Buffer | null = null
  private maskIndex = 0
  private headParts: Buffer[] = []
  private headBytes = 0
  private rawParts: Buffer[] = []
  private rawBytes = 0
  private holding = false

  constructor(
    private readonly retain: number,
    private readonly onFrame: (frame: InspectedFrame) => void,
    /** Where every byte goes; `frame` is set for a held frame, handed on whole. */
    private readonly forward: (raw: Buffer, frame?: InspectedFrame) => void,
    /** Whether to hold the frame that is starting (its payload is `size` bytes). */
    private readonly hold: (size: number) => boolean = () => false,
    /** The most a held frame may be, header included; larger frames stream. */
    private readonly holdBudget = 0,
  ) {}

  /** Bytes this inspector keeps right now: a held frame, a partial header, the inspection head. */
  get held(): number {
    return this.headBytes + this.rawBytes + this.header.length + this.tail.length
  }

  push(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.length) {
      if (this.phase === 'http') {
        // The upgrade request or response, up to its blank line.
        const rest = chunk.subarray(offset)
        const window = this.tail.length ? Buffer.concat([this.tail, rest]) : rest
        const end = window.indexOf('\r\n\r\n')
        if (end === -1) {
          this.forward(rest)
          this.tail = Buffer.from(window.subarray(Math.max(0, window.length - 3)))
          return
        }
        const consumed = end + 4 - this.tail.length
        this.forward(rest.subarray(0, consumed))
        offset += consumed
        this.tail = Buffer.alloc(0)
        this.phase = 'header'
        continue
      }
      if (this.phase === 'header') {
        const take = Math.min(this.headerLength() - this.header.length, chunk.length - offset)
        this.header = Buffer.concat([this.header, chunk.subarray(offset, offset + take)])
        offset += take
        if (this.header.length < this.headerLength()) continue
        this.startPayload()
        if (this.remaining === 0) this.finishFrame()
        continue
      }
      const take = Math.min(this.remaining, chunk.length - offset)
      const piece = chunk.subarray(offset, offset + take)
      offset += take
      this.remaining -= take
      if (this.holding) {
        this.rawParts.push(piece)
        this.rawBytes += piece.length
      } else this.forward(piece)
      if (this.headBytes < this.retain) {
        const kept = Buffer.from(piece.subarray(0, this.retain - this.headBytes))
        if (this.mask) {
          for (let index = 0; index < kept.length; index++) {
            kept[index]! ^= this.mask[(this.maskIndex + index) % 4]!
          }
        }
        this.headParts.push(kept)
        this.headBytes += kept.length
      }
      this.maskIndex += take
      if (this.remaining === 0) this.finishFrame()
    }
  }

  /** Header bytes needed so far: 2, then the extended length and the mask once known. */
  private headerLength(): number {
    if (this.header.length < 2) return 2
    const code = this.header[1]! & 0x7f
    const masked = (this.header[1]! & 0x80) !== 0
    return 2 + (code === 126 ? 2 : code === 127 ? 8 : 0) + (masked ? 4 : 0)
  }

  private startPayload(): void {
    const code = this.header[1]! & 0x7f
    const masked = (this.header[1]! & 0x80) !== 0
    let offset = 2
    let length = code
    if (code === 126) {
      length = this.header.readUInt16BE(2)
      offset = 4
    } else if (code === 127) {
      length = Number(this.header.readBigUInt64BE(2))
      offset = 10
    }
    this.opcode = this.header[0]! & 0x0f
    this.size = length
    this.remaining = length
    this.mask = masked ? Buffer.from(this.header.subarray(offset, offset + 4)) : null
    this.maskIndex = 0
    // Held only within the budget, and only if its whole payload is inspected,
    // since a gate decides on the whole text.
    this.holding =
      this.header.length + length <= this.holdBudget && length <= this.retain && this.hold(length)
    if (this.holding) {
      this.rawParts = [this.header]
      this.rawBytes = this.header.length
    } else this.forward(this.header)
    this.header = Buffer.alloc(0)
    this.phase = 'payload'
  }

  private finishFrame(): void {
    const head =
      this.headParts.length === 1
        ? this.headParts[0]!
        : Buffer.concat(this.headParts, this.headBytes)
    const frame: InspectedFrame = {
      opcode: this.opcode,
      size: this.size,
      head,
      whole: head.length === this.size,
    }
    this.headParts = []
    this.headBytes = 0
    this.phase = 'header'
    this.onFrame(frame)
    if (this.holding) {
      const raw = Buffer.concat(this.rawParts, this.rawBytes)
      this.rawParts = []
      this.rawBytes = 0
      this.holding = false
      this.forward(raw, frame)
    }
  }
}

/** The first value of each field a frame's head names, for frames too large to parse whole. */
function fieldsOf(head: string): FrameFields {
  const fields: FrameFields = {}
  for (const key of ['type', 'name', 'requestId', 'mode', 'reason'] as const) {
    const value = new RegExp(`"${key}":"([^"]*)"`).exec(head)?.[1]
    if (value !== undefined) fields[key] = value
  }
  const scope = /"scope":\{([^{}]*)\}/.exec(head)?.[1]
  if (scope) {
    const type = /"type":"([^"]*)"/.exec(scope)?.[1]
    const threadId = /"threadId":"([^"]*)"/.exec(scope)?.[1]
    if (type) fields.scopeType = type
    if (threadId) fields.threadId = threadId
  }
  return fields
}

/** One direction of one proxied connection. */
class Pump {
  private queue: QueuedChunk[] = []
  private queued = 0
  private tokens = 0
  private lastTick = performance.now()
  private timer: ReturnType<typeof setTimeout> | undefined
  private waitingDrain = false
  private ended = false
  private finished = false
  /** Barriers still pending, so `idle` can say whether anything is held. */
  private barriers = 0
  /** Bytes handed to the destination socket. */
  delivered = 0

  constructor(
    private readonly source: Socket,
    private readonly destination: Socket,
    private readonly shape: () => Shape,
    private readonly blackholed: () => boolean,
  ) {
    destination.on('drain', () => {
      this.waitingDrain = false
      this.schedule()
    })
  }

  /** Bytes read from the source and not yet written. */
  get backlog(): number {
    return this.queued
  }

  /** Whether everything read has been written and nothing is held. */
  get idle(): boolean {
    return this.queued === 0 && this.barriers === 0
  }

  /** Queue bytes; with `barrier`, they and everything after wait until it settles. */
  push(data: Buffer, barrier?: Promise<void>): void {
    if (data.length === 0) return
    const chunk: QueuedChunk = { data, readyAt: performance.now() + this.shape().latencyMs }
    if (barrier) {
      this.barriers += 1
      chunk.barrier = barrier
      void barrier.finally(() => {
        this.barriers -= 1
        chunk.barrier = undefined
        this.schedule()
      })
    }
    this.queue.push(chunk)
    this.queued += data.length
    if (this.queued >= this.shape().bufferBytes) this.source.pause()
    this.schedule()
  }

  end(): void {
    this.ended = true
    this.schedule()
  }

  schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, 0)
  }

  private flush(): void {
    if (this.destination.destroyed) return
    const now = performance.now()
    const elapsed = now - this.lastTick
    this.lastTick = now
    if (this.blackholed() || this.waitingDrain) {
      // Nothing moves; a blackhole keeps the sockets but forwards nothing.
      this.tokens = 0
      if (this.blackholed() && this.queue.length) this.retry(TICK_MS)
      return
    }
    const { bytesPerSecond } = this.shape()
    if (bytesPerSecond !== undefined) {
      // A small burst allowance keeps the average exact without a tick per byte.
      this.tokens = Math.min(
        this.tokens + (bytesPerSecond * elapsed) / 1000,
        Math.max(1, (bytesPerSecond * BURST_MS) / 1000),
      )
    }
    while (this.queue.length) {
      const head = this.queue[0]!
      if (head.barrier) return
      if (head.readyAt > now) {
        this.retry(Math.max(1, head.readyAt - now))
        return
      }
      let size = head.data.length
      if (bytesPerSecond !== undefined) {
        size = Math.min(size, Math.floor(this.tokens))
        if (size <= 0) {
          this.retry(TICK_MS)
          return
        }
        this.tokens -= size
      }
      const piece = size === head.data.length ? head.data : head.data.subarray(0, size)
      if (size === head.data.length) this.queue.shift()
      else head.data = head.data.subarray(size)
      this.queued -= size
      this.delivered += size
      const flowing = this.destination.write(piece)
      if (this.queued < this.shape().bufferBytes && this.source.isPaused()) this.source.resume()
      if (!flowing) {
        this.waitingDrain = true
        return
      }
    }
    if (this.source.isPaused() && this.queued < this.shape().bufferBytes) this.source.resume()
    if (this.ended && this.queue.length === 0 && !this.finished) {
      this.finished = true
      this.destination.end()
    }
  }

  private retry(delayMs: number): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, delayMs)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.queue = []
    this.queued = 0
  }
}

interface Pair {
  id: number
  client: Socket
  server: Socket
  down: Pump
  up: Pump
  downInspector: Inspector
  upInspector: Inspector
  closed: boolean
}

export interface LinkProxyStats {
  /** Connections accepted since the proxy started (refused ones included). */
  accepted: number
  refused: number
  open: number
  /** Bytes handed to the client (down) and the server (up), all connections, closed ones included. */
  delivered: Record<Direction, number>
}

/** Every application buffer of one connection, in bytes. */
export interface ConnectionBacklog {
  connection: number
  /** Read from the server, not yet written to the client. */
  down: number
  /** Read from the client, not yet written to the server (a held frame included). */
  up: number
  /** Frame bytes the inspectors hold beside (down) or ahead of (up) the pumps. */
  inspecting: number
  /** Bytes written to the client and to the server so far. */
  delivered: Record<Direction, number>
}

export class LinkProxy {
  private readonly listener: Server
  private target = 0
  private readonly pairs = new Map<number, Pair>()
  private nextId = 1
  private shapes: Record<Direction, Shape> = {
    down: { bufferBytes: DEFAULT_BUFFER_BYTES, latencyMs: 0 },
    up: { bufferBytes: DEFAULT_BUFFER_BYTES, latencyMs: 0 },
  }
  private holes = false
  private refusing = false
  private gateFn: Gate | undefined
  private recording = false
  private readonly started = performance.now()
  readonly frames: FrameRecord[] = []
  /** The local port of every connection the proxy opened to a server: the server sees it as the remote port. */
  readonly serverSidePorts = new Set<number>()
  readonly stats: LinkProxyStats = {
    accepted: 0,
    refused: 0,
    open: 0,
    delivered: { down: 0, up: 0 },
  }

  private constructor(listener: Server) {
    this.listener = listener
  }

  static async start(): Promise<LinkProxy> {
    const listener = createServer()
    const proxy = new LinkProxy(listener)
    listener.on('connection', (socket) => proxy.accept(socket))
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', () => {
        listener.removeListener('error', reject)
        resolve()
      })
    })
    return proxy
  }

  get port(): number {
    const address = this.listener.address()
    if (!address || typeof address === 'string') throw new Error('The proxy is not listening.')
    return address.port
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/ws`
  }

  /** Point new connections at a (re)started server. */
  setTarget(port: number): void {
    this.target = port
  }

  /** Limit one direction (or both) to a rate, with a read-ahead buffer. */
  throttle(direction: Direction | 'both', bytesPerSecond: number, bufferBytes: number): void {
    for (const key of direction === 'both' ? (['down', 'up'] as const) : [direction]) {
      this.shapes[key] = { ...this.shapes[key], bytesPerSecond, bufferBytes }
    }
  }

  latency(ms: number): void {
    this.shapes.down = { ...this.shapes.down, latencyMs: ms }
    this.shapes.up = { ...this.shapes.up, latencyMs: ms }
  }

  /** Stop forwarding in both directions; the sockets stay open. */
  blackhole(): void {
    this.holes = true
  }

  unblackhole(): void {
    this.holes = false
    for (const pair of this.pairs.values()) {
      pair.down.schedule()
      pair.up.schedule()
    }
  }

  /** Drop every open connection at once, as a network change does. */
  cut(): void {
    for (const pair of [...this.pairs.values()]) this.drop(pair)
  }

  /** Refuse new connections until `up()`; open ones are left alone. */
  down(): void {
    this.refusing = true
  }

  up(): void {
    this.refusing = false
  }

  /** A healthy link: unthrottled, no latency, nothing held, accepting. */
  heal(): void {
    this.shapes = {
      down: { bufferBytes: DEFAULT_BUFFER_BYTES, latencyMs: 0 },
      up: { bufferBytes: DEFAULT_BUFFER_BYTES, latencyMs: 0 },
    }
    this.gateFn = undefined
    this.refusing = false
    this.unblackhole()
  }

  /** Hold upstream frames the gate answers with a promise, until it settles. */
  gate(gate: Gate | undefined): void {
    this.gateFn = gate
  }

  /** Record every frame from now on (the wire-order probe). */
  record(on: boolean): void {
    this.recording = on
  }

  /** Every application buffer of every open connection (S15 and S16 read these). */
  backlog(): ConnectionBacklog[] {
    return [...this.pairs.values()].map((pair) => ({
      connection: pair.id,
      down: pair.down.backlog,
      up: pair.up.backlog,
      inspecting: pair.downInspector.held + pair.upInspector.held,
      delivered: { down: pair.down.delivered, up: pair.up.delivered },
    }))
  }

  /** Bytes delivered to the client and to the server, over every connection. */
  delivered(): Record<Direction, number> {
    const open = [...this.pairs.values()]
    return {
      down: this.stats.delivered.down + open.reduce((sum, pair) => sum + pair.down.delivered, 0),
      up: this.stats.delivered.up + open.reduce((sum, pair) => sum + pair.up.delivered, 0),
    }
  }

  /** Nothing queued, held or half-inspected on any open connection. */
  drained(): boolean {
    return [...this.pairs.values()].every(
      (pair) =>
        pair.down.idle &&
        pair.up.idle &&
        pair.downInspector.held === 0 &&
        pair.upInspector.held === 0,
    )
  }

  async close(): Promise<void> {
    this.cut()
    await new Promise<void>((resolve) => this.listener.close(() => resolve()))
  }

  private now(): number {
    return Math.round(performance.now() - this.started)
  }

  private accept(client: Socket): void {
    this.stats.accepted += 1
    if (this.refusing || this.target === 0) {
      this.stats.refused += 1
      client.destroy()
      return
    }
    const id = this.nextId++
    const server = connect(this.target, '127.0.0.1')
    server.once('connect', () => {
      if (server.localPort !== undefined) this.serverSidePorts.add(server.localPort)
    })
    client.setNoDelay(true)
    server.setNoDelay(true)
    const down = new Pump(
      server,
      client,
      () => this.shapes.down,
      () => this.holes,
    )
    const up = new Pump(
      client,
      server,
      () => this.shapes.up,
      () => this.holes,
    )
    const downInspector = new Inspector(
      INSPECT_HEAD_BYTES,
      (frame) => {
        if (this.recording) this.frames.push(this.describe(id, 'down', frame))
      },
      (raw) => down.push(raw),
    )
    const upInspector = new Inspector(
      INSPECT_HEAD_BYTES,
      (frame) => {
        if (this.recording) this.frames.push(this.describe(id, 'up', frame))
      },
      (raw, frame) => {
        // A held frame reaches the gate whole; the gate may hold it further.
        const held =
          frame && frame.opcode === 1 && this.gateFn
            ? this.gateFn(frame.head.toString('utf8'), id)
            : undefined
        up.push(raw, held)
      },
      // Only while a gate is set is a frame assembled before it is sent on.
      () => this.gateFn !== undefined,
      GATE_HOLD_BUDGET,
    )
    const pair: Pair = { id, client, server, down, up, downInspector, upInspector, closed: false }
    this.pairs.set(id, pair)
    this.stats.open = this.pairs.size

    // Bytes stream on as they are read; the inspectors only look, except at a gated frame.
    server.on('data', (chunk: Buffer) => downInspector.push(chunk))
    client.on('data', (chunk: Buffer) => upInspector.push(chunk))
    server.on('end', () => down.end())
    client.on('end', () => up.end())
    const destroy = () => this.drop(pair)
    server.on('error', destroy)
    client.on('error', destroy)
    // A clean end flushes what is queued first; anything else drops the pair.
    let closedSides = 0
    const closed = (socket: Socket) => () => {
      closedSides += 1
      if (!socket.readableEnded || closedSides === 2) destroy()
    }
    server.on('close', closed(server))
    client.on('close', closed(client))
  }

  private describe(connection: number, direction: Direction, frame: InspectedFrame): FrameRecord {
    const record: FrameRecord = {
      connection,
      direction,
      at: this.now(),
      opcode: frame.opcode,
      size: frame.size,
    }
    if (frame.opcode === 1) {
      const text = frame.head.toString('utf8')
      if (frame.whole) {
        try {
          record.json = JSON.parse(text)
        } catch {
          record.fields = fieldsOf(text)
        }
      } else record.fields = fieldsOf(text)
    } else if (frame.opcode === 8 && frame.head.length >= 2) {
      record.close = {
        code: frame.head.readUInt16BE(0),
        reason: frame.head.subarray(2).toString('utf8'),
      }
    }
    return record
  }

  private drop(pair: Pair): void {
    if (pair.closed) return
    pair.closed = true
    this.stats.delivered.down += pair.down.delivered
    this.stats.delivered.up += pair.up.delivered
    pair.down.stop()
    pair.up.stop()
    pair.client.destroy()
    pair.server.destroy()
    this.pairs.delete(pair.id)
    this.stats.open = this.pairs.size
  }
}
