import { afterEach, describe, expect, it } from 'vitest'
import { FakeClaudeSdk, FakeConnectionFactory } from '@agentpack/runtime/testing'
import { ProofResponseSchemas } from '@openmanager/protocol/node'
import {
  assistantText,
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  eventNames,
  handshake,
  nextResponse,
  sequences,
  startProtocolHost,
  subscribe,
} from './helpers/protocol-client.js'

const CHUNKS = ['Hel', 'lo']

afterEach(async () => {
  await cleanupProtocolHosts()
})

describe('streamed provider through the server', () => {
  it(
    'completes one turn then interrupts the next, with contiguous sequences',
    { timeout: 20_000 },
    async () => {
      let prompts = 0
      let releaseSecond: (() => void) | undefined
      const connections = new FakeConnectionFactory({
        initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
        newSession: async () => ({ sessionId: 'stub-session' }),
        prompt: async (params) => {
          prompts += 1
          const sessionId =
            params !== null &&
            typeof params === 'object' &&
            'sessionId' in params &&
            typeof params.sessionId === 'string'
              ? params.sessionId
              : 'stub-session'
          if (prompts === 1) {
            for (const text of CHUNKS) {
              await connections.last.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text },
                },
              })
            }
            return { stopReason: 'end_turn' }
          }
          await new Promise<void>((resolve) => {
            releaseSecond = resolve
          })
          return { stopReason: 'cancelled' }
        },
        cancel: async () => {
          releaseSecond?.()
        },
      })

      const host = await startProtocolHost({
        runtimeOptions: {
          connections,
          claudeSdk: new FakeClaudeSdk(),
          health: { schedule: () => ({ cancel() {} }) },
        },
      })
      const client = await connectProtocol(host)
      await handshake(client)

      const createId = client.command('session.create', { workspaceId: host.dataDir })
      const created = ProofResponseSchemas['session.create'].parse(await nextResponse(client, createId))
      expect(created).toMatchObject({ type: 'response', requestId: createId })
      const { session, thread } = created.payload
      const subscriptionId = await subscribe(client, {
        type: 'thread',
        environmentId: host.server.identity.environmentId,
        sessionId: session.sessionId,
        threadId: thread.threadId,
      })

      const firstSend = client.command('turn.send', {
        sessionId: session.sessionId,
        threadId: thread.threadId,
        text: 'complete me',
      })
      const firstResponse = ProofResponseSchemas['turn.send'].parse(
        await nextResponse(client, firstSend),
      )
      expect(firstResponse).toMatchObject({ type: 'response', requestId: firstSend })
      const firstTurnId = firstResponse.payload.turn.turnId

      const completed = await collectThreadRecords(client, subscriptionId, (records) =>
        records.some((record) => record.event.name === 'turn.completed'),
      )
      expect(eventNames(completed)).toEqual([
        'turn.started',
        'message.delta',
        'message.delta',
        'turn.completed',
      ])
      expect(sequences(completed)).toEqual([1, 2, 3, 4])
      expect(assistantText(completed)).toBe('Hello')
      expect(completed.at(-1)?.event.payload).toMatchObject({ turnId: firstTurnId })
      expect(completed.every((record) => record.cursor.epoch === completed[0]?.cursor.epoch)).toBe(
        true,
      )

      const secondSend = client.command('turn.send', {
        sessionId: session.sessionId,
        threadId: thread.threadId,
        text: 'interrupt me',
      })
      const secondResponse = ProofResponseSchemas['turn.send'].parse(
        await nextResponse(client, secondSend),
      )
      expect(secondResponse).toMatchObject({ type: 'response', requestId: secondSend })
      const secondTurnId = secondResponse.payload.turn.turnId

      const interruptId = client.command('turn.interrupt', {
        sessionId: session.sessionId,
        threadId: thread.threadId,
        turnId: secondTurnId,
      })
      expect(await nextResponse(client, interruptId)).toMatchObject({
        type: 'response',
        requestId: interruptId,
      })

      const interrupted = await collectThreadRecords(client, subscriptionId, (records) =>
        records.some((record) => record.event.name === 'turn.interrupted'),
      )
      const names = eventNames(interrupted)
      expect(names[0]).toBe('turn.started')
      expect(names.at(-1)).toBe('turn.interrupted')
      expect(names.filter((name) => name === 'turn.completed')).toEqual([])
      expect(names.filter((name) => name === 'turn.interrupted')).toEqual(['turn.interrupted'])
      expect(interrupted.at(-1)?.event.payload).toMatchObject({ turnId: secondTurnId })
      expect(sequences(interrupted)[0]).toBe(5)
      for (let i = 1; i < interrupted.length; i++) {
        expect(interrupted[i]?.cursor.sequence).toBe((interrupted[i - 1]?.cursor.sequence ?? 0) + 1)
      }
    },
  )
})
