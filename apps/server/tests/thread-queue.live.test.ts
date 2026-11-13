import { afterEach, describe, expect, it } from 'vitest'
import { ProofResponseSchemas, STEER_SEND_NOW_CAPABILITY } from '@openmanager/protocol/node'
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
 *
 * A steer cuts a reply off at once and starts a turn of its own, but never
 * cuts a shell command short: Send now and Stop do that. Both must end the
 * turn at once, well inside the 15 s after which the runtime gives up on an
 * ignored interrupt and is replaced (which would also end it).
 * The CLI refuses `sleep N && …`, so slow commands here are `node -e` timers.
 */

/** Well inside the runtime's interrupt grace (15 s). */
const PROMPT_STOP_MS = 5_000
const live = process.env.OPENMANAGER_LIVE_CLAUDE === '1'

afterEach(async () => {
  await cleanupProtocolHosts()
})

/** A command that runs for `seconds`, then prints `label`. */
const slowCommand = (seconds: number, label: string) =>
  `node -e "setTimeout(() => console.log('${label}'), ${seconds * 1000})"`

async function openChat() {
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
  const subscriptionId = await subscribe(client, {
    type: 'thread',
    environmentId: host.server.identity.environmentId,
    ...target,
  })
  const send = async (text: string) => {
    const sendId = client.command('turn.send', { ...target, text })
    return ProofResponseSchemas['turn.send'].parse(await nextResponse(client, sendId)).payload.turn
      .turnId
  }
  const steer = async (turnId: string, text: string, commandId: string) => {
    const steerId = client.command('turn.steer', { ...target, turnId, text, commandId })
    expect(await nextResponse(client, steerId)).toMatchObject({
      payload: { queueItemId: commandId, outcome: 'steering' },
    })
  }
  const until = (predicate: Parameters<typeof collectThreadRecords>[2], timeoutMs: number) =>
    collectThreadRecords(client, subscriptionId, predicate, timeoutMs)
  const state = () => threadState(client, host.server.identity.environmentId, target)
  /** The slow command is running: its call is written out in full (a call
   * still streaming has empty input, and a steer then only cuts the reply),
   * and it has had time to start. */
  const commandRunning = async () => {
    await until(
      (records) =>
        records.some(
          (record) =>
            record.event.name === 'tool.updated' &&
            JSON.stringify(record.event).includes('setTimeout'),
        ),
      90_000,
    )
    await new Promise((resolve) => setTimeout(resolve, 4_000))
  }
  return { client, target, send, steer, until, state, commandRunning }
}

/** How many records of `name` the batch holds. */
const count = (records: { event: { name: string } }[], name: string) =>
  records.filter((record) => record.event.name === name).length

