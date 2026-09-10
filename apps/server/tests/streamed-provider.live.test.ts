import { afterEach, describe, expect, it } from 'vitest'
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

const liveProvider =
  process.env.OPENMANAGER_LIVE_PROVIDER === 'claude' ||
  process.env.OPENMANAGER_LIVE_CLAUDE === '1'
    ? 'claude'
    : process.env.OPENMANAGER_LIVE_PROVIDER === 'opencode' ||
        process.env.OPENMANAGER_LIVE_OPENCODE === '1'
      ? 'opencode'
      : undefined

afterEach(async () => {
  await cleanupProtocolHosts()
})

describe.skipIf(!liveProvider)('streamed live provider through the server', () => {
  it(
    'completes a short turn then interrupts a longer one',
    { timeout: 120_000 },
    async () => {
      const host = await startProtocolHost({
        resolveWorkspace: (workspaceId) => ({
          providerId: liveProvider!,
          cwd: workspaceId,
        }),
      })
      const client = await connectProtocol(host)
      await handshake(client)

      const createId = client.command('session.create', { workspaceId: host.dataDir })
      const created = ProofResponseSchemas['session.create'].parse(
        await nextResponse(client, createId),
      )
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
        text: 'Do not use tools. Reply with only the single word: pong',
      })
      const firstResponse = ProofResponseSchemas['turn.send'].parse(
        await nextResponse(client, firstSend),
      )
      expect(firstResponse).toMatchObject({ type: 'response', requestId: firstSend })

      const completed = await collectThreadRecords(
        client,
        subscriptionId,
        (records) => records.some((record) => record.event.name === 'turn.completed'),
        90_000,
      )
      expect(eventNames(completed)[0]).toBe('turn.started')
      expect(eventNames(completed).at(-1)).toBe('turn.completed')
      expect(sequences(completed)[0]).toBe(1)
      for (let i = 1; i < completed.length; i++) {
        expect(completed[i]?.cursor.sequence).toBe((completed[i - 1]?.cursor.sequence ?? 0) + 1)
      }
      expect(assistantText(completed).toLowerCase()).toContain('pong')

      const secondSend = client.command('turn.send', {
        sessionId: session.sessionId,
        threadId: thread.threadId,
        text: 'Do not use tools. Count slowly from 1 to 200, one number per line.',
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

      const interrupted = await collectThreadRecords(
        client,
        subscriptionId,
        (records) => records.some((record) => record.event.name === 'turn.interrupted'),
        90_000,
      )
      expect(eventNames(interrupted)[0]).toBe('turn.started')
      expect(eventNames(interrupted).at(-1)).toBe('turn.interrupted')
      expect(eventNames(interrupted).filter((name) => name === 'turn.completed')).toEqual([])
      expect(interrupted.at(-1)?.event.payload).toMatchObject({ turnId: secondTurnId })
      expect(sequences(interrupted)[0]).toBe(completed.at(-1)!.cursor.sequence + 1)
    },
  )
})
