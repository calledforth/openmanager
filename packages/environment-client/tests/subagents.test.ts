import { describe, expect, it } from 'vitest'
import { EMPTY_THREAD_QUEUE, type ProofEvent, type Subagent } from '@openmanager/protocol'
import { createMockEnvironmentClient } from '../src/mock'
import {
  applyEvent,
  applySessionCreated,
  applySnapshot,
  createInitialState,
  selectSubagent,
  selectSubagentOfSession,
  selectThreadSubagents,
} from '../src/state'
import {
  SESSION,
  SESSION_CREATED,
  THREAD,
  WORKSPACE,
  environmentScope,
  event,
  threadScope,
} from './fixtures'

const subagent = (patch: Partial<Subagent> & Pick<Subagent, 'subagentId'>): Subagent => ({
  parentSessionId: SESSION.sessionId,
  turnId: 'turn-1',
  toolCallId: `call-${patch.subagentId}`,
  depth: 1,
  origin: 'native',
  providerId: 'claude',
  title: 'Find the callers',
  status: 'running',
  background: false,
  promptable: false,
  stoppable: true,
  stats: {},
  startedAt: '2026-11-18T10:00:00.000Z',
  updatedAt: '2026-11-18T10:00:00.000Z',
  ...patch,
})

const updated = (record: Subagent) =>
  event<Extract<ProofEvent, { name: 'subagent.updated' }>>({
    name: 'subagent.updated',
    scope: threadScope,
    payload: { subagent: record },
  })

const snapshot = (subagents?: Subagent[]) => ({
  cursor: { scope: threadScope, epoch: 'epoch-1', sequence: 4 },
  state: {
    thread: THREAD,
    turns: [],
    messages: [],
    reasoning: [],
    tools: [],
    notices: [],
    order: [],
    interactions: [],
    listing: {},
    queue: EMPTY_THREAD_QUEUE,
    ...(subagents ? { subagents } : {}),
  },
})

