import { describe, expect, it } from 'vitest'
import {
  ProofEventSchema,
  type Message,
  type ProofEvent,
  type ScopeSnapshot,
} from '@openmanager/protocol'
import { cacheState } from '../src/cache-state'
import { applyEvent, applySnapshot, createInitialState } from '../src/state'
import type { EnvironmentState } from '../src/types'
import { THREAD, delta, threadScope, turnStarted } from './fixtures'

const thread = (state: EnvironmentState) => state.threads[THREAD.threadId]!
const assistant = (state: EnvironmentState) =>
  thread(state)
    .messages.filter((message) => message.role === 'assistant')
    .map((message) => ({ messageId: message.messageId, phase: message.phase }))

/** A delta as the wire carries it, with the phase its message has. */
const phased = (messageId: string, text: string, phase?: string) => {
  const base = delta('turn-1', messageId, text)
  return ProofEventSchema.parse({
    ...base,
    payload: { ...base.payload, ...(phase ? { phase } : {}) },
  }) as ProofEvent
}

const snapshotOf = (state: EnvironmentState, messages: Message[], sequence: number) =>
  ({
    cursor: { scope: threadScope, epoch: 'e', sequence },
    state: {
      thread: THREAD,
      turns: thread(state).turns,
      messages,
      reasoning: [],
      tools: [],
      notices: [],
      order: messages.map((message) => ({
        kind: 'message' as const,
        id: message.messageId,
        turnId: message.turnId,
      })),
      interactions: [],
      listing: {},
      queue: { items: [], pausedBy: null },
    },
  }) as ScopeSnapshot

describe('assistant message phases', () => {
  it('keeps the phase a message opened with as its deltas stream in', () => {
    let state = applyEvent(createInitialState(), turnStarted())
    state = applyEvent(state, phased('message-1', 'Looking ', 'commentary'))
    state = applyEvent(state, phased('message-1', 'around.', 'commentary'))
    state = applyEvent(state, phased('message-2', 'Done.', 'final_answer'))
    state = applyEvent(state, phased('message-3', 'Plain.'))
    expect(assistant(state)).toEqual([
      { messageId: 'message-1', phase: 'commentary' },
      { messageId: 'message-2', phase: 'final_answer' },
      { messageId: 'message-3', phase: undefined },
    ])
    expect(thread(state).messages.find((m) => m.messageId === 'message-3')).not.toHaveProperty(
      'phase',
    )
  })

  it('joins mid-turn from a snapshot that holds the phase, then folds the rest of the message', () => {
    const fresh = applyEvent(createInitialState(), turnStarted())
    const held: Message[] = [
      {
        messageId: 'message-1',
        threadId: THREAD.threadId,
        turnId: 'turn-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Reading.' }],
        phase: 'commentary',
      },
      {
        messageId: 'message-2',
        threadId: THREAD.threadId,
        turnId: 'turn-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'The ans' }],
        phase: 'final_answer',
      },
    ]
    let state = applySnapshot(fresh, snapshotOf(fresh, held, 4))
    state = applyEvent(state, phased('message-2', 'wer.', 'final_answer'))
    expect(assistant(state)).toEqual([
      { messageId: 'message-1', phase: 'commentary' },
      { messageId: 'message-2', phase: 'final_answer' },
    ])
    expect(thread(state).messages[1]?.content).toEqual([{ type: 'text', text: 'The answer.' }])
  })

  it('takes a phase a reload brings for a message it held without one', () => {
    let state = applyEvent(createInitialState(), turnStarted())
    state = applyEvent(state, phased('message-1', 'Done.'))
    const reloaded = thread(state).messages.map((message) =>
      message.role === 'assistant' ? { ...message, phase: 'final_answer' as const } : message,
    )
    state = applySnapshot(state, snapshotOf(state, reloaded, 9))
    expect(assistant(state)).toEqual([{ messageId: 'message-1', phase: 'final_answer' }])
  })

  it('keeps the phase in the cache a reload starts from', () => {
    let state = applyEvent(createInitialState(), turnStarted())
    state = applyEvent(state, phased('message-1', 'Done.', 'final_answer'))
    expect(assistant(cacheState(state))).toEqual([
      { messageId: 'message-1', phase: 'final_answer' },
    ])
  })
})
