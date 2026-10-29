import { Buffer } from 'node:buffer'
import {
  FLOW_POLICY,
  FRAGMENT_LAST,
  FRAGMENT_MORE,
  fragmentBytesFor,
  type Cursor,
} from '@openmanager/protocol/node'

/**
 * One connection's outbound side (docs/sync-foundations.md §7.2): a queue in
 * the order the server produced its frames, a send window of unacknowledged
 * bytes, rate-sized fragments, and the backlog bound that turns a scope whose
 * live frames outrun the link into a lagging one instead of closing the
 * socket or growing without bound.
 *
 * Kinds of frame:
 * - `response`: command answers, replay and catch-up answers, lagging notices.
 *   Never dropped. One may advance a subscription's cursor (a replay answer).
 * - `scoped`: a live record (with its cursor) or transient of a subscription.
 *   Bounded: past `backlogBytes` of them queued, every subscription with
 *   frames in the queue goes lagging and its queued frames are dropped.
 * - `reading`: a current reading (provider health, the device list). Never
 *   dropped; a newer reading of the same key replaces a queued older one.
 *
 * Pure apart from its `socket` and clock: no timers, no `ws`.
 */
export interface WriterSocket {
  /** One whole message as a text frame. */
  sendText(text: string): void
  /** One fragment: a flag byte and a slice of the message's UTF-8 bytes. */
  sendBinary(frame: Buffer): void
}

export interface WriterPolicy {
  initialWindowBytes: number
  maxWindowBytes: number
  backlogBytes: number
}

export interface LaggingScope {
  subscriptionId: string
  /** The last cursor of the scope this connection was sure to deliver; null if none. */
  cursor: Cursor | null
}

export interface WriterStats {
  /** Bytes queued and not yet written (every kind). */
  queued: number
  /** Bytes of scoped live frames queued, which the backlog bound counts. */
  queuedScoped: number
  /** Bytes written and not yet acknowledged. */
  inFlight: number
  window: number
  fragmentBytes: number
  /** Measured delivery rate, bytes per second, once known. */
  rate: number | undefined
  sent: number
  acked: number
  lagging: string[]
}

type Item =
  | {
      kind: 'response'
      text: string
      bytes: number
      advances?: { subscriptionId: string; cursor: Cursor }
    }
  | { kind: 'scoped'; text: string; bytes: number; subscriptionId: string; cursor?: Cursor }
  | { kind: 'reading'; text: string; bytes: number; key: string }

/** A message whose fragments are being written; nothing else is written until it is done. */
type HalfWritten = { bytes: Buffer; offset: number }

/** How long a round-trip sample counts toward the minimum. */
const RTT_SAMPLE_WINDOW_MS = 10_000

