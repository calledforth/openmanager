import {
  sameScope,
  type DurableEvent,
  type ProofEvent,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import { isTerminal, type DurableProofEvent, type EventRepository } from './event-repository.ts'
import { isRefusal } from './write-errors.ts'

export const STREAM_BATCH_MAX_EVENTS = 128
export const STREAM_BATCH_MAX_BYTES = 16 * 1024
export const STREAM_BATCH_MAX_WAIT_MS = 100

export interface StreamingEventBatcherOptions {
  maxEvents?: number
  maxBytes?: number
  maxWaitMs?: number
  /** Timer failures retain the batch for the next flush, close, or append. */
  onError?: (error: unknown) => void
  /**
   * A write refused for what it says (write-errors.ts), dropped so it cannot
   * hold back every write behind it. Called once per dropped event; it is a
   * bug in that event's producer, so report it loudly.
   */
  onRefused?: (error: unknown, event: ProofEvent) => void
}

/** Thrown by a batch's write to say the write itself is refused, not the disk. */
export class RefusedBatch extends Error {
  override name = 'RefusedBatch'
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

/** What `append` throws when the event it was given was refused and dropped. */
export class DroppedWrite extends Error {
  override name = 'DroppedWrite'
  readonly events: readonly ProofEvent[]
  constructor(events: readonly ProofEvent[], cause: unknown) {
    super(`Refused and dropped: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    })
    this.events = events
  }
}

/** Route streaming batches through the matching atomic repository operation. */
export function createRepositoryEventBatcher(
  repository: EventRepository,
  publish: (records: readonly DurableEvent[]) => void = () => undefined,
  options: StreamingEventBatcherOptions = {},
) {
  return createStreamingEventBatcher<DurableProofEvent>((scope, events) => {
    const last = events.at(-1)
    let records: DurableEvent[]
    try {
      records =
        scope.type === 'thread' && last && isTerminal(last)
          ? repository.finalizeTurn(scope, events)
          : repository.appendEvents(scope, events)
    } catch (error) {
      throw isRefusal(error) ? new RefusedBatch(error) : error
    }
    // A failed publish is not a refusal: the rows are written, and the retry
    // re-publishes them with their cursors.
    publish(records)
  }, options)
}

/**
 * Coalesce token-sized text deltas and flush on either the byte or time limit.
 * Non-stream events are ordering barriers and flush buffered deltas first.
 *
 * An appended event is never dropped. When a write fails, the failed batch
 * is kept and retried first, and every event appended after it waits in
 * order behind it, so `append` throwing means "not durable yet", never "not
 * taken". Callers may record an event in memory once it is appended: it
 * reaches the rows before anything appended after it, or nothing after it
 * does either (docs/sync-foundations.md I11).
 *
 * The exception is a write refused for what it says (`RefusedBatch`): it can
 * never succeed, so it is dropped and reported (`onRefused`) instead of
 * blocking the queue. A refused batch of several events is written one event
 * at a time, so only the refused events go.
 */
export function createStreamingEventBatcher<E extends ProofEvent = ProofEvent>(
  flush: (scope: SubscriptionScope, events: readonly E[]) => void,
  options: StreamingEventBatcherOptions = {},
) {
  const maxEvents = options.maxEvents ?? STREAM_BATCH_MAX_EVENTS
  const maxBytes = options.maxBytes ?? STREAM_BATCH_MAX_BYTES
  const maxWaitMs = options.maxWaitMs ?? STREAM_BATCH_MAX_WAIT_MS
  let buffered: E[] = []
  let pending: E[] | undefined
  /** Appended and not yet in a batch, oldest first: they wait behind a failed write. */
  const queued: E[] = []
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const clear = () => {
    pending = undefined
    buffered = []
    bytes = 0
  }

  /** Report and forget refused events, then say so to whoever is draining. */
  const drop = (refused: readonly E[], error: unknown): never => {
    for (const event of refused) options.onRefused?.(error, event)
    throw new DroppedWrite(refused, error)
  }

  /**
   * Write a refused batch one event at a time: the events the rows accept
   * land, in order, and only the refused ones are dropped. A transient
   * failure part way keeps the rest as the batch to retry.
   */
  const isolate = (batch: readonly E[], refusal: unknown): never => {
    const refused: E[] = []
    for (const [index, event] of batch.entries()) {
      try {
        flush(event.scope, [event])
      } catch (error) {
        if (error instanceof RefusedBatch) {
          refused.push(event)
          continue
        }
        pending = batch.slice(index)
        buffered = [...pending]
        for (const item of refused) options.onRefused?.(refusal, item)
        throw error
      }
    }
    return drop(refused, refusal)
  }

  const flushBuffered = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (buffered.length === 0) return
    // Freeze the coalesced batch across retries, including publish-after-commit failures.
    pending ??= coalesceDeltas(buffered)
    const batch = pending
    try {
      flush(batch[0]!.scope, batch)
    } catch (error) {
      if (!(error instanceof RefusedBatch)) throw error
      clear()
      if (batch.length === 1) drop(batch, error.cause)
      isolate(batch, error.cause)
    }
    clear()
  }

  /**
   * Move the oldest queued event into the batch. A write it must follow
   * goes first; if that write throws, the event stays queued.
   */
  const take = (event: E) => {
    const streamEvent = event.name === 'message.delta' || event.name === 'message.reasoning'
    const otherScope = buffered.length > 0 && !sameScope(buffered[0]!.scope, event.scope)
    if (isTerminal(event) ? otherScope : !streamEvent || otherScope) flushBuffered()
    queued.shift()
    buffered.push(event)
    if (isTerminal(event)) {
      flushBuffered()
      return
    }
    bytes += Buffer.byteLength(JSON.stringify(event.payload), 'utf8')
    if (!streamEvent || bytes >= maxBytes || buffered.length >= maxEvents) flushBuffered()
    else if (!timer) {
      timer = setTimeout(() => {
        try {
          drain()
          flushBuffered()
        } catch (error) {
          options.onError?.(error)
        }
      }, maxWaitMs)
    }
  }

  /**
   * Finish a failed batch before changing its event IDs, then take what
   * waited behind it. A dropped write does not stop the drain: the events
   * behind it go on, and the drops come back for the caller to judge.
   */
  const drain = (): DroppedWrite[] => {
    const dropped: DroppedWrite[] = []
    const step = (run: () => void) => {
      try {
        run()
      } catch (error) {
        if (!(error instanceof DroppedWrite)) throw error
        dropped.push(error)
      }
    }
    if (pending) step(flushBuffered)
    while (queued.length > 0) step(() => take(queued[0]!))
    return dropped
  }

  /** Everything appended, written; drops were reported and are not the caller's. */
  const flushAll = () => {
    drain()
    try {
      flushBuffered()
    } catch (error) {
      if (!(error instanceof DroppedWrite)) throw error
    }
  }

  return {
    append(event: E) {
      queued.push(event)
      // Only this event's own drop is this caller's failure.
      const own = drain().find((drop) => drop.events.some((item) => item.eventId === event.eventId))
      if (own) throw own
    },
    flush: flushAll,
    close: flushAll,
  }
}

function coalesceDeltas<E extends ProofEvent>(events: readonly E[]): E[] {
  const result: E[] = []
  for (const event of events) {
    const previous = result.at(-1)
    if (
      previous?.name === 'message.delta' &&
      event.name === 'message.delta' &&
      previous.payload.messageId === event.payload.messageId &&
      previous.payload.turnId === event.payload.turnId &&
      previous.payload.role === event.payload.role &&
      previous.payload.content.type === 'text' &&
      event.payload.content.type === 'text'
    ) {
      result[result.length - 1] = {
        ...previous,
        timestamp: event.timestamp,
        payload: {
          ...previous.payload,
          content: {
            type: 'text',
            text: previous.payload.content.text + event.payload.content.text,
          },
        },
      } as E
    } else if (
      previous?.name === 'message.reasoning' &&
      event.name === 'message.reasoning' &&
      previous.payload.messageId === event.payload.messageId &&
      previous.payload.turnId === event.payload.turnId &&
      previous.payload.phase === 'delta' &&
      event.payload.phase === 'delta' &&
      previous.payload.content?.type === 'text' &&
      event.payload.content?.type === 'text'
    ) {
      result[result.length - 1] = {
        ...previous,
        timestamp: event.timestamp,
        payload: {
          ...previous.payload,
          content: {
            type: 'text',
            text: previous.payload.content.text + event.payload.content.text,
          },
          ...(event.payload.tokens === undefined ? {} : { tokens: event.payload.tokens }),
        },
      } as E
    } else {
      result.push(event)
    }
  }
  return result
}
