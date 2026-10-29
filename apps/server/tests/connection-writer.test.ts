import { describe, expect, it } from 'vitest'
import {
  FLOW_POLICY,
  FragmentAssembler,
  type Cursor,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import { createConnectionWriter, type LaggingScope } from '../src/connection-writer.ts'

const KiB = 1024
const scope: SubscriptionScope = {
  type: 'thread',
  environmentId: 'env',
  sessionId: 'session',
  threadId: 'thread',
}
const cursor = (sequence: number): Cursor => ({ scope, epoch: 'epoch', sequence })

/** A socket that records frames and what a browser would reassemble from them. */
function harness(options: { onCatchupReady?: (lagging: LaggingScope[]) => void } = {}) {
  let clock = 0
  const frames: Array<{ kind: 'text' | 'binary'; bytes: number }> = []
  const messages: string[] = []
  const assembler = new FragmentAssembler()
  const writer = createConnectionWriter({
    now: () => clock,
    socket: {
      sendText(text) {
        frames.push({ kind: 'text', bytes: Buffer.byteLength(text) })
        messages.push(text)
      },
      sendBinary(frame) {
        frames.push({ kind: 'binary', bytes: frame.byteLength })
        const whole = assembler.push(new Uint8Array(frame))
        if (whole) messages.push(new TextDecoder().decode(whole))
      },
    },
    ...(options.onCatchupReady ? { onCatchupReady: options.onCatchupReady } : {}),
  })
  return {
    writer,
    frames,
    messages,
    tick: (ms: number) => {
      clock += ms
    },
    /** The browser acknowledges everything written so far. */
    ackAll: () => writer.ack(writer.stats().sent),
  }
}

const big = (bytes: number, fill = 'x') => JSON.stringify({ text: fill.repeat(bytes) })

describe('connection writer: framing', () => {
  it('sends a small message as one text frame and a large one as fragments, intact', () => {
    const { writer, frames, messages, ackAll, tick } = harness()
    writer.enqueueResponse('{"type":"response","requestId":"a","payload":null}')
    const large = big(100 * KiB, 'é')
    writer.enqueueResponse(large)
    while (writer.stats().queued > 0) {
      tick(10)
      ackAll()
    }
    expect(frames[0]!.kind).toBe('text')
    expect(frames.slice(1).every((frame) => frame.kind === 'binary')).toBe(true)
    expect(messages).toEqual(['{"type":"response","requestId":"a","payload":null}', large])
  })

  it.each([1, 300, 10 * KiB, 1_000 * KiB, 100_000 * KiB])(
    'never writes a frame over 8 KiB, whatever the measured rate (%d B/s)',
    (rate) => {
      const { writer, frames, tick, ackAll } = harness()
      writer.enqueueResponse(big(2_000 * KiB))
      // Acks arrive at the given rate, so the writer measures it.
      for (let step = 0; step < 2_000 && writer.stats().queued > 0; step++) {
        tick(Math.max(1, Math.round((8 * KiB * 1000) / rate)))
        ackAll()
      }
      expect(Math.max(...frames.map((frame) => frame.bytes))).toBeLessThanOrEqual(
        FLOW_POLICY.maxFragmentBytes,
      )
    },
  )

  it('sizes fragments to about two seconds of the measured rate', () => {
    const { writer, frames, tick } = harness()
    writer.enqueueResponse(big(200 * KiB))
    // 1 KiB per second: each ack covers what was written a second earlier.
    for (let step = 0; step < 20; step++) {
      tick(1000)
      writer.ack(Math.min(writer.stats().sent, (step + 1) * KiB))
    }
    const later = frames.slice(-5).map((frame) => frame.bytes)
    for (const bytes of later) expect(bytes).toBeLessThanOrEqual(4 * KiB)
  })
})

describe('connection writer: the window', () => {
  it('never has more than a window (plus one frame) unacknowledged', () => {
    const { writer } = harness()
    for (let index = 0; index < 100; index++) writer.enqueueResponse(big(50 * KiB))
    const stats = writer.stats()
    expect(stats.inFlight).toBeLessThanOrEqual(stats.window + FLOW_POLICY.maxFragmentBytes)
    expect(stats.window).toBe(FLOW_POLICY.initialWindowBytes)
    expect(stats.queued).toBeGreaterThan(0)
  })

  it('grows the window to twice the bandwidth-delay product, up to 4 MiB', () => {
    const { writer, tick } = harness()
    for (let index = 0; index < 400; index++) writer.enqueueResponse(big(50 * KiB))
    // 10 MB/s with 200 ms between write and ack: BDP 2 MB, so the window caps.
    let acked = 0
    for (let step = 0; step < 100; step++) {
      tick(200)
      acked = writer.stats().sent
      writer.ack(acked)
    }
    expect(writer.stats().window).toBeGreaterThan(FLOW_POLICY.initialWindowBytes)
    expect(writer.stats().window).toBeLessThanOrEqual(FLOW_POLICY.maxWindowBytes)
  })

  it('refuses an ack for bytes never sent', () => {
    const { writer } = harness()
    writer.enqueueResponse('{"x":1}')
    expect(writer.ack(writer.stats().sent + 1)).toBe(false)
    expect(writer.ack(writer.stats().sent)).toBe(true)
  })
})

describe('connection writer: backlog, lagging and catch-up', () => {
  it('goes lagging past the bound, at the last cursor it was sure to deliver, and drops the queue', () => {
    const { writer, messages } = harness()
    // No acks: the window fills, then the backlog.
    writer.enqueueResponse(big(300 * KiB), { subscriptionId: 'sub', cursor: cursor(10) })
    let sequence = 10
    let queued = true
    while (queued) {
      sequence += 1
      queued = writer.enqueueScoped('sub', big(16 * KiB), cursor(sequence))
    }
    const stats = writer.stats()
    expect(stats.lagging).toEqual(['sub'])
    expect(stats.queuedScoped).toBe(0)
    // Nothing more is queued for a lagging subscription.
    expect(writer.enqueueScoped('sub', '{}', cursor(sequence + 1))).toBe(false)
    // The notice is queued behind the answer still being written.
    expect(messages.some((text) => text.includes('subscription.lagging'))).toBe(false)
  })

  it('catches up once the queue drains, and delivers live frames again after the catch-up', () => {
    const ready: LaggingScope[][] = []
    let writerRef: ReturnType<typeof createConnectionWriter> | undefined
    const { writer, messages, tick, ackAll } = harness({
      onCatchupReady: (lagging) => {
        ready.push(lagging)
        for (const { subscriptionId } of lagging) {
          writerRef!.resume(subscriptionId)
          writerRef!.enqueueResponse(
            JSON.stringify({
              type: 'event',
              name: 'subscription.catchup',
              payload: { subscriptionId },
            }),
            { subscriptionId, cursor: cursor(99) },
          )
        }
      },
    })
    writerRef = writer
    let sequence = 0
    while (writer.enqueueScoped('sub', big(16 * KiB), cursor(++sequence))) {
      // fill until the bound trips
    }
    expect(writer.stats().lagging).toEqual(['sub'])
    for (let step = 0; step < 200 && ready.length === 0; step++) {
      tick(50)
      ackAll()
    }
    expect(ready).toHaveLength(1)
    // The cursor is the last record actually written before the cut.
    const lastWritten = ready[0]![0]!.cursor
    expect(lastWritten?.sequence).toBeGreaterThan(0)
    expect(lastWritten!.sequence).toBeLessThan(sequence)
    for (let step = 0; step < 200 && writer.stats().queued > 0; step++) {
      tick(50)
      ackAll()
    }
    const names = messages.map((text) => JSON.parse(text) as { name?: string })
    const lagging = names.findIndex((message) => message.name === 'subscription.lagging')
    const catchup = names.findIndex((message) => message.name === 'subscription.catchup')
    expect(lagging).toBeGreaterThan(0)
    expect(catchup).toBeGreaterThan(lagging)
    expect(writer.enqueueScoped('sub', '{"live":true}', cursor(100))).toBe(true)
    tick(50)
    ackAll()
    expect(messages.at(-1)).toBe('{"live":true}')
  })

  it('cuts every subscription with frames in the queue, and keeps responses and readings', () => {
    const { writer } = harness()
    writer.enqueueResponse(big(400 * KiB))
    writer.enqueueScoped('small', '{"s":1}', cursor(1))
    writer.enqueueReading('health:a', '{"h":1}')
    while (writer.enqueueScoped('busy', big(16 * KiB))) {
      // fill
    }
    expect(writer.stats().lagging.sort()).toEqual(['busy', 'small'])
    expect(writer.stats().queued).toBeGreaterThan(0)
  })

  it('coalesces readings of one key to the newest', () => {
    const { writer, messages, tick, ackAll } = harness()
    writer.enqueueResponse(big(400 * KiB))
    writer.enqueueReading('health:a', '{"h":1}')
    writer.enqueueReading('health:b', '{"h":"b"}')
    writer.enqueueReading('health:a', '{"h":2}')
    for (let step = 0; step < 100 && writer.stats().queued > 0; step++) {
      tick(50)
      ackAll()
    }
    expect(messages.slice(1)).toEqual(['{"h":"b"}', '{"h":2}'])
  })

  it('keeps memory bounded when the downstream is half dead (no acks at all)', () => {
    const { writer } = harness()
    let sequence = 0
    for (let index = 0; index < 5_000; index++) {
      writer.enqueueScoped(`sub-${index % 3}`, big(4 * KiB), cursor(++sequence))
    }
    const stats = writer.stats()
    expect(stats.inFlight).toBeLessThanOrEqual(stats.window + FLOW_POLICY.maxFragmentBytes)
    expect(stats.queuedScoped).toBeLessThanOrEqual(FLOW_POLICY.backlogBytes)
    // Queued = scoped frames under the bound, plus three small lagging notices.
    expect(stats.queued).toBeLessThan(FLOW_POLICY.backlogBytes + 4 * KiB)
  })

  it('release drops a subscription and its queued frames', () => {
    const { writer } = harness()
    writer.enqueueResponse(big(400 * KiB))
    writer.enqueueScoped('sub', big(8 * KiB), cursor(1))
    writer.release('sub')
    expect(writer.stats().queuedScoped).toBe(0)
  })
})

describe('connection writer: keepalive', () => {
  it('is written when asked, but never inside a fragmented message', () => {
    const { writer, frames } = harness()
    expect(writer.keepalive()).toBe(true)
    expect(frames).toEqual([{ kind: 'text', bytes: '{"type":"keepalive"}'.length }])
    writer.enqueueResponse(big(400 * KiB))
    expect(writer.keepalive()).toBe(false)
  })
})
