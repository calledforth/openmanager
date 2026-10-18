/**
 * The link proxy's own guarantees, against a raw TCP peer (no server child):
 * the read-ahead bound holds for a frame far larger than it, every buffer is
 * counted, bytes arrive intact and in order, inspection still records the
 * frame, and the upstream gate holds a frame until it is released.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { GATE_HOLD_BUDGET, INSPECT_HEAD_BYTES, LinkProxy } from './link-proxy.ts'
import { until } from './harness.ts'

const KiB = 1024
const UPGRADE = 'GET /ws HTTP/1.1\r\nHost: x\r\n\r\n'
const SWITCHED = 'HTTP/1.1 101 Switching Protocols\r\n\r\n'

/** A text frame; masked as a client must send it, unmasked as a server does. */
function frame(payload: Buffer, masked: boolean): Buffer {
  const length = payload.length
  const header =
    length < 126
      ? Buffer.from([0x81, length])
      : length < 65536
        ? Buffer.from([0x81, 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([0x81, 127]), bigLength(length)])
  if (!masked) return Buffer.concat([header, payload])
  header[1]! |= 0x80
  const mask = randomBytes(4)
  const body = Buffer.from(payload)
  for (let index = 0; index < body.length; index++) body[index]! ^= mask[index % 4]!
  return Buffer.concat([header, mask, body])
}

function bigLength(length: number): Buffer {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64BE(BigInt(length))
  return bytes
}

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function peer(onSocket: (socket: Socket) => void): Promise<Server> {
  const server = createServer(onSocket)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return server
}

async function proxyTo(server: Server): Promise<LinkProxy> {
  const proxy = await LinkProxy.start()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  proxy.setTarget(address.port)
  cleanups.push(() => proxy.close())
  return proxy
}

