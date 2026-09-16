/**
 * Milestone harness for the proof slice. A real environment server plus the
 * protocol client (no browser) walks connect → catalog → open/history → send →
 * stream → interrupt → reconnect. Failures are tagged `[protocol]`,
 * `[persistence]`, or `[ui]` so CI logs distinguish wire, SQLite, and
 * reconstructed-transcript bugs. Set OPENMANAGER_LIVE_PROVIDER to run the same
 * walk against Claude or OpenCode; see apps/server/README.md.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { DurableEvent, ReplayResponse, SubscriptionScope } from '@openmanager/protocol/node'
import {
  assistantText,
  assistantTextFromMessages,
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  handshake,
  replay,
  startProtocolHost,
  subscribe,
  type ProtocolClient,
  type ProtocolHost,
} from './helpers/protocol-client.js'
import {
  disconnect,
  expectCommand,
  expectContiguous,
  expectHistoryTurn,
  expectTerminal,
  gatedFirstPrompt,
  gatedSecondPrompt,
  layer,
  startStubHost,
} from './helpers/proof-slice.js'

const PREFIX = 'Hel'
const SUFFIX = 'lo'
const FULL = `${PREFIX}${SUFFIX}`

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

describe('proof slice e2e harness', () => {
  it(
    'connects, lists, opens history, sends, streams, interrupts, then reconnects without losing the turn',
    { timeout: 20_000 },
    async () => {
      const stub = gatedSecondPrompt({ prefix: PREFIX, suffix: SUFFIX, second: 'interrupt' })
      const host = await startStubHost(stub.connections)
      const client = await connectProtocol(host)
      await handshake(client)

      const catalog = await listCatalog(client, host, 'initial catalog')
      expect(
        catalog.sessions.map((session) => session.sessionId),
        layer('persistence', 'initial catalog: no sessions yet'),
      ).toEqual([])

      const created = await createOpenedSession(client, host, 'opencode', 'create before send')
      const { sessionId, threadId, scope } = created
      const subscriptionId = await subscribe(client, scope)

      const firstSend = await expectCommand(
        client,
        'turn.send',
        { sessionId, threadId, text: 'complete me', commandId: 'cmd-complete' },
        'send completed turn',
      )
      const firstTurnId = firstSend.payload.turn.turnId
      const completed = await collectLayer(
        client,
        subscriptionId,
        (records) => records.some((record) => record.event.name === 'turn.completed'),
        'stream completed turn',
      )
      expect(eventStart(completed), layer('protocol', 'completed turn starts with turn.started')).toBe(
        'turn.started',
      )
      expectContiguous(completed, 1, 'completed turn')
      expectTerminal(completed, 'turn.completed', firstTurnId, 'completed turn')
      expect(assistantText(completed), layer('ui', 'completed turn reconstructed text')).toBe(FULL)

      const secondSend = await expectCommand(
        client,
        'turn.send',
        { sessionId, threadId, text: 'interrupt me', commandId: 'cmd-interrupt' },
        'send interrupted turn',
      )
      const secondTurnId = secondSend.payload.turn.turnId
      const prefix = await collectLayer(
        client,
        subscriptionId,
        (records) => assistantText(records).includes(PREFIX),
        'stream interrupt prefix',
      )
      expect(eventStart(prefix), layer('protocol', 'interrupt turn starts with turn.started')).toBe(
        'turn.started',
      )
      expect(assistantText(prefix), layer('ui', 'interrupt prefix reconstructed text')).toBe(PREFIX)

      await expectCommand(
        client,
        'turn.interrupt',
        { sessionId, threadId, turnId: secondTurnId },
        'interrupt',
      )

      const interrupted = await collectLayer(
        client,
        subscriptionId,
        (records) => records.some((record) => record.event.name === 'turn.interrupted'),
        'stream interrupted turn',
      )
      expectTerminal(interrupted, 'turn.interrupted', secondTurnId, 'interrupted turn')
      expect(
        eventNamesOf(interrupted).includes('turn.completed'),
        layer('protocol', 'interrupted turn must not complete'),
      ).toBe(false)
      expectContiguous(
        [...prefix, ...interrupted],
        prefix[0]!.cursor.sequence,
        'interrupted turn after prefix',
      )

      disconnect(client)
      const recovered = await reconnectAndOpen(host, scope, sessionId, threadId, 'after interrupt')
      expectHistoryTurn(recovered.history, firstTurnId, 'completed', 'after interrupt')
      expectHistoryTurn(recovered.history, secondTurnId, 'interrupted', 'after interrupt')
      expect(
        recovered.history.messages.some(
          (message) => message.role === 'user' && message.content[0]?.type === 'text',
        ),
        layer('persistence', 'after interrupt: user prompts survived reconnect'),
      ).toBe(true)
      expect(
        assistantTextFromMessages(recovered.history.messages),
        layer('persistence', 'after interrupt: completed assistant text survived reconnect'),
      ).toContain(FULL)
      expect(
        recovered.listed.sessions.some((session) => session.sessionId === sessionId),
        layer('persistence', 'after interrupt: session remains in the catalog'),
      ).toBe(true)
    },
  )

  it(
    'reconnects mid-stream and catches up without gaps, duplicates, or a lost running turn',
    { timeout: 20_000 },
    async () => {
      const stub = gatedFirstPrompt({ prefix: PREFIX, suffix: SUFFIX })
      const host = await startStubHost(stub.connections)
      const client = await connectProtocol(host)
      await handshake(client)
      await listCatalog(client, host, 'mid-stream catalog')
      const created = await createOpenedSession(
        client,
        host,
        'opencode',
        'create before mid-stream send',
      )
      const { sessionId, threadId, scope } = created
      const subscriptionId = await subscribe(client, scope)

      const sent = await expectCommand(
        client,
        'turn.send',
        { sessionId, threadId, text: 'hold me', commandId: 'cmd-hold' },
        'send held turn',
      )
      const turnId = sent.payload.turn.turnId
      const prefix = await collectLayer(
        client,
        subscriptionId,
        (records) => assistantText(records).includes(PREFIX),
        'stream held prefix',
      )
      expectContiguous(prefix, 1, 'held prefix')
      const last = prefix.at(-1)!

      disconnect(client)
      const recovered = await reconnectAndOpen(host, scope, sessionId, threadId, 'mid-stream')
      expectHistoryTurn(recovered.history, turnId, 'running', 'mid-stream')
      expect(
        assistantTextFromMessages(recovered.history.messages),
        layer('persistence', 'mid-stream: prefix persisted while the turn is still running'),
      ).toBe(PREFIX)

      const answer = await replayCaughtUp(recovered.client, scope, last.cursor, 'mid-stream')
      stub.release()
      const rest = [
        ...(answer.payload.mode === 'replay' ? answer.payload.events : []),
        ...(await collectLayer(
          recovered.client,
          answer.payload.subscriptionId,
          (records) => records.some((record) => record.event.name === 'turn.completed'),
          'catch-up after mid-stream reconnect',
        )),
      ]
      expectTerminal(rest, 'turn.completed', turnId, 'caught-up turn')
      expect(
        rest[0]?.cursor.sequence,
        layer('protocol', 'catch-up must continue after the last live cursor'),
      ).toBe(last.cursor.sequence + 1)
      expectContiguous(rest, last.cursor.sequence + 1, 'catch-up tail')
      expect(
        rest.some((record) => record.event.eventId === last.event.eventId),
        layer('ui', 'catch-up must not duplicate the prefix the UI already applied'),
      ).toBe(false)
      expect(
        assistantText([...prefix, ...rest]),
        layer('ui', 'caught-up reconstructed text'),
      ).toBe(FULL)

      const historyAfter = await expectCommand(
        recovered.client,
        'session.history',
        { sessionId, threadId },
        'history after catch-up',
      )
      expectHistoryTurn(historyAfter.payload, turnId, 'completed', 'after catch-up')
      expect(
        assistantTextFromMessages(historyAfter.payload.messages),
        layer('persistence', 'after catch-up: persisted assistant text'),
      ).toBe(FULL)
    },
  )
})

describe.skipIf(!liveProvider)('proof slice e2e harness (live provider)', () => {
  it(
    'walks the proof slice against a real provider and reconnects without losing the turn',
    { timeout: 120_000 },
    async () => {
      let workspaceRoot = ''
      const host = await startProtocolHost({
        resolveWorkspace: () => ({
          providerId: liveProvider!,
          cwd: workspaceRoot,
        }),
      })
      workspaceRoot = host.workspaceRoot
      const client = await connectProtocol(host)
      await handshake(client)
      await listCatalog(client, host, 'live catalog')
      const created = await createOpenedSession(client, host, liveProvider!, 'live create')
      const { sessionId, threadId, scope } = created
      const subscriptionId = await subscribe(client, scope)

      const firstSend = await expectCommand(
        client,
        'turn.send',
        {
          sessionId,
          threadId,
          text: 'Do not use tools. Reply with only the single word: pong',
          commandId: 'cmd-live-complete',
        },
        'live send',
      )
      const firstTurnId = firstSend.payload.turn.turnId
      const completed = await collectLayer(
        client,
        subscriptionId,
        (records) => records.some((record) => record.event.name === 'turn.completed'),
        'live stream',
        90_000,
      )
      expectTerminal(completed, 'turn.completed', firstTurnId, 'live completed turn')
      expectContiguous(completed, 1, 'live completed turn')
      expect(
        assistantText(completed).toLowerCase(),
        layer('ui', 'live reconstructed text should include pong'),
      ).toContain('pong')

      const secondSend = await expectCommand(
        client,
        'turn.send',
        {
          sessionId,
          threadId,
          text: 'Do not use tools. Count slowly from 1 to 200, one number per line.',
          commandId: 'cmd-live-interrupt',
        },
        'live interrupt send',
      )
      const secondTurnId = secondSend.payload.turn.turnId
      await expectCommand(
        client,
        'turn.interrupt',
        { sessionId, threadId, turnId: secondTurnId },
        'live interrupt',
      )
      const interrupted = await collectLayer(
        client,
        subscriptionId,
        (records) => records.some((record) => record.event.name === 'turn.interrupted'),
        'live interrupt stream',
        90_000,
      )
      expectTerminal(interrupted, 'turn.interrupted', secondTurnId, 'live interrupted turn')

      disconnect(client)
      const recovered = await reconnectAndOpen(host, scope, sessionId, threadId, 'live after interrupt')
      expectHistoryTurn(recovered.history, firstTurnId, 'completed', 'live after interrupt')
      expectHistoryTurn(recovered.history, secondTurnId, 'interrupted', 'live after interrupt')
    },
  )
})

async function listCatalog(client: ProtocolClient, host: ProtocolHost, step: string) {
  const environment = await expectCommand(client, 'environment.get', null, `${step}: environment.get`)
  expect(
    environment.payload.environment.environmentId,
    layer('protocol', `${step}: environment id`),
  ).toBe(host.server.identity.environmentId)
  const workspaces = await expectCommand(client, 'workspace.list', null, `${step}: workspace.list`)
  expect(
    workspaces.payload.workspaces.some((workspace) => workspace.workspaceId === host.workspaceId),
    layer('persistence', `${step}: configured workspace is listed`),
  ).toBe(true)
  const sessions = await expectCommand(client, 'session.list', {}, `${step}: session.list`)
  return { environment: environment.payload.environment, ...workspaces.payload, ...sessions.payload }
}

async function createOpenedSession(
  client: ProtocolClient,
  host: ProtocolHost,
  providerId: string,
  step: string,
) {
  const created = await expectCommand(
    client,
    'session.create',
    {
      environmentId: host.server.identity.environmentId,
      providerId,
      workspaceId: host.workspaceId,
    },
    `${step}: session.create`,
  )
  const { session, thread } = created.payload
  const listed = await expectCommand(client, 'session.list', {}, `${step}: session.list after create`)
  expect(
    listed.payload.sessions.some((row) => row.sessionId === session.sessionId),
    layer('persistence', `${step}: created session appears in the catalog`),
  ).toBe(true)
  const opened = await expectCommand(
    client,
    'session.open',
    { sessionId: session.sessionId },
    `${step}: session.open`,
  )
  expect(
    opened.payload.threads.some((row) => row.threadId === thread.threadId),
    layer('protocol', `${step}: open returns the created thread`),
  ).toBe(true)
  const history = await expectCommand(
    client,
    'session.history',
    { sessionId: session.sessionId, threadId: thread.threadId },
    `${step}: session.history`,
  )
  expect(history.payload.turns, layer('persistence', `${step}: new thread history is empty`)).toEqual(
    [],
  )
  expect(
    history.payload.messages,
    layer('persistence', `${step}: new thread has no messages`),
  ).toEqual([])
  const scope: SubscriptionScope = {
    type: 'thread',
    environmentId: host.server.identity.environmentId,
    sessionId: session.sessionId,
    threadId: thread.threadId,
  }
  return { sessionId: session.sessionId, threadId: thread.threadId, scope, history: history.payload }
}

async function reconnectAndOpen(
  host: ProtocolHost,
  scope: SubscriptionScope,
  sessionId: string,
  threadId: string,
  step: string,
) {
  const client = await connectProtocol(host)
  await handshake(client)
  const listed = await listCatalog(client, host, `${step}: catalog`)
  const opened = await expectCommand(client, 'session.open', { sessionId }, `${step}: session.open`)
  expect(
    opened.payload.session.sessionId,
    layer('protocol', `${step}: reopened session id`),
  ).toBe(sessionId)
  const history = await expectCommand(
    client,
    'session.history',
    { sessionId, threadId },
    `${step}: session.history`,
  )
  expect(
    history.payload.turns.length,
    layer('persistence', `${step}: history must still contain the turn`),
  ).toBeGreaterThan(0)
  return { client, listed, opened: opened.payload, history: history.payload, scope }
}

async function replayCaughtUp(
  client: ProtocolClient,
  scope: SubscriptionScope,
  cursor: DurableEvent['cursor'],
  step: string,
) {
  let answer: ReplayResponse
  try {
    answer = await replay(client, scope, cursor)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(layer('protocol', `${step}: subscription.replay failed: ${reason}`))
  }
  expect(answer.payload.mode, layer('protocol', `${step}: reconnect should replay, not snapshot`)).toBe(
    'replay',
  )
  if (answer.payload.mode === 'replay') {
    expect(answer.payload.from.sequence, layer('protocol', `${step}: replay from cursor`)).toBe(
      cursor.sequence,
    )
  }
  return answer
}

async function collectLayer(
  client: ProtocolClient,
  subscriptionId: string,
  until: (records: DurableEvent[]) => boolean,
  step: string,
  timeoutMs?: number,
): Promise<DurableEvent[]> {
  try {
    return await collectThreadRecords(client, subscriptionId, until, timeoutMs)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(layer('protocol', `${step}: ${reason}`))
  }
}

function eventStart(records: DurableEvent[]): string | undefined {
  return records[0]?.event.name
}

function eventNamesOf(records: DurableEvent[]): string[] {
  return records.map((record) => record.event.name)
}
