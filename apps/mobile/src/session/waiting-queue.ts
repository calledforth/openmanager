/**
 * The chat's queue as the dock's card shows it, pure so it is tested without
 * a screen: what waits for the next turn, less the steered messages (they
 * stand in the transcript, where they will land).
 */
import type { QueuedMessage, ThreadQueue, ThreadState } from '@openmanager/environment-client'

const NO_ITEMS: readonly QueuedMessage[] = []
export const EMPTY_WAITING_QUEUE: WaitingQueue = { items: NO_ITEMS, pausedBy: null }

/** What waits for the next turn, as this card shows it: the queue less its steered messages. */
export interface WaitingQueue {
  items: readonly QueuedMessage[]
  pausedBy: ThreadQueue['pausedBy']
}

/**
 * The chat's queue as the card shows it: steered messages are left out
 * (they stand in the transcript, where they will land). The same object
 * while it says the same thing, so a streamed token re-renders nothing.
 */
export function waitingQueueOf(
  thread: Pick<ThreadState, 'queue' | 'steeredQueueIds'> | null | undefined,
  previous: WaitingQueue = EMPTY_WAITING_QUEUE,
): WaitingQueue {
  const queue = thread?.queue
  if (!queue) return EMPTY_WAITING_QUEUE
  const steered = thread.steeredQueueIds
  const items = steered
    ? queue.items.filter((item) => !steered.includes(item.queueItemId))
    : queue.items
  const same =
    previous.pausedBy === queue.pausedBy &&
    previous.items.length === items.length &&
    previous.items.every((item, index) => item === items[index])
  if (same) return previous
  return items.length === 0 && !queue.pausedBy
    ? EMPTY_WAITING_QUEUE
    : { items, pausedBy: queue.pausedBy }
}
