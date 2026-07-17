import { describe, expect, it } from 'vitest'
import {
  mergePersistedAndOptimisticMessages,
  shouldPreserveOptimisticMessages,
  type UIMessage,
} from './active-session-provider'

describe('optimistic session handoff', () => {
  it('keeps optimistic content attached while the persisted message body is loading', () => {
    const persisted: UIMessage[] = [
      {
        externalId: 'agent_usr_1',
        role: 'user',
        isFinal: true,
        sequenceNum: 0,
      },
    ]
    const optimistic: UIMessage[] = [
      {
        externalId: 'agent_usr_1',
        role: 'user',
        isFinal: true,
        sequenceNum: 0,
        optimisticContent: 'Ship the seamless transition',
        optimisticJobId: 'job-1',
        isOptimistic: true,
      },
    ]

    expect(mergePersistedAndOptimisticMessages(persisted, optimistic)).toEqual([
      {
        ...persisted[0],
        optimisticContent: 'Ship the seamless transition',
        optimisticAttachments: undefined,
        optimisticJobId: 'job-1',
        isOptimistic: false,
      },
    ])
  })

  it('keeps the draft message only when the new session adopts that draft', () => {
    expect(shouldPreserveOptimisticMessages(null, 'session-1', 'session-1')).toBe(true)
    expect(shouldPreserveOptimisticMessages(null, 'session-2', 'session-1')).toBe(false)
    expect(shouldPreserveOptimisticMessages('session-1', 'session-2', 'session-2')).toBe(false)
  })
})
