import type { QueuedMessage, ThreadQueuePause } from '@openmanager/environment-client'

/** Why a queue waits for the user, as its header says it. */
export const QUEUE_PAUSE_REASON: Record<ThreadQueuePause, string> = {
  failure: 'the turn failed',
  restart: 'the server restarted',
}

/** What a waiting message says, on one line: its text, else that it is only images. */
export function queuedMessagePreview(item: Pick<QueuedMessage, 'text' | 'artifactIds'>): string {
  const text = item.text.replace(/\s+/g, ' ').trim()
  if (text) return text
  const images = item.artifactIds?.length ?? 0
  return images === 1 ? 'An image' : `${images} images`
}
