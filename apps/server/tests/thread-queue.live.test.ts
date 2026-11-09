import { afterEach, describe, expect, it } from 'vitest'
import { ProofResponseSchemas } from '@openmanager/protocol/node'
import {
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  handshake,
  nextResponse,
  startProtocolHost,
  subscribe,
  threadState,
} from './helpers/protocol-client.js'

/**
 * Queue and steer against the real Claude Code CLI. Opt in with
 * `OPENMANAGER_LIVE_CLAUDE=1`; it spends a few cents of quota.
 */
const live = process.env.OPENMANAGER_LIVE_CLAUDE === '1'

afterEach(async () => {
  await cleanupProtocolHosts()
})

describe.skipIf(!live)('queue and steer on live Claude Code', () => {
  it(
    'folds a steer into the running turn, then runs a queued message as the next turn',
    { timeout: 240_000 },
    async () => {
      const host = await startProtocolHost()
      const client = await connectProtocol(host)
      await handshake(client)
      const createId = client.command('session.create', {
        environmentId: host.server.identity.environmentId,
        workspaceId: host.workspaceId,
        providerId: 'claude',
      })
      const createdRaw = await nextResponse(client, createId)
      if ((createdRaw as { type: string }).type !== 'response')
        throw new Error(`session.create refused: ${JSON.stringify(createdRaw)}`)
      const { session, thread } = ProofResponseSchemas['session.create'].parse(createdRaw).payload
      const target = { sessionId: session.sessionId, threadId: thread.threadId }
      const scope = {
        type: 'thread' as const,
        environmentId: host.server.identity.environmentId,
        ...target,
      }
      const subscriptionId = await subscribe(client, scope)

      const sendId = client.command('turn.send', {
        ...target,
        text:
          'Run the bash command `sleep 15 && echo one`. Then run the bash command `echo two`. ' +
          'Then reply with exactly the word FINISHED.',
      })
      const sent = ProofResponseSchemas['turn.send'].parse(await nextResponse(client, sendId))
      const turnId = sent.payload.turn.turnId
      // The first tool is running: steer now, so it lands at the next boundary.
      await collectThreadRecords(
        client,
        subscriptionId,
        (records) => records.some((record) => record.event.name === 'tool.updated'),
        90_000,
      )
      const steerId = client.command('turn.steer', {
        ...target,
        turnId,
        text: 'Change of plan: do not run `echo two`. Run `echo steered` instead, then reply FINISHED.',
        commandId: 'steer-1',
      })
      expect(await nextResponse(client, steerId)).toMatchObject({
        payload: { queueItemId: 'steer-1', outcome: 'steering' },
      })
      const queueId = client.command('queue.add', {
        ...target,
        text: 'Reply with exactly the word QUEUED and nothing else. Do not use tools.',
        commandId: 'queued-1',
      })
      expect(await nextResponse(client, queueId)).toMatchObject({
        payload: { queueItemId: 'queued-1' },
      })

      const records = await collectThreadRecords(
        client,
        subscriptionId,
        (seen) => seen.filter((record) => record.event.name === 'turn.completed').length >= 2,
        180_000,
      )
      const names = records.map((record) => record.event.name)
      expect(names).toContain('thread.queue.updated')

      const state = await threadState(client, host.server.identity.environmentId, target)
      expect(state.queue).toEqual({ items: [], pausedBy: null })
      expect(state.turns).toHaveLength(2)
      expect(state.turns[1]!.commandId).toBe('queued-1')
      const firstTurnUsers = state.messages.filter(
        (message) => message.turnId === turnId && message.role === 'user',
      )
      expect(firstTurnUsers).toHaveLength(2)
      expect(JSON.stringify(firstTurnUsers[1]!.content)).toContain('echo steered')
      // The agent acted on it inside the same turn.
      const commands = state.tools
        .filter((tool) => tool.turnId === turnId)
        .map((tool) => JSON.stringify(tool))
      expect(commands.some((tool) => tool.includes('echo steered'))).toBe(true)
      expect(commands.some((tool) => tool.includes('echo two'))).toBe(false)
    },
  )

  it(
    'on Stop, runs a steer the turn never reached, then the queued message',
    { timeout: 240_000 },
    async () => {
      const host = await startProtocolHost()
      const client = await connectProtocol(host)
      await handshake(client)
      const createId = client.command('session.create', {
        environmentId: host.server.identity.environmentId,
        workspaceId: host.workspaceId,
        providerId: 'claude',
      })
      const createdRaw = await nextResponse(client, createId)
      if ((createdRaw as { type: string }).type !== 'response')
        throw new Error(`session.create refused: ${JSON.stringify(createdRaw)}`)
      const { session, thread } = ProofResponseSchemas['session.create'].parse(createdRaw).payload
      const target = { sessionId: session.sessionId, threadId: thread.threadId }
      const scope = {
        type: 'thread' as const,
        environmentId: host.server.identity.environmentId,
        ...target,
      }
      const subscriptionId = await subscribe(client, scope)

      const sendId = client.command('turn.send', {
        ...target,
        text: 'Run the bash command `sleep 60 && echo done`, then reply with exactly DONE.',
      })
      const sent = ProofResponseSchemas['turn.send'].parse(await nextResponse(client, sendId))
      const turnId = sent.payload.turn.turnId
      await collectThreadRecords(
        client,
        subscriptionId,
        (records) => records.some((record) => record.event.name === 'tool.updated'),
        90_000,
      )
      // Queued first, steered second: the steer still runs first.
      const queueId = client.command('queue.add', {
        ...target,
        text: 'Reply with exactly the word QUEUED and nothing else. Do not use tools.',
        commandId: 'queued-1',
      })
      expect(await nextResponse(client, queueId)).toMatchObject({
        payload: { queueItemId: 'queued-1' },
      })
      const steerId = client.command('turn.steer', {
        ...target,
        turnId,
        text: 'Reply with exactly the word STEERED and nothing else. Do not use tools.',
        commandId: 'steer-1',
      })
      expect(await nextResponse(client, steerId)).toMatchObject({
        payload: { queueItemId: 'steer-1', outcome: 'steering' },
      })
      // The sleep is still running, so the steer has not reached the turn.
      const stopId = client.command('turn.interrupt', { ...target, turnId })
      expect(await nextResponse(client, stopId)).toMatchObject({ type: 'response' })

      await collectThreadRecords(
        client,
        subscriptionId,
        (seen) => seen.filter((record) => record.event.name === 'turn.completed').length >= 2,
        180_000,
      )
      const state = await threadState(client, host.server.identity.environmentId, target)
      expect(state.queue).toEqual({ items: [], pausedBy: null })
      expect(
        state.turns.map((turn) => [turn.turnId === turnId ? 'sent' : turn.commandId, turn.state]),
      ).toEqual([
        ['sent', 'interrupted'],
        ['steer-1', 'completed'],
        ['queued-1', 'completed'],
      ])
      const said = (id: string) =>
        JSON.stringify(
          state.messages.filter(
            (message) =>
              message.role === 'assistant' &&
              message.turnId === state.turns.find((turn) => turn.commandId === id)!.turnId,
          ),
        )
      expect(said('steer-1')).toContain('STEERED')
      expect(said('queued-1')).toContain('QUEUED')
    },
  )
})
