import { expect } from 'vitest'
import { FakeClaudeSdk, FakeConnectionFactory } from '@agentpack/runtime/testing'
import {
  ProofResponseSchemas,
  type DurableEvent,
  type Message,
  type ProofCommandName,
  type ProofResponse,
  type Turn,
} from '@openmanager/protocol/node'
import {
  eventNames,
  nextResponse,
  sequences,
  startProtocolHost,
  type ProtocolClient,
  type ProtocolHost,
} from './protocol-client.js'

/** Failure tags so a CI log can tell protocol, persistence, and reconstructed-UI bugs apart. */
export type ProofLayer = 'protocol' | 'persistence' | 'ui'

export function layer(kind: ProofLayer, step: string): string {
  return `[${kind}] ${step}`
}

export function summarizeRecords(records: readonly DurableEvent[]) {
  return records.map((record) => ({
    sequence: record.cursor.sequence,
    epoch: record.cursor.epoch,
    name: record.event.name,
    eventId: record.event.eventId,
  }))
}

export async function expectCommand<N extends ProofCommandName>(
  client: ProtocolClient,
  name: N,
  payload: unknown,
  step: string,
): Promise<ProofResponse<N>> {
  const requestId = client.command(name, payload)
  let raw: Awaited<ReturnType<typeof nextResponse>>
  try {
    raw = await nextResponse(client, requestId)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(layer('protocol', `${step}: waiting for ${name} (${requestId}): ${reason}`))
  }
  expect(raw, layer('protocol', `${step}: ${name} ${requestId}`)).toMatchObject({
    type: 'response',
    requestId,
  })
  return ProofResponseSchemas[name].parse(raw) as ProofResponse<N>
}

export async function startStubHost(connections: FakeConnectionFactory): Promise<ProtocolHost> {
  return startProtocolHost({
    runtimeOptions: {
      connections,
      claudeSdk: new FakeClaudeSdk(),
      health: { schedule: () => ({ cancel() {} }) },
    },
  })
}

export function promptSessionId(params: unknown): string {
  return params !== null &&
    typeof params === 'object' &&
    'sessionId' in params &&
    typeof params.sessionId === 'string'
    ? params.sessionId
    : 'stub-session'
}

export async function emitChunk(
  connections: FakeConnectionFactory,
  sessionId: string,
  text: string,
): Promise<void> {
  await connections.last.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  })
}

/** First prompt completes; the second emits `prefix` then waits for `release`. */
export function gatedSecondPrompt(options: {
  prefix: string
  suffix: string
  second: 'complete' | 'interrupt'
}) {
  let prompts = 0
  let releaseSecond: (() => void) | undefined
  const connections = new FakeConnectionFactory({
    initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
    newSession: async () => ({ sessionId: 'stub-session' }),
    prompt: async (params) => {
      prompts += 1
      const sessionId = promptSessionId(params)
      if (prompts === 1) {
        for (const text of [options.prefix, options.suffix]) {
          await emitChunk(connections, sessionId, text)
        }
        return { stopReason: 'end_turn' }
      }
      await emitChunk(connections, sessionId, options.prefix)
      await new Promise<void>((resolve) => {
        releaseSecond = resolve
      })
      if (options.second === 'interrupt') return { stopReason: 'cancelled' }
      await emitChunk(connections, sessionId, options.suffix)
      return { stopReason: 'end_turn' }
    },
    cancel: async () => {
      releaseSecond?.()
    },
  })
  return {
    connections,
    release: () => releaseSecond?.(),
  }
}

/** Single prompt that emits `prefix`, waits, then optionally `suffix`. */
export function gatedFirstPrompt(options: { prefix: string; suffix: string }) {
  let release!: () => void
  const connections = new FakeConnectionFactory({
    initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
    newSession: async () => ({ sessionId: 'stub-session' }),
    prompt: async (params) => {
      const sessionId = promptSessionId(params)
      await emitChunk(connections, sessionId, options.prefix)
      await new Promise<void>((resolve) => {
        release = resolve
      })
      await emitChunk(connections, sessionId, options.suffix)
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

export function expectContiguous(
  records: readonly DurableEvent[],
  from: number,
  step: string,
): void {
  expect(sequences([...records]), layer('protocol', `${step}: sequence gap`)).toEqual(
    records.map((_, index) => from + index),
  )
  const ids = records.map((record) => record.event.eventId)
  expect(new Set(ids).size, layer('ui', `${step}: duplicate event ids ${JSON.stringify(ids)}`)).toBe(
    ids.length,
  )
}

export function expectTerminal(
  records: readonly DurableEvent[],
  name: 'turn.completed' | 'turn.interrupted',
  turnId: string,
  step: string,
): void {
  expect(eventNames([...records]).at(-1), layer('protocol', `${step}: terminal event`)).toBe(name)
  expect(
    records.at(-1)?.event.payload,
    layer('protocol', `${step}: terminal turnId`),
  ).toMatchObject({ turnId })
  expect(
    eventNames([...records]).filter((eventName) => eventName === name),
    layer('protocol', `${step}: terminal must occur once`),
  ).toEqual([name])
}

export function expectHistoryTurn(
  history: { turns: readonly Turn[]; messages: readonly Message[] },
  turnId: string,
  state: Turn['state'],
  step: string,
): Turn {
  const turn = history.turns.find((candidate) => candidate.turnId === turnId)
  expect(
    turn,
    layer(
      'persistence',
      `${step}: history missing turn ${turnId} (have ${history.turns.map((item) => `${item.turnId}:${item.state}`).join(', ') || 'none'})`,
    ),
  ).toBeTruthy()
  expect(turn!.state, layer('persistence', `${step}: history turn ${turnId} state`)).toBe(state)
  return turn!
}

export function disconnect(client: ProtocolClient): void {
  client.ws.terminate()
}
