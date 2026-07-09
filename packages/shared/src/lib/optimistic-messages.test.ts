import { describe, it, expect } from 'vitest'
import {
  countUserMessages,
  createOptimisticUserMessage,
  maxSequenceNum,
  mergeMessages,
  nextOptimisticSequenceNum,
  reconcileOptimisticMessages,
  type OptimisticUserMessage,
  type PersistedMessageMeta,
} from './optimistic-messages'

function persisted(
  externalId: string,
  role: string,
  sequenceNum: number,
  isFinal = true,
): PersistedMessageMeta {
  return { externalId, role, sequenceNum, isFinal }
}

describe('sequence numbering', () => {
  it('maxSequenceNum returns -1 for an empty list', () => {
    expect(maxSequenceNum([])).toBe(-1)
  })

  it('nextOptimisticSequenceNum orders after all messages, offset by pending count', () => {
    const messages = [persisted('a', 'user', 0), persisted('b', 'assistant', 1)]
    expect(nextOptimisticSequenceNum(messages, 0)).toBe(2)
    expect(nextOptimisticSequenceNum(messages, 1)).toBe(3)
    expect(nextOptimisticSequenceNum([], 0)).toBe(0)
  })
})

describe('reconcileOptimisticMessages', () => {
  const opt = (id: string): OptimisticUserMessage => createOptimisticUserMessage(id, id, 0)

  it('leaves the queue untouched when previous count is null', () => {
    const queue = [opt('x')]
    expect(reconcileOptimisticMessages(queue, null, 5)).toBe(queue)
  })

  it('drops one optimistic message per newly persisted user message', () => {
    const queue = [opt('x'), opt('y')]
    expect(reconcileOptimisticMessages(queue, 0, 1).map((m) => m.externalId)).toEqual(['y'])
  })

  it('does not drop when the persisted count did not grow', () => {
    const queue = [opt('x')]
    expect(reconcileOptimisticMessages(queue, 2, 2)).toBe(queue)
  })

  it('never slices beyond the queue length', () => {
    const queue = [opt('x')]
    expect(reconcileOptimisticMessages(queue, 0, 3)).toEqual([])
  })
})

describe('mergeMessages', () => {
  it('returns persisted-only projection when there are no optimistic messages', () => {
    const messages = [persisted('a', 'user', 0), persisted('b', 'assistant', 1)]
    const merged = mergeMessages(messages, [])
    expect(merged.map((m) => m.externalId)).toEqual(['a', 'b'])
    expect(merged.every((m) => m.isOptimistic === undefined)).toBe(true)
  })

  it('interleaves optimistic messages by sequenceNum', () => {
    const messages = [persisted('a', 'user', 0), persisted('b', 'assistant', 1)]
    const optimistic = createOptimisticUserMessage('local-1', 'hi', 2)
    const merged = mergeMessages(messages, [optimistic])
    expect(merged.map((m) => m.externalId)).toEqual(['a', 'b', 'local-1'])
    expect(merged[2].isOptimistic).toBe(true)
    expect(merged[2].optimisticContent).toBe('hi')
  })
})

describe('countUserMessages', () => {
  it('counts only user-role entries', () => {
    expect(
      countUserMessages([
        { role: 'user' },
        { role: 'assistant' },
        { role: 'user' },
        { role: 'permission' },
      ]),
    ).toBe(2)
  })
})

describe('end-to-end optimistic lifecycle', () => {
  it('adds an optimistic message then clears it once persisted', () => {
    // Start with a single persisted user + assistant pair.
    let messages: PersistedMessageMeta[] = [persisted('u0', 'user', 0), persisted('a0', 'assistant', 1)]
    let userCount = countUserMessages(messages)

    // User sends a new message -> queue optimistic.
    const seq = nextOptimisticSequenceNum(messages, 0)
    let optimistic = [createOptimisticUserMessage('local-1', 'again', seq)]
    let merged = mergeMessages(messages, optimistic)
    expect(merged.map((m) => m.externalId)).toEqual(['u0', 'a0', 'local-1'])

    // Backend persists the user message -> reconcile drops the optimistic entry.
    messages = [...messages, persisted('u1', 'user', 2)]
    const newUserCount = countUserMessages(messages)
    optimistic = reconcileOptimisticMessages(optimistic, userCount, newUserCount)
    userCount = newUserCount
    merged = mergeMessages(messages, optimistic)
    expect(optimistic).toEqual([])
    expect(merged.map((m) => m.externalId)).toEqual(['u0', 'a0', 'u1'])
  })
})
