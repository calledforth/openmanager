import { createServer, connect, type Server, type Socket } from 'node:net'

/**
 * A TCP proxy that stands in for the network between a browser and the
 * environment. Its URL stays the same while the server child behind it is
 * restarted on a new port.
 *
 * Each direction of each connection is a pump: it reads from one socket into
 * a buffer of at most `bufferBytes` and stops reading when the buffer is full,
 * so TCP backpressure reaches the sender the way it does behind cloudflared's
 * flow-controlled path. It writes the buffer out at `bytesPerSecond` (or as
 * fast as the receiver takes it), after `latencyMs`.
 *
 * The proxy also parses WebSocket frames in both directions without changing
 * a byte: downstream frames can be recorded (the wire-order probe), and an
 * upstream frame can be held by a gate until a test releases it.
 */

export type Direction = 'down' | 'up'

export interface Shape {
  /** Undefined: as fast as the receiving socket takes bytes. */
  bytesPerSecond?: number
  /** Read-ahead bound before the pump stops reading from its source. */
  bufferBytes: number
  latencyMs: number
}

/** One WebSocket frame seen on the wire. */
export interface FrameRecord {
  connection: number
  direction: Direction
  /** Milliseconds since the proxy started, when the frame was read from its sender. */
  at: number
  opcode: number
  size: number
  /** Text frames under 8 MiB, parsed; the frame's head otherwise. */
  json?: unknown
  head?: string
  close?: { code: number; reason: string }
}

/** Decides whether an upstream text frame may pass now. */
export type Gate = (text: string, connection: number) => Promise<void> | undefined

const DEFAULT_BUFFER_BYTES = 4 * 1024 * 1024
const TICK_MS = 10
/** Tokens a pump may bank; covers a late timer (Windows ticks at ~16 ms) without bursting. */
const BURST_MS = 50
const RECORD_JSON_MAX = 8 * 1024 * 1024

interface QueuedChunk {
  data: Buffer
  readyAt: number
}

class FrameParser {
  private buffer: Buffer = Buffer.alloc(0)
  private headerDone = false

  constructor(
    private readonly masked: boolean,
    /** Called with each complete frame, and with the raw bytes that carried it. */
    private readonly onUnit: (unit: { raw: Buffer; frame?: ParsedFrame }) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      if (!this.headerDone) {
        const end = this.buffer.indexOf('\r\n\r\n')
        if (end === -1) return
        const raw = this.buffer.subarray(0, end + 4)
        this.buffer = this.buffer.subarray(end + 4)
        this.headerDone = true
        this.onUnit({ raw })
        continue
      }
      const frame = parseFrame(this.buffer)
      if (!frame) return
      const raw = this.buffer.subarray(0, frame.length)
      this.buffer = this.buffer.subarray(frame.length)
      this.onUnit({ raw, frame: { ...frame, payload: unmask(frame, raw, this.masked) } })
    }
  }
}

interface ParsedFrame {
  fin: boolean
  opcode: number
  length: number
  headerLength: number
  payloadLength: number
  maskOffset: number | null
  payload: Buffer
}

function parseFrame(buffer: Buffer): Omit<ParsedFrame, 'payload'> | null {
  if (buffer.length < 2) return null
  const first = buffer[0]!
  const second = buffer[1]!
  const maskedBit = (second & 0x80) !== 0
  let payloadLength = second & 0x7f
  let offset = 2
  if (payloadLength === 126) {
    if (buffer.length < 4) return null
    payloadLength = buffer.readUInt16BE(2)
    offset = 4
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null
    payloadLength = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskOffset = maskedBit ? offset : null
  if (maskedBit) offset += 4
  const length = offset + payloadLength
  if (buffer.length < length) return null
  return {
    fin: (first & 0x80) !== 0,
    opcode: first & 0x0f,
    length,
    headerLength: offset,
    payloadLength,
    maskOffset,
  }
}

function unmask(frame: Omit<ParsedFrame, 'payload'>, raw: Buffer, expectMask: boolean): Buffer {
  const payload = Buffer.from(raw.subarray(frame.headerLength, frame.length))
  if (frame.maskOffset === null || !expectMask) return payload
  const mask = raw.subarray(frame.maskOffset, frame.maskOffset + 4)
  for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4]!
  return payload
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
  private held: Promise<void> | undefined
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

  push(data: Buffer): void {
    if (data.length === 0) return
    this.queue.push({ data, readyAt: performance.now() + this.shape().latencyMs })
    this.queued += data.length
    if (this.queued >= this.shape().bufferBytes) this.source.pause()
    this.schedule()
  }

  /** Hold everything after the current queue until `until` settles. */
  hold(until: Promise<void>): void {
    const previous = this.held
    const chained = (previous ? previous.then(() => until) : until).finally(() => {
      if (this.held === chained) this.held = undefined
      this.schedule()
    })
    this.held = chained
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
    if (this.blackholed() || this.held || this.waitingDrain) {
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
  closed: boolean
}

export interface LinkProxyStats {
  /** Connections accepted since the proxy started (refused ones included). */
  accepted: number
  refused: number
  open: number
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
  readonly stats: LinkProxyStats = { accepted: 0, refused: 0, open: 0 }

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

  /** Bytes read from the server and not yet handed to the client, per open connection. */
  backlog(): Array<{ connection: number; down: number; up: number }> {
    return [...this.pairs.values()].map((pair) => ({
      connection: pair.id,
      down: pair.down.backlog,
      up: pair.up.backlog,
    }))
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
    const pair: Pair = { id, client, server, down, up, closed: false }
    this.pairs.set(id, pair)
    this.stats.open = this.pairs.size

    const downParser = new FrameParser(false, ({ raw, frame }) => {
      if (frame && this.recording) this.frames.push(this.describe(id, 'down', frame))
      down.push(raw)
    })
    const upParser = new FrameParser(true, ({ raw, frame }) => {
      if (frame && this.recording) this.frames.push(this.describe(id, 'up', frame))
      const held =
        frame && frame.opcode === 1 && this.gateFn
          ? this.gateFn(frame.payload.toString('utf8'), id)
          : undefined
      up.push(raw)
      // The frame that matched waits too: the server must not see it yet.
      if (held) up.hold(held)
    })
    server.on('data', (chunk: Buffer) => downParser.push(chunk))
    client.on('data', (chunk: Buffer) => upParser.push(chunk))
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

  private describe(connection: number, direction: Direction, frame: ParsedFrame): FrameRecord {
    const record: FrameRecord = {
      connection,
      direction,
      at: this.now(),
      opcode: frame.opcode,
      size: frame.payloadLength,
    }
    if (frame.opcode === 1) {
      if (frame.payload.length <= RECORD_JSON_MAX) {
        try {
          record.json = JSON.parse(frame.payload.toString('utf8'))
        } catch {
          record.head = frame.payload.subarray(0, 200).toString('utf8')
        }
      } else record.head = frame.payload.subarray(0, 200).toString('utf8')
    } else if (frame.opcode === 8 && frame.payload.length >= 2) {
      record.close = {
        code: frame.payload.readUInt16BE(0),
        reason: frame.payload.subarray(2).toString('utf8'),
      }
    }
    return record
  }

  private drop(pair: Pair): void {
    if (pair.closed) return
    pair.closed = true
    pair.down.stop()
    pair.up.stop()
    pair.client.destroy()
    pair.server.destroy()
    this.pairs.delete(pair.id)
    this.stats.open = this.pairs.size
  }
}