export function createConnectionWriter(options: {
  socket: WriterSocket
  now: () => number
  policy?: Partial<WriterPolicy>
  /**
   * Called when lagging subscriptions can be caught up: the scoped queue has
   * drained below half the bound and the window is open. The caller builds
   * each catch-up, calls `resume`, and queues it with `enqueueResponse`.
   */
  onCatchupReady?: (lagging: LaggingScope[]) => void
}) {
  const policy: WriterPolicy = {
    initialWindowBytes: FLOW_POLICY.initialWindowBytes,
    maxWindowBytes: FLOW_POLICY.maxWindowBytes,
    backlogBytes: FLOW_POLICY.backlogBytes,
    ...options.policy,
  }
  const { socket, now } = options
  const queue: Item[] = []
  let partial: HalfWritten | undefined
  let queuedBytes = 0
  let queuedScopedBytes = 0
  let sent = 0
  let acked = 0
  let window = policy.initialWindowBytes
  let rate: number | undefined
  let lastAckAt: number | undefined
  /** Written frames not yet acknowledged: where each ends, and when it was written. */
  const marks: Array<{ end: number; at: number }> = []
  const rttSamples: Array<{ at: number; rtt: number }> = []
  let lastWriteAt = now()
  /** Per subscription, the newest cursor this connection will certainly deliver. */
  const promised = new Map<string, Cursor>()
  const lagging = new Map<string, Cursor | null>()
  let pumping = false
  let catchingUp = false

  const byteLength = (text: string) => Buffer.byteLength(text, 'utf8')
  const fragmentBytes = () => fragmentBytesFor(rate)

  const remove = (predicate: (item: Item) => boolean) => {
    for (let index = queue.length - 1; index >= 0; index--) {
      const item = queue[index]!
      if (!predicate(item)) continue
      queue.splice(index, 1)
      queuedBytes -= item.bytes
      if (item.kind === 'scoped') queuedScopedBytes -= item.bytes
    }
  }

  const written = (bytes: number) => {
    sent += bytes
    lastWriteAt = now()
    marks.push({ end: sent, at: lastWriteAt })
  }

  /** Write while the window allows, in order; a fragmented message is never interleaved. */
  const pump = () => {
    if (pumping) return
    pumping = true
    try {
      for (;;) {
        if (sent - acked >= window) break
        if (partial) {
          const slice = Math.min(fragmentBytes() - 1, partial.bytes.byteLength - partial.offset)
          const last = partial.offset + slice >= partial.bytes.byteLength
          const frame = Buffer.allocUnsafe(slice + 1)
          frame[0] = last ? FRAGMENT_LAST : FRAGMENT_MORE
          partial.bytes.copy(frame, 1, partial.offset, partial.offset + slice)
          partial.offset += slice
          if (last) partial = undefined
          socket.sendBinary(frame)
          written(frame.byteLength)
          continue
        }
        const item = queue.shift()
        if (!item) break
        queuedBytes -= item.bytes
        if (item.kind === 'scoped') {
          queuedScopedBytes -= item.bytes
          if (item.cursor) promised.set(item.subscriptionId, item.cursor)
        }
        if (item.bytes <= fragmentBytes()) {
          socket.sendText(item.text)
          written(item.bytes)
        } else {
          partial = { bytes: Buffer.from(item.text, 'utf8'), offset: 0 }
        }
      }
    } finally {
      pumping = false
    }
    maybeCatchUp()
  }

  const maybeCatchUp = () => {
    if (catchingUp || lagging.size === 0 || !options.onCatchupReady) return
    if (queuedScopedBytes >= policy.backlogBytes / 2 || sent - acked >= window) return
    catchingUp = true
    try {
      options.onCatchupReady(
        [...lagging].map(([subscriptionId, cursor]) => ({ subscriptionId, cursor })),
      )
    } finally {
      catchingUp = false
    }
    // A catch-up queued above may already fit the window.
    pump()
  }

  /** Every subscription with live frames in the queue goes lagging (§7.2 point 2). */
  const cut = (also: string) => {
    const affected = new Set<string>([also])
    for (const item of queue) if (item.kind === 'scoped') affected.add(item.subscriptionId)
    remove((item) => item.kind === 'scoped' && affected.has(item.subscriptionId))
    for (const subscriptionId of affected) {
      const cursor = promised.get(subscriptionId) ?? null
      lagging.set(subscriptionId, cursor)
      const text = JSON.stringify({
        type: 'event',
        name: 'subscription.lagging',
        payload: { subscriptionId, cursor },
      })
      queue.push({ kind: 'response', text, bytes: byteLength(text) })
      queuedBytes += byteLength(text)
    }
  }

  return {
    /** A command answer, a replay or catch-up answer: never dropped. */
    enqueueResponse(text: string, advances?: { subscriptionId: string; cursor: Cursor }) {
      const bytes = byteLength(text)
      queue.push({ kind: 'response', text, bytes, ...(advances ? { advances } : {}) })
      queuedBytes += bytes
      if (advances) promised.set(advances.subscriptionId, advances.cursor)
      pump()
    },

    /**
     * A live frame of a subscription. Returns false when it was not queued:
     * the subscription is lagging, or this frame took the backlog past its
     * bound and the subscription went lagging with it.
     */
    enqueueScoped(subscriptionId: string, text: string, cursor?: Cursor): boolean {
      if (lagging.has(subscriptionId)) return false
      const bytes = byteLength(text)
      if (queuedScopedBytes + bytes > policy.backlogBytes) {
        cut(subscriptionId)
        pump()
        return false
      }
      queue.push({ kind: 'scoped', text, bytes, subscriptionId, ...(cursor ? { cursor } : {}) })
      queuedBytes += bytes
      queuedScopedBytes += bytes
      pump()
      return true
    },

    /** A current reading; a queued older one of the same key is replaced. */
    enqueueReading(key: string, text: string) {
      remove((item) => item.kind === 'reading' && item.key === key)
      const bytes = byteLength(text)
      queue.push({ kind: 'reading', text, bytes, key })
      queuedBytes += bytes
      pump()
    },

    /** The client acknowledged `received` bytes in total. False if it claims more than was sent. */
    ack(received: number): boolean {
      if (received > sent) return false
      if (received <= acked) return true
      const at = now()
      let oldest: number | undefined
      let newest: number | undefined
      while (marks.length > 0 && marks[0]!.end <= received) {
        const mark = marks.shift()!
        oldest ??= mark.at
        newest = mark.at
      }
      const newly = received - acked
      // The delivery interval starts when the link was last known busy: the
      // previous ack, or the write of the oldest byte this ack covers.
      const from = Math.max(lastAckAt ?? oldest ?? at, oldest ?? at)
      const interval = Math.max(1, at - from)
      const sample = (newly * 1000) / interval
      rate = rate === undefined ? sample : rate * 0.7 + sample * 0.3
      if (newest !== undefined) {
        rttSamples.push({ at, rtt: Math.max(1, at - newest) })
        while (rttSamples.length > 0 && at - rttSamples[0]!.at > RTT_SAMPLE_WINDOW_MS) {
          rttSamples.shift()
        }
      }
      if (rttSamples.length > 0) {
        const rtt = Math.min(...rttSamples.map((sample) => sample.rtt))
        const bdp = (rate * rtt) / 1000
        window = Math.min(policy.maxWindowBytes, Math.max(policy.initialWindowBytes, 2 * bdp))
      }
      acked = received
      lastAckAt = at
      pump()
      return true
    },

    /**
     * Write a keepalive now, unless a fragmented message is half-written (it
     * must not be split). It ignores the window: it is a few bytes, and it is
     * what tells a browser the server is alive while acks are late.
     */
    keepalive(): boolean {
      if (partial) return false
      const text = '{"type":"keepalive"}'
      socket.sendText(text)
      written(byteLength(text))
      return true
    },

    /** A lagging subscription's catch-up is being queued: deliver its live frames again. */
    resume(subscriptionId: string) {
      lagging.delete(subscriptionId)
    },

    /** The subscription ended: forget it and drop its queued live frames. */
    release(subscriptionId: string) {
      lagging.delete(subscriptionId)
      promised.delete(subscriptionId)
      remove((item) => item.kind === 'scoped' && item.subscriptionId === subscriptionId)
    },

    get lastWriteAt() {
      return lastWriteAt
    },

    stats(): WriterStats {
      return {
        queued: queuedBytes + (partial ? partial.bytes.byteLength - partial.offset : 0),
        queuedScoped: queuedScopedBytes,
        inFlight: sent - acked,
        window,
        fragmentBytes: fragmentBytes(),
        rate,
        sent,
        acked,
        lagging: [...lagging.keys()],
      }
    },
  }
}

export type ConnectionWriter = ReturnType<typeof createConnectionWriter>
