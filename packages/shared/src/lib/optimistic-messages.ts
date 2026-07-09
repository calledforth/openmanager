// Pure reducer for the optimistic user-message merge (plan Phase 2), extracted
// from the desktop `active-session-provider` so it can be unit-tested without
// React/Convex. Optimistic user messages are appended locally, ordered by a
// synthetic sequenceNum, and cleared as the persisted user-message count grows.

export interface PersistedMessageMeta {
  externalId: string
  role: string
  isFinal?: boolean
  sequenceNum: number
}

export interface OptimisticUserMessage {
  externalId: string
  role: 'user'
  isFinal: true
  sequenceNum: number
  optimisticContent: string
  isOptimistic: true
}

export interface MergedMessage {
  externalId: string
  role: string
  isFinal?: boolean
  sequenceNum: number
  optimisticContent?: string
  isOptimistic?: boolean
}

export function maxSequenceNum(messages: ReadonlyArray<{ sequenceNum: number }>): number {
  return messages.reduce((max, message) => Math.max(max, message.sequenceNum), -1)
}

// Sequence number for the next optimistic message: strictly after every known
// message, offset by the count of optimistic messages already queued.
export function nextOptimisticSequenceNum(
  messages: ReadonlyArray<{ sequenceNum: number }>,
  pendingOptimisticCount: number,
): number {
  return maxSequenceNum(messages) + pendingOptimisticCount + 1
}

export function createOptimisticUserMessage(
  externalId: string,
  content: string,
  sequenceNum: number,
): OptimisticUserMessage {
  return {
    externalId,
    role: 'user',
    isFinal: true,
    sequenceNum,
    optimisticContent: content,
    isOptimistic: true,
  }
}

export function countUserMessages(messages: ReadonlyArray<{ role: string }>): number {
  return messages.filter((message) => message.role === 'user').length
}

// Drop optimistic messages that the backend has now persisted. `null` previous
// count means "not yet initialised" (e.g. right after a session change) and
// leaves the queue untouched.
export function reconcileOptimisticMessages<T>(
  optimistic: T[],
  previousUserCount: number | null,
  currentUserCount: number,
): T[] {
  if (previousUserCount === null) return optimistic
  const ackedCount = currentUserCount - previousUserCount
  if (ackedCount <= 0) return optimistic
  return optimistic.slice(Math.min(ackedCount, optimistic.length))
}

// Merge persisted metadata with the optimistic queue, ordered by sequenceNum.
export function mergeMessages(
  persisted: ReadonlyArray<PersistedMessageMeta>,
  optimistic: ReadonlyArray<OptimisticUserMessage>,
): MergedMessage[] {
  const base: MergedMessage[] = persisted.map((message) => ({
    externalId: message.externalId,
    role: message.role,
    isFinal: message.isFinal,
    sequenceNum: message.sequenceNum,
  }))
  if (optimistic.length === 0) return base
  return [...base, ...optimistic].sort((left, right) => left.sequenceNum - right.sequenceNum)
}