describe('subagent state', () => {
  it('files each record by its id, oldest start first', () => {
    const later = subagent({ subagentId: 'b', startedAt: '2026-11-18T10:00:05.000Z' })
    const earlier = subagent({ subagentId: 'a' })
    let state = applyEvent(createInitialState(), updated(later))
    state = applyEvent(state, updated(earlier))
    expect(selectThreadSubagents(state, THREAD.threadId).map((item) => item.subagentId)).toEqual([
      'a',
      'b',
    ])
    expect(selectSubagent(state, THREAD.threadId, 'b')).toEqual(later)
  })

  it('keeps the newest record: a repeat or an older one changes nothing', () => {
    const running = subagent({ subagentId: 'a', activity: 'Reading auth.ts' })
    const done = subagent({
      subagentId: 'a',
      status: 'completed',
      result: 'Three callers.',
      updatedAt: '2026-11-18T10:01:00.000Z',
    })
    const once = applyEvent(createInitialState(), updated(running))
    const settled = applyEvent(once, updated(done))
    expect(selectSubagent(settled, THREAD.threadId, 'a')?.status).toBe('completed')

    // Arriving late, the running record is older than the one held.
    expect(applyEvent(settled, updated(running))).toBe(settled)
    // The same record again hands readers the list they hold.
    const again = applyEvent(settled, updated({ ...done, stats: {} }))
    expect(selectThreadSubagents(again, THREAD.threadId)).toBe(
      selectThreadSubagents(settled, THREAD.threadId),
    )
  })

  it('takes the snapshot list, keeping a held record that is newer', () => {
    const newer = subagent({
      subagentId: 'a',
      status: 'waiting',
      waitingOn: 'permission',
      updatedAt: '2026-11-18T10:02:00.000Z',
    })
    const held = applyEvent(createInitialState(), updated(newer))
    const stale = subagent({ subagentId: 'a' })
    const other = subagent({ subagentId: 'b' })
    const state = applySnapshot(held, snapshot([stale, other]))
    const listed = selectThreadSubagents(state, THREAD.threadId)
    expect(listed.map((item) => item.subagentId)).toEqual(['a', 'b'])
    expect(listed[0]).toBe(selectSubagent(held, THREAD.threadId, 'a'))
  })

  it('drops what a snapshot no longer lists, and keeps the list when one says nothing', () => {
    const held = applyEvent(createInitialState(), updated(subagent({ subagentId: 'a' })))
    const emptied = applySnapshot(held, snapshot([]))
    expect(selectThreadSubagents(emptied, THREAD.threadId)).toEqual([])

    // An older environment's snapshot has no list at all.
    const older = applySnapshot(held, snapshot())
    expect(selectThreadSubagents(older, THREAD.threadId)).toBe(
      selectThreadSubagents(held, THREAD.threadId),
    )
  })

  it('finds a child session’s record on its parent’s thread', () => {
    const child = {
      sessionId: 'child-1',
      workspaceId: WORKSPACE.workspaceId,
      title: 'Find the callers',
      parentSessionId: SESSION.sessionId,
    }
    let state = applyEvent(
      createInitialState(),
      event<Extract<ProofEvent, { name: 'session.created' }>>({
        name: 'session.created',
        scope: environmentScope,
        payload: { session: SESSION_CREATED },
      }),
    )
    state = applyEvent(state, event({ name: 'thread.created', scope: threadScope, payload: { thread: THREAD } }))
    state = applyEvent(
      state,
      event<Extract<ProofEvent, { name: 'session.created' }>>({
        name: 'session.created',
        scope: environmentScope,
        payload: {
          session: {
            ...SESSION_CREATED,
            ...child,
            subagent: { subagentId: 'a', origin: 'native', promptable: false },
          },
        },
      }),
    )
    expect(selectSubagentOfSession(state, 'child-1')).toBeNull()
    state = applyEvent(state, updated(subagent({ subagentId: 'a', childSessionId: 'child-1' })))
    expect(selectSubagentOfSession(state, 'child-1')?.subagentId).toBe('a')
    expect(selectSubagentOfSession(state, SESSION.sessionId)).toBeNull()

    // A status update leaves what the summary says about its subagent.
    state = applyEvent(
      state,
      event<Extract<ProofEvent, { name: 'session.updated' }>>({
        name: 'session.updated',
        scope: environmentScope,
        payload: { sessionId: 'child-1', status: 'running' },
      }),
    )
    expect(state.sessions['child-1']?.subagent).toEqual({
      subagentId: 'a',
      origin: 'native',
      promptable: false,
    })
    // So does the answer to a create that an event already announced.
    state = applySessionCreated(
      state,
      { session: child, thread: { threadId: 't-child', sessionId: 'child-1' }, announcedAt: 'x' },
      'claude',
    )
    expect(state.sessions['child-1']?.subagent?.subagentId).toBe('a')
  })
})

describe('stopping a subagent', () => {
  it('settles a running one as cancelled, and refuses one that cannot stop', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        workspaces: [WORKSPACE],
        sessions: [
          {
            session: SESSION,
            threads: [THREAD],
            subagents: {
              [THREAD.threadId]: [
                subagent({ subagentId: 'a', activity: 'Reading auth.ts' }),
                subagent({ subagentId: 'b', stoppable: false }),
              ],
            },
          },
        ],
      },
    })
    await client.commands.stopSubagent({ sessionId: SESSION.sessionId, subagentId: 'a' })
    const stopped = selectSubagent(client.getState(), THREAD.threadId, 'a')
    expect(stopped?.status).toBe('cancelled')
    expect(stopped?.activity).toBeUndefined()
    // Stopping it again is not an error.
    await client.commands.stopSubagent({ sessionId: SESSION.sessionId, subagentId: 'a' })
    await expect(
      client.commands.stopSubagent({ sessionId: SESSION.sessionId, subagentId: 'b' }),
    ).rejects.toMatchObject({ code: 'conflict' })
    client.dispose()
  })
})
