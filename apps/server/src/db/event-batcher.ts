import {
  sameScope,
  type DurableEvent,
  type ProofEvent,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import { isTerminal, type DurableProofEvent, type EventRepository } from './event-repository.ts'

export const STREAM_BATCH_MAX_BYTES = 16 * 1024
export const STREAM_BATCH_MAX_WAIT_MS = 100

export interface StreamingEventBatcherOptions {
  maxBytes?: number
  maxWaitMs?: number
  /** Timer failures retain the batch for the next flush, close, or append. */
  onError?: (error: unknown) => void
}

/** Route streaming batches through the matching atomic repository operation. */
export function createRepositoryEventBatcher(
  repository: EventRepository,
  publish: (records: readonly DurableEvent[]) => void = () => undefined,
  options: StreamingEventBatcherOptions = {},
) {
  return createStreamingEventBatcher<DurableProofEvent>((scope, events) => {
    const last = events.at(-1)
    const records =
      scope.type === 'thread' && last && isTerminal(last)
        ? repository.finalizeTurn(scope, events)
        : repository.appendEvents(scope, events)
    publish(records)
  }, options)
}

/**
 * Coalesce token-sized text deltas and flush on either the byte or time limit.
 * Non-stream events are ordering barriers and flush buffered deltas first.
 */
export function createStreamingEventBatcher<E extends ProofEvent = ProofEvent>(
  flush: (scope: SubscriptionScope, events: readonly E[]) => void,
  options: StreamingEventBatcherOptions = {},
) {
  const maxBytes = options.maxBytes ?? STREAM_BATCH_MAX_BYTES
  const maxWaitMs = options.maxWaitMs ?? STREAM_BATCH_MAX_WAIT_MS
  let buffered: E[] = []
  let pending: E[] | undefined
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const flushBuffered = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (buffered.length === 0) return
    // Freeze the coalesced batch across retries, including publish-after-commit failures.
    pending ??= coalesceDeltas(buffered)
    flush(pending[0]!.scope, pending)
    pending = undefined
    buffered = []
    bytes = 0
  }

  return {
    append(event: E) {
      // Finish a failed batch before accepting more input or changing its event IDs.
      if (pending) flushBuffered()
      const streamEvent = event.name === 'message.delta' || event.name === 'message.reasoning'
      if (isTerminal(event)) {
        if (buffered.length > 0 && !sameScope(buffered[0]!.scope, event.scope)) {
          flushBuffered()
        }
        buffered.push(event)
        flushBuffered()
        return
      }
      if (!streamEvent || (buffered.length > 0 && !sameScope(buffered[0]!.scope, event.scope))) {
        flushBuffered()
      }
      buffered.push(event)
      bytes += Buffer.byteLength(JSON.stringify(event.payload), 'utf8')
      if (!streamEvent || bytes >= maxBytes) flushBuffered()
      else if (!timer) {
        timer = setTimeout(() => {
          try {
            flushBuffered()
          } catch (error) {
            options.onError?.(error)
          }
        }, maxWaitMs)
      }
    },
    flush: flushBuffered,
    close: flushBuffered,
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
