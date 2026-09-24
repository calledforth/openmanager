import { afterEach, describe, expect, it } from 'vitest'
import { FakeConnectionFactory } from '@agentpack/runtime/testing'
import {
  ProofResponseSchemas,
  type DurableEvent,
  type ReplayResponse,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import {
  assistantText,
  assistantTextFromMessages,
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  eventNames,
  handshake,
  nextResponse,
  replay,
  sequences,
  subscribe,
} from './helpers/protocol-client.js'
import { emitChunk, promptSessionId, startStubHost } from './helpers/proof-slice.js'

const PREFIX = 'Hel'
const SUFFIX = 'lo'
const FULL = `${PREFIX}${SUFFIX}`

afterEach(async () => {
  await cleanupProtocolHosts()
})

describe('late join from a second client', () => {
  it(
    'sees the in-progress assistant message, then both see completion without gaps or duplicates',
    { timeout: 20_000 },
    async () => {
      const stub = gatedStub('complete')
      const joined = await joinMidTurn(stub)

      stub.release()
      const [firstRest, secondRest] = await Promise.all([
        collectThreadRecords(joined.first, joined.firstSubscription, (records) =>
          records.some((record) => record.event.name === 'turn.completed'),
        ),
        collectThreadRecords(joined.second, joined.secondSubscription, (records) =>
          records.some((record) => record.event.name === 'turn.completed'),
        ),
      ])

      expectCoherentLateJoin(joined, firstRest, secondRest, 'turn.completed')
      expect(assistantText([...joined.firstPrefix, ...firstRest])).toBe(FULL)
      expect(
        assistantTextFromMessages(joined.snapshot.messages) + assistantText(secondRest),
      ).toBe(FULL)
    },
  )

  it(
    'sees the in-progress assistant message, then both see interrupt without gaps or duplicates',
    { timeout: 20_000 },
    async () => {
      const stub = gatedStub('interrupt')
      const joined = await joinMidTurn(stub)

      const interruptId = joined.first.command('turn.interrupt', {
        sessionId: joined.sessionId,
        threadId: joined.threadId,
        turnId: joined.turnId,
      })
      expect(await nextResponse(joined.first, interruptId)).toMatchObject({
        type: 'response',
        requestId: interruptId,
      })

      const [firstRest, secondRest] = await Promise.all([
        collectThreadRecords(joined.first, joined.firstSubscription, (records) =>
          records.some((record) => record.event.name === 'turn.interrupted'),
        ),
        collectThreadRecords(joined.second, joined.secondSubscription, (records) =>
          records.some((record) => record.event.name === 'turn.interrupted'),
        ),
      ])

      expectCoherentLateJoin(joined, firstRest, secondRest, 'turn.interrupted')
      expect(eventNames([...joined.firstPrefix, ...firstRest])).not.toContain('turn.completed')
      expect(eventNames(secondRest)).not.toContain('turn.completed')
      expect(assistantTextFromMessages(joined.snapshot.messages)).toBe(PREFIX)
    },
  )
})

function gatedStub(outcome: 'complete' | 'interrupt') {
  let release!: () => void
  const connections = new FakeConnectionFactory({
    initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
    newSession: async () => ({ sessionId: 'stub-session' }),
    prompt: async (params) => {
      const sessionId = promptSessionId(params)
      await emitChunk(connections, sessionId, PREFIX)
      await new Promise<void>((resolve) => {
        release = resolve
      })
      if (outcome === 'interrupt') return { stopReason: 'cancelled' }
      await emitChunk(connections, sessionId, SUFFIX)
      return { stopReason: 'end_turn' }
    },
    cancel: async () => {
      release?.()
    },
  })
  return {
    connections,
    release: () => release(),
  }
}

async function joinMidTurn(stub: ReturnType<typeof gatedStub>) {
  const host = await startStubHost(stub.connections)
  const first = await connectProtocol(host)
  await handshake(first)

  const createId = first.command('session.create', {
    environmentId: host.server.identity.environmentId,
    providerId: 'opencode',
    workspaceId: host.workspaceId,
  })
  const created = ProofResponseSchemas['session.create'].parse(await nextResponse(first, createId))
  const { session, thread } = created.payload
  const scope: SubscriptionScope = {
    type: 'thread',
    environmentId: host.server.identity.environmentId,
    sessionId: session.sessionId,
    threadId: thread.threadId,
  }
  const firstSubscription = await subscribe(first, scope)

  const sendId = first.command('turn.send', {
    sessionId: session.sessionId,
    threadId: thread.threadId,
    text: 'late join me',
  })
  const sent = ProofResponseSchemas['turn.send'].parse(await nextResponse(first, sendId))
  const firstPrefix = await collectThreadRecords(first, firstSubscription, (records) =>
    assistantText(records).includes(PREFIX),
  )
  expect(assistantText(firstPrefix)).toBe(PREFIX)
  expect(eventNames(firstPrefix)[0]).toBe('turn.started')

  const second = await connectProtocol(host)
  await handshake(second)
  const openId = second.command('session.open', { sessionId: session.sessionId })
  expect(await nextResponse(second, openId)).toMatchObject({ type: 'response', requestId: openId })

  const answer = await replay(second, scope, null)
  expect(answer.payload.mode).toBe('snapshot')
  const snapshot = threadSnapshot(answer)
  expect(snapshot.turns).toMatchObject([
    { turnId: sent.payload.turn.turnId, threadId: thread.threadId, state: 'running' },
  ])
  expect(assistantTextFromMessages(snapshot.messages)).toBe(PREFIX)
  expect(snapshot.cursor.sequence).toBe(firstPrefix.at(-1)!.cursor.sequence)

  return {
    first,
    second,
    firstSubscription,
    secondSubscription: answer.payload.subscriptionId,
    firstPrefix,
    snapshot,
    sessionId: session.sessionId,
    threadId: thread.threadId,
    turnId: sent.payload.turn.turnId,
  }
}

function expectCoherentLateJoin(
  joined: Awaited<ReturnType<typeof joinMidTurn>>,
  firstRest: DurableEvent[],
  secondRest: DurableEvent[],
  terminal: 'turn.completed' | 'turn.interrupted',
) {
  const firstAll = [...joined.firstPrefix, ...firstRest]
  expect(eventNames(firstAll).at(-1)).toBe(terminal)
  expect(eventNames(secondRest).at(-1)).toBe(terminal)
  expect(firstAll.at(-1)?.event.payload).toMatchObject({ turnId: joined.turnId })
  expect(secondRest.at(-1)?.event.payload).toMatchObject({ turnId: joined.turnId })
  expect(firstAll.at(-1)?.event.eventId).toBe(secondRest.at(-1)?.event.eventId)

  expectContiguous(firstAll, 1)
  expectContiguous(secondRest, joined.snapshot.cursor.sequence + 1)
  expect(secondRest[0]?.cursor.sequence).toBe(joined.snapshot.cursor.sequence + 1)
  expect(secondRest.at(-1)?.cursor.sequence).toBe(firstAll.at(-1)?.cursor.sequence)

  const firstIds = firstAll.map((record) => record.event.eventId)
  const secondIds = secondRest.map((record) => record.event.eventId)
  expect(new Set(firstIds).size).toBe(firstIds.length)
  expect(new Set(secondIds).size).toBe(secondIds.length)
  expect(secondIds.every((id) => firstIds.includes(id))).toBe(true)
  expect(secondIds.some((id) => joined.firstPrefix.some((record) => record.event.eventId === id))).toBe(
    false,
  )
}

function expectContiguous(records: DurableEvent[], from: number) {
  expect(sequences(records)).toEqual(records.map((_, index) => from + index))
}

function threadSnapshot(answer: ReplayResponse) {
  if (answer.payload.mode !== 'snapshot') throw new Error('expected a snapshot')
  const { snapshot } = answer.payload
  if (!('thread' in snapshot.state)) throw new Error('expected a thread snapshot')
  return { ...snapshot.state, cursor: snapshot.cursor }
}