describe('link proxy', () => {
  it('bounds read-ahead for a frame far larger than the bound, and records it', async () => {
    const bound = 64 * KiB
    // 4 MiB of payload whose head names the fields a scenario looks for.
    const prefix =
      '{"type":"response","requestId":"r1","payload":{"mode":"snapshot","reason":"initial",' +
      '"snapshot":{"cursor":{"scope":{"type":"thread","threadId":"t1"}}},"pad":"'
    const big = Buffer.concat([
      Buffer.from(prefix),
      Buffer.alloc(4 * 1024 * KiB - prefix.length, 97),
    ])
    const small = Buffer.from(JSON.stringify({ type: 'event', name: 'after' }))
    const sent = Buffer.concat([Buffer.from(SWITCHED), frame(big, false), frame(small, false)])
    const server = await peer((socket) => {
      socket.once('data', () => socket.end(sent))
    })
    const proxy = await proxyTo(server)
    proxy.record(true)
    proxy.throttle('down', 200 * KiB, bound)

    const received: Buffer[] = []
    const client = connect(proxy.port, '127.0.0.1')
    cleanups.push(() => void client.destroy())
    client.on('data', (chunk: Buffer) => received.push(chunk))
    client.write(UPGRADE)

    let maxQueued = 0
    let maxInspecting = 0
    const started = performance.now()
    await until(
      () => {
        for (const entry of proxy.backlog()) {
          maxQueued = Math.max(maxQueued, entry.down)
          maxInspecting = Math.max(maxInspecting, entry.inspecting)
        }
        return performance.now() - started > 1_000
      },
      'a second of throttled delivery',
      5_000,
      10,
    )
    const deliveredInASecond = proxy.delivered().down
    // The queue never holds more than the bound plus the one read that crossed it.
    expect(maxQueued).toBeLessThanOrEqual(bound + 64 * KiB)
    // The inspector holds a frame's head, never the frame.
    expect(maxInspecting).toBeLessThanOrEqual(INSPECT_HEAD_BYTES + 14)
    // About 200 KiB/s, measured at the proxy's own counter.
    expect(deliveredInASecond).toBeGreaterThan(100 * KiB)
    expect(deliveredInASecond).toBeLessThan(320 * KiB)

    proxy.heal()
    await until(
      () => received.reduce((sum, chunk) => sum + chunk.length, 0) === sent.length,
      'every byte to arrive',
      20_000,
    )
    expect(digest(Buffer.concat(received))).toBe(digest(sent))
    expect(proxy.delivered().down).toBe(sent.length)

    const down = proxy.frames.filter((record) => record.direction === 'down')
    expect(down).toHaveLength(2)
    expect(down[0]).toMatchObject({
      size: big.length,
      fields: { type: 'response', requestId: 'r1', mode: 'snapshot', reason: 'initial' },
    })
    expect(down[0]!.fields).toMatchObject({ scopeType: 'thread', threadId: 't1' })
    expect(down[0]!.json).toBeUndefined()
    expect(down[1]!.json).toEqual({ type: 'event', name: 'after' })
  })

  it('holds a gated upstream frame, and only it and what follows, until released', async () => {
    const seen: Buffer[] = []
    const server = await peer((socket) => socket.on('data', (chunk: Buffer) => seen.push(chunk)))
    const proxy = await proxyTo(server)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let gated = 0
    proxy.gate((text) => {
      if (!text.includes('"hold"')) return undefined
      gated += 1
      return gate
    })
    proxy.record(true)
    const first = frame(Buffer.from('{"name":"pass"}'), true)
    const held = frame(Buffer.from('{"name":"hold"}'), true)
    const after = frame(Buffer.from('{"name":"after"}'), true)
    const client = connect(proxy.port, '127.0.0.1')
    cleanups.push(() => void client.destroy())
    await new Promise<void>((resolve) => client.once('connect', () => resolve()))
    // Split across writes, so frames also arrive in pieces.
    client.write(Buffer.concat([Buffer.from(UPGRADE), first, held.subarray(0, 5)]))
    client.write(Buffer.concat([held.subarray(5), after]))

    const bytes = () => Buffer.concat(seen)
    const beforeHold = Buffer.concat([Buffer.from(UPGRADE), first])
    await until(
      () => gated === 1 && bytes().length === beforeHold.length,
      'the frames before the gate',
    )
    // The held frame and the one after it wait in the pump, counted as backlog.
    await until(
      () => proxy.backlog()[0]?.up === held.length + after.length,
      'the held bytes to queue',
    )
    expect(digest(bytes())).toBe(digest(beforeHold))
    expect(proxy.drained()).toBe(false)

    release()
    const everything = Buffer.concat([beforeHold, held, after])
    await until(() => bytes().length === everything.length, 'the held frames after release')
    expect(digest(bytes())).toBe(digest(everything))
    await until(() => proxy.drained(), 'the proxy to drain')
    expect(
      proxy.frames.filter((record) => record.direction === 'up').map((record) => record.json),
    ).toEqual([{ name: 'pass' }, { name: 'hold' }, { name: 'after' }])
  })

  it('bounds upstream read-ahead too, with and without a gate', async () => {
    const bound = 64 * KiB
    let serverBytes = 0
    const digests = createHash('sha256')
    const server = await peer((socket) =>
      socket.on('data', (chunk: Buffer) => {
        serverBytes += chunk.length
        digests.update(chunk)
      }),
    )
    const proxy = await proxyTo(server)
    proxy.record(true)
    proxy.throttle('up', 200 * KiB, bound)
    const big = frame(Buffer.alloc(4 * 1024 * KiB, 98), true)
    // A frame over the gate's budget streams on, gate or no gate.
    const overBudget = frame(Buffer.alloc(100 * KiB, 99), true)
    const small = frame(Buffer.from('{"name":"hold"}'), true)
    const sent = Buffer.concat([Buffer.from(UPGRADE), big, overBudget, small])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const gated: string[] = []
    proxy.gate((text) => {
      gated.push(text.slice(0, 20))
      return text.includes('"hold"') ? gate : undefined
    })
    const client = connect(proxy.port, '127.0.0.1')
    cleanups.push(() => void client.destroy())
    await new Promise<void>((resolve) => client.once('connect', () => resolve()))
    client.write(sent)

    let maxQueued = 0
    let maxInspecting = 0
    const started = performance.now()
    await until(
      () => {
        for (const entry of proxy.backlog()) {
          maxQueued = Math.max(maxQueued, entry.up)
          maxInspecting = Math.max(maxInspecting, entry.inspecting)
        }
        return performance.now() - started > 1_000
      },
      'a second of throttled upstream',
      5_000,
      10,
    )
    expect(maxQueued).toBeLessThanOrEqual(bound + 64 * KiB)
    // While the gate is set, only frames within its budget are assembled.
    expect(maxInspecting).toBeLessThanOrEqual(INSPECT_HEAD_BYTES + 14 + 3)
    proxy.throttle('up', 100 * 1024 * KiB, 4 * 1024 * KiB)
    const beforeHeld = sent.length - small.length
    await until(() => serverBytes === beforeHeld, 'everything before the held frame')
    // The small frame is held whole by the gate, and counted.
    expect(proxy.backlog()[0]?.up).toBe(small.length)
    expect(gated).toEqual(['{"name":"hold"}'])
    release()
    await until(() => serverBytes === sent.length, 'the held frame after release')
    expect(digests.digest('hex')).toBe(digest(sent))
    expect(
      proxy.frames.filter((record) => record.direction === 'up').map((record) => record.size),
    ).toEqual([4 * 1024 * KiB, 100 * KiB, small.length - 6])
  })

  it('assembles a gated frame within its budget, counted as inspecting', async () => {
    const server = await peer((socket) => socket.resume())
    const proxy = await proxyTo(server)
    proxy.gate(() => undefined)
    const payload = Buffer.alloc(60 * KiB, 100)
    const whole = frame(payload, true)
    const client = connect(proxy.port, '127.0.0.1')
    cleanups.push(() => void client.destroy())
    await new Promise<void>((resolve) => client.once('connect', () => resolve()))
    // All but the last byte: the frame is still being assembled.
    client.write(Buffer.concat([Buffer.from(UPGRADE), whole.subarray(0, whole.length - 1)]))
    await until(
      () => (proxy.backlog()[0]?.inspecting ?? 0) >= whole.length - 1,
      'the partial frame to be held for the gate',
    )
    const held = proxy.backlog()[0]!
    // The raw frame and its inspected copy: the one place the proxy assembles.
    expect(held.inspecting).toBeLessThanOrEqual(GATE_HOLD_BUDGET + INSPECT_HEAD_BYTES)
    expect(held.up).toBe(0)
    client.write(whole.subarray(whole.length - 1))
    await until(() => proxy.drained(), 'the frame to pass')
  })
})