describe.skipIf(!live)('queue and steer on live Claude Code', () => {
  it(
    'cuts a reply off for a steer, runs it as its own turn, then the queued message',
    { timeout: 240_000 },
    async () => {
      const chat = await openChat()
      const turnId = await chat.send(
        'Write a 1500-word short story about a lighthouse keeper. Do not use any tools.',
      )
      // The story is streaming: steer now.
      await chat.until(
        (records) => records.some((record) => record.event.name === 'message.delta'),
        90_000,
      )
      const steeredAt = Date.now()
      await chat.steer(
        turnId,
        'Stop the story. Reply with exactly the word STEERED and nothing else.',
        'steer-1',
      )
      const queueId = chat.client.command('queue.add', {
        ...chat.target,
        text: 'Reply with exactly the word QUEUED and nothing else. Do not use tools.',
        commandId: 'queued-1',
      })
      expect(await nextResponse(chat.client, queueId)).toMatchObject({
        payload: { queueItemId: 'queued-1' },
      })
      await chat.until((records) => count(records, 'turn.started') >= 1, 30_000)
      // Cut off at once, not after the story's end.
      expect(Date.now() - steeredAt).toBeLessThan(10_000)
      await chat.until((records) => count(records, 'turn.completed') >= 2, 180_000)

      const state = await chat.state()
      expect(state.queue).toEqual({ items: [], pausedBy: null })
      expect(
        state.turns.map((turn) => [turn.turnId === turnId ? 'sent' : turn.commandId, turn.state]),
      ).toEqual([
        ['sent', 'completed'],
        ['steer-1', 'completed'],
        ['queued-1', 'completed'],
      ])
      const said = (id: string) =>
        state.messages
          .filter((message) => message.role === 'assistant' && message.turnId === id)
          .map((message) => JSON.stringify(message.content))
          .join('')
      const story = said(turnId)
      expect(story.length).toBeGreaterThan(0)
      // Far short of 1500 words.
      expect(story.length).toBeLessThan(4000)
      expect(said(state.turns[1]!.turnId)).toContain('STEERED')
      expect(said(state.turns[2]!.turnId)).toContain('QUEUED')
    },
  )

  it(
    'sends a steer now: stops the running command and runs the steer next',
    { timeout: 240_000 },
    async () => {
      const chat = await openChat()
      const turnId = await chat.send(
        `Run this exact shell command in the foreground: \`${slowCommand(90, 'done')}\`. ` +
          'It takes 90 seconds; wait for it. Then reply with exactly DONE.',
      )
      await chat.commandRunning()
      await chat.steer(
        turnId,
        'Reply with exactly the word STEERED and nothing else. Do not use tools.',
        'steer-1',
      )
      const sentAt = Date.now()
      const nowId = chat.client.command(STEER_SEND_NOW_CAPABILITY, {
        ...chat.target,
        queueItemId: 'steer-1',
      })
      expect(await nextResponse(chat.client, nowId)).toMatchObject({ type: 'response' })
      await chat.until((records) => count(records, 'turn.interrupted') >= 1, 30_000)
      // Stopped at once, not by the runtime giving up on the interrupt.
      expect(Date.now() - sentAt).toBeLessThan(PROMPT_STOP_MS)
      await chat.until((records) => count(records, 'turn.completed') >= 1, 60_000)

      const state = await chat.state()
      expect(state.queue).toEqual({ items: [], pausedBy: null })
      expect(
        state.turns.map((turn) => [turn.turnId === turnId ? 'sent' : turn.commandId, turn.state]),
      ).toEqual([
        ['sent', 'interrupted'],
        ['steer-1', 'completed'],
      ])
      const steered = state.messages.filter(
        (message) => message.role === 'assistant' && message.turnId === state.turns[1]!.turnId,
      )
      expect(JSON.stringify(steered)).toContain('STEERED')
    },
  )

  it(
    'on Stop, runs a steer the turn never reached, then the queued message',
    { timeout: 240_000 },
    async () => {
      const chat = await openChat()
      const turnId = await chat.send(
        `Run this exact shell command in the foreground: \`${slowCommand(60, 'done')}\`. ` +
          'Then reply with exactly DONE.',
      )
      await chat.commandRunning()
      // Queued first, steered second: the steer still runs first.
      const queueId = chat.client.command('queue.add', {
        ...chat.target,
        text: 'Reply with exactly the word QUEUED and nothing else. Do not use tools.',
        commandId: 'queued-1',
      })
      expect(await nextResponse(chat.client, queueId)).toMatchObject({
        payload: { queueItemId: 'queued-1' },
      })
      await chat.steer(
        turnId,
        'Reply with exactly the word STEERED and nothing else. Do not use tools.',
        'steer-1',
      )
      // The command is still running, so the steer has not reached the turn.
      const stoppedAt = Date.now()
      const stopId = chat.client.command('turn.interrupt', { ...chat.target, turnId })
      expect(await nextResponse(chat.client, stopId)).toMatchObject({ type: 'response' })
      const afterStop = await chat.until(
        (records) => count(records, 'turn.interrupted') >= 1,
        30_000,
      )
      expect(Date.now() - stoppedAt).toBeLessThan(PROMPT_STOP_MS)

      await chat.until(
        (records) => count([...afterStop, ...records], 'turn.completed') >= 2,
        180_000,
      )
      const state = await chat.state()
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
