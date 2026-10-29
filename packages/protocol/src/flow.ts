/**
 * Flow control and framing (docs/sync-foundations.md §7.2, §7.3). Transport
 * parameters, not content limits: nothing here changes what is delivered.
 *
 * - **Framing.** A message that fits in one fragment is an ordinary text
 *   frame. A larger one is split into binary frames, each a one-byte flag
 *   (`FRAGMENT_MORE`, then `FRAGMENT_LAST`) followed by a slice of the
 *   message's UTF-8 bytes. A fragmented message is never interleaved with
 *   any other frame, so the receiver keeps at most one partial message.
 * - **Fragment size** follows the measured delivery rate, so each frame
 *   reaches a slow browser within about two seconds:
 *   `clamp(rate × 2 s, 512 B, 8 KiB)`, 1 KiB until the first rate is known.
 *   The 8 KiB cap bounds how long a frame already in flight takes when the
 *   link suddenly slows (8 s at 1 KiB/s), inside the 45 s watchdog.
 * - **Window.** The server writes only while `sent − acked < window`. The
 *   window starts at 256 KiB and follows twice the measured bandwidth-delay
 *   product, up to 4 MiB.
 * - **Acks.** The client reports the total payload bytes it has received:
 *   every 32 KiB, or 250 ms after the last frame while anything is
 *   unacknowledged. Payload bytes are a text frame's UTF-8 length and a binary
 *   frame's byte length, flag included.
 * - **Backlog.** Live frames of subscribed scopes waiting for the window are
 *   bounded at 1 MiB per connection; past it, the affected scopes go lagging
 *   and catch up from the log once the queue drains.
 */
export const FLOW_POLICY = Object.freeze({
  initialWindowBytes: 256 * 1024,
  maxWindowBytes: 4 * 1024 * 1024,
  backlogBytes: 1024 * 1024,
  minFragmentBytes: 512,
  initialFragmentBytes: 1024,
  maxFragmentBytes: 8 * 1024,
  /** How long one fragment should take to arrive at the measured rate. */
  fragmentTargetMs: 2_000,
  ackEveryBytes: 32 * 1024,
  ackDelayMs: 250,
})

/** First byte of a binary frame: more fragments of this message follow. */
export const FRAGMENT_MORE = 1
/** First byte of a binary frame: the last fragment of this message. */
export const FRAGMENT_LAST = 2

/**
 * The frame size to cut at for a measured delivery rate (bytes per second),
 * flag byte included. `undefined` until the first rate is measured.
 */
export function fragmentBytesFor(rateBytesPerSecond: number | undefined): number {
  if (rateBytesPerSecond === undefined || !Number.isFinite(rateBytesPerSecond)) {
    return FLOW_POLICY.initialFragmentBytes
  }
  const target = Math.floor((rateBytesPerSecond * FLOW_POLICY.fragmentTargetMs) / 1000)
  return Math.min(FLOW_POLICY.maxFragmentBytes, Math.max(FLOW_POLICY.minFragmentBytes, target))
}

/**
 * The UTF-8 length of a string, without encoding it. `JSON.stringify` never
 * produces a lone surrogate, so every surrogate here is half of a pair.
 */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** A binary frame that does not follow the framing rules. */
export class FramingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FramingError'
  }
}

/**
 * Reassembles one connection's fragmented messages. `push` takes each binary
 * frame in arrival order and returns the whole message's UTF-8 bytes at its
 * last fragment, `undefined` before.
 */
export class FragmentAssembler {
  private parts: Uint8Array[] = []
  private length = 0

  /** A message is partly received. */
  get partial(): boolean {
    return this.parts.length > 0
  }

  push(frame: Uint8Array): Uint8Array | undefined {
    if (frame.byteLength < 1) throw new FramingError('An empty binary frame.')
    const flag = frame[0]
    if (flag !== FRAGMENT_MORE && flag !== FRAGMENT_LAST) {
      throw new FramingError(`Unknown fragment flag ${String(flag)}.`)
    }
    const slice = frame.subarray(1)
    this.parts.push(slice)
    this.length += slice.byteLength
    if (flag === FRAGMENT_MORE) return undefined
    const parts = this.parts
    const length = this.length
    this.reset()
    if (parts.length === 1) return parts[0]!
    const whole = new Uint8Array(length)
    let offset = 0
    for (const part of parts) {
      whole.set(part, offset)
      offset += part.byteLength
    }
    return whole
  }

  reset(): void {
    this.parts = []
    this.length = 0
  }
}
