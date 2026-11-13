import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from '@openmanager/app-core/logic'
import type { QueuedMessage } from '@openmanager/environment-client'

import { pressPrimary, primaryAction, whileBusyOf } from '../src/composer/model'
import { createFixtureThread } from '../src/session/fixture-thread'
import { workingThread } from '../src/session/fixture-threads'
import { waitingQueueOf } from '../src/session/waiting-queue'
import { resolveThreadRow } from '../src/session/thread-rows'

const base = {
  isStreaming: true,
  canInterrupt: true,
  hasContent: false,
  sending: false,
  uploading: false,
  unavailable: null,
  sendBlockedReason: null,
  imageProblem: null,
  planReview: false,
  hasImages: false,
}

const item = (
  queueItemId: string,
  delivery: QueuedMessage['delivery'] = 'queued',
): QueuedMessage => ({
  queueItemId,
  text: `message ${queueItemId}`,
  settings: {},
  delivery,
  createdAt: '2026-11-13T10:00:00.000Z',
})

describe('sending while a turn runs', () => {
  it('queues or steers by this phone’s choice, the other a long press away', () => {
    expect(whileBusyOf({ busy: false, canSteer: true, choice: 'steer', planReview: false })).toBe(
      null,
    )
    expect(whileBusyOf({ busy: true, canSteer: true, choice: 'steer', planReview: false })).toEqual(
      { enter: 'steer', alternate: 'queue' },
    )
    // A turn that cannot take a message: both queue, nothing else offered.
    expect(
      whileBusyOf({ busy: true, canSteer: false, choice: 'steer', planReview: false }),
    ).toEqual({ enter: 'queue', alternate: null })
    // A plan under review turns the field into a change request instead.
    expect(whileBusyOf({ busy: true, canSteer: true, choice: 'queue', planReview: true })).toBe(
      null,
    )
  })

  it('stops while nothing is typed, and queues or steers what is', () => {
    const whileBusy = { enter: 'steer' as const, alternate: 'queue' as const }
    expect(primaryAction({ ...base, whileBusy })).toMatchObject({ kind: 'stop', enabled: true })
    expect(primaryAction({ ...base, whileBusy, hasContent: true })).toMatchObject({
      kind: 'steer',
      enabled: true,
      alternate: 'queue',
    })
    // Busy between turns (queued messages still running): the button waits for words.
    expect(primaryAction({ ...base, isStreaming: false, whileBusy })).toMatchObject({
      kind: 'steer',
      enabled: false,
    })
    // Not busy: an ordinary send.
    expect(primaryAction({ ...base, isStreaming: false, hasContent: true })).toMatchObject({
      kind: 'send',
      alternate: null,
    })
  })

  it('hands the action to the send', () => {
    const send = vi.fn()
    const interrupt = vi.fn()
    pressPrimary(
      { kind: 'queue', enabled: true, reason: null, busy: false, alternate: 'steer' },
      { send, interrupt },
    )
    pressPrimary(
      { kind: 'send', enabled: true, reason: null, busy: false, alternate: null },
      { send, interrupt },
    )
    expect(send.mock.calls).toEqual([['queue'], []])
    expect(interrupt).not.toHaveBeenCalled()
  })
})

describe('steered messages in the transcript', () => {
  it('reads a steered row as waiting, not as an unconfirmed echo', () => {
    const message: UIMessage = {
      externalId: 'send:s1',
      role: 'user',
      isFinal: true,
      sequenceNum: 4,
      optimisticContent: 'use pnpm',
      isOptimistic: true,
      commandId: 's1',
      steer: 'waiting',
    }
    expect(resolveThreadRow(message, null, undefined)).toMatchObject({
      key: 'send:s1',
      content: 'use pnpm',
      queued: false,
      steer: 'waiting',
      queueItemId: 's1',
    })
  })

  it('leaves steered messages out of the queue card, and keeps the card while it says the same', () => {
    const queue = { items: [item('s1', 'steering'), item('q1')], pausedBy: null }
    const first = waitingQueueOf({ queue, steeredQueueIds: ['s1'] })
    expect(first.items.map((entry) => entry.queueItemId)).toEqual(['q1'])
    expect(waitingQueueOf({ queue: { ...queue }, steeredQueueIds: ['s1'] }, first)).toBe(first)
    expect(waitingQueueOf({ queue: { items: [], pausedBy: null } })).toEqual({
      items: [],
      pausedBy: null,
    })
  })

  it('sends a steer now in the sample chat: the same row becomes the prompt of the next turn', async () => {
    vi.useFakeTimers()
    try {
      const fixture = createFixtureThread(workingThread(Date.now()))
      const rowOf = () =>
        fixture
          .getMessages()
          .find((message) => (message.rowKey ?? message.externalId) === 'send:fixture-steer')
      expect(rowOf()).toMatchObject({ steer: 'waiting' })

      const sent = fixture.followUps.sendNow('fixture-steer')
      // Given back to run next.
      expect(rowOf()).toMatchObject({ steer: 'next' })
      await vi.advanceTimersByTimeAsync(700)
      await sent

      const row = rowOf()
      expect(row).toBeDefined()
      expect(row!.steer).toBeUndefined()
      expect(row!.isOptimistic).toBeFalsy()
      const thread = fixture.getThread()!
      expect(thread.turns.at(-2)?.state).toBe('interrupted')
      expect(thread.turns.at(-1)).toMatchObject({ state: 'running', commandId: 'fixture-steer' })
      expect(waitingQueueOf(thread).items.map((entry) => entry.queueItemId)).toEqual([
        'fixture-queued',
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
