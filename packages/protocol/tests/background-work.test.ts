import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_TASKS_MAX,
  DurableEventSchema,
  ProofCommandSchemas,
  ProofEventSchemas,
  ProofResponseSchemas,
  SessionSummarySchema,
  requiredAccess,
} from '@openmanager/protocol'
import { environmentScope, proofEvents, threadScope } from './proof-fixtures.js'
import { replayCursor } from './replay-fixtures.js'

const TASK = { taskId: 'task-1', kind: 'shell', description: 'Run the build' }
const started = ProofEventSchemas['turn.started'].parse(
  proofEvents.find((event) => event.name === 'turn.started'),
)

describe('background work on the wire', () => {
  it('announces a turn the provider began by itself without a user message', () => {
    const { userMessage: _prompt, ...prompted } = started.payload
    const unprompted = { ...prompted, turn: { ...prompted.turn, origin: 'background' } }
    const event = ProofEventSchemas['turn.started'].parse({ ...started, payload: unprompted })
    expect(event.payload.userMessage).toBeUndefined()
    // The two travel together: no prompt without a reason, no reason with one.
    expect(
      ProofEventSchemas['turn.started'].safeParse({ ...started, payload: prompted }).success,
    ).toBe(false)
    expect(
      ProofEventSchemas['turn.started'].safeParse({
        ...started,
        payload: { ...started.payload, turn: unprompted.turn },
      }).success,
    ).toBe(false)
    // Durable like any other turn: replay has no message to check the scope of.
    expect(
      DurableEventSchema.safeParse({ cursor: { ...replayCursor, scope: threadScope }, event })
        .success,
    ).toBe(true)
    // A turn a command started always has the message that asked for it.
    expect(
      ProofResponseSchemas['turn.send'].safeParse({
        type: 'response',
        requestId: 'send',
        payload: unprompted,
      }).success,
    ).toBe(false)
  })

  it('carries the live tasks on the summary and on session.updated', () => {
    const updated = {
      type: 'event',
      eventId: 'event-1',
      timestamp: '2026-09-30T10:00:00.000Z',
      name: 'session.updated',
      scope: environmentScope,
      payload: { sessionId: 'session-1', backgroundTasks: [TASK], status: 'running' },
    }
    expect(ProofEventSchemas['session.updated'].parse(updated).payload.backgroundTasks).toEqual([
      TASK,
    ])
    // An emptied roster is a report too; saying nothing is not.
    expect(
      ProofEventSchemas['session.updated'].parse({
        ...updated,
        payload: { sessionId: 'session-1', backgroundTasks: [] },
      }).payload.backgroundTasks,
    ).toEqual([])
    const summary = {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      title: null,
      status: 'running',
      providerId: 'claude',
      updatedAt: '2026-09-30T10:00:00.000Z',
    }
    expect(SessionSummarySchema.parse(summary).backgroundTasks).toBeUndefined()
    expect(
      SessionSummarySchema.parse({ ...summary, backgroundTasks: [TASK] }).backgroundTasks,
    ).toEqual([TASK])
    expect(
      SessionSummarySchema.safeParse({
        ...summary,
        backgroundTasks: [{ ...TASK, kind: 'daemon' }],
      }).success,
    ).toBe(false)
  })

  it('stops every task or the ones named, and needs the agent grant', () => {
    const stop = (payload: unknown) =>
      ProofCommandSchemas['session.background.stop'].safeParse({
        type: 'command',
        requestId: 'stop',
        name: 'session.background.stop',
        payload,
      }).success
    expect(stop({ sessionId: 'session-1' })).toBe(true)
    expect(stop({ sessionId: 'session-1', taskIds: ['task-1'] })).toBe(true)
    // Naming nothing is not the same request as naming no list at all.
    expect(stop({ sessionId: 'session-1', taskIds: [] })).toBe(false)
    expect(
      stop({
        sessionId: 'session-1',
        taskIds: Array.from({ length: BACKGROUND_TASKS_MAX + 1 }, (_, index) => `task-${index}`),
      }),
    ).toBe(false)
    expect(requiredAccess('session.background.stop')).toBe('agent')
  })
})
