import { afterEach, describe, expect, it } from 'vitest'
import { FakeClaudeSdk, FakeConnectionFactory } from '@agentpack/runtime/testing'
import {
  type DurableEvent,
  type ReplayResponse,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import {
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  handshake,
  nextResponse,
  replay,
  startProtocolHost,
} from './helpers/protocol-client.js'
import { expectCommand } from './helpers/proof-slice.js'

afterEach(cleanupProtocolHosts)

const MODES = {
  currentModeId: 'agent',
  availableModes: [
    { id: 'agent', name: 'Agent' },
    { id: 'plan', name: 'Plan' },
  ],
}

async function startHost() {
  const connections = new FakeConnectionFactory({
    initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
    newSession: async () => ({ sessionId: 'stub-session', modes: MODES }),
    setSessionMode: async () => ({}),
  })
  let workspaceRoot = ''
  const host = await startProtocolHost({
    runtimeOptions: {
      connections,
      claudeSdk: new FakeClaudeSdk(),
      health: { schedule: () => ({ cancel() {} }) },
    },
    resolveWorkspace: () => ({ providerId: 'cursor', cwd: workspaceRoot }),
  })
  workspaceRoot = host.workspaceRoot
  const scope: SubscriptionScope = {
    type: 'environment',
    environmentId: host.server.identity.environmentId,
  }
  return { host, connections, scope }
}

/** Despite its name the helper collects any subscription's records, held ones included. */
const collect = collectThreadRecords

const composerOf = (records: DurableEvent[], sessionId: string) =>
  records.flatMap((record) =>
    record.event.name === 'session.composer.updated' && record.event.payload.sessionId === sessionId
      ? [record.event.payload.composer]
      : [],
  )

const live = (response: ReplayResponse) => response.payload.subscriptionId

describe('composer state across clients', () => {
  it('shows a second client the mode the first one set, and a mode the agent switched itself', async () => {
    const { host, connections, scope } = await startHost()
    const first = await connectProtocol(host)
    await handshake(first)
    const second = await connectProtocol(host)
    await handshake(second)
    const watching = live(await replay(second, scope, null))

    const created = await expectCommand(
      first,
      'session.create',
      {
        environmentId: host.server.identity.environmentId,
        providerId: 'cursor',
        workspaceId: host.workspaceId,
      },
      'create',
    )
    const sessionId = created.payload.session.sessionId
    // The provider's own report seeds the selection before anyone touches it.
    const seeded = await collect(second, watching, (records) =>
      composerOf(records, sessionId).some((composer) => composer.modeId === 'agent'),
    )
    expect(composerOf(seeded, sessionId).at(-1)).toMatchObject({ modeId: 'agent' })

    const requestId = first.command('composer.mode.set', { sessionId, modeId: 'plan' })
    expect(await nextResponse(first, requestId)).toMatchObject({
      type: 'response',
      payload: { preference: { modeId: 'plan' } },
    })
    // The session's own change, and the "last used" preference it leaves for drafts.
    await collect(
      second,
      watching,
      (records) =>
        composerOf(records, sessionId).some((composer) => composer.modeId === 'plan') &&
        records.some(
          (record) =>
            record.event.name === 'composer.preferences.updated' &&
            record.event.payload.preference.modeId === 'plan',
        ),
    )

    // Nobody sent a command for this one: the agent left plan mode on its own.
    await connections.last.sessionUpdate({
      sessionId: 'stub-session',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'agent' },
    })
    const switched = await collect(second, watching, (records) =>
      composerOf(records, sessionId).some((composer) => composer.modeId === 'agent'),
    )
    expect(composerOf(switched, sessionId).at(-1)).toMatchObject({ modeId: 'agent' })
  })

  it('restores the current selection on reconnect, from replay and from a snapshot', async () => {
    const { host, scope } = await startHost()
    const first = await connectProtocol(host)
    await handshake(first)
    const joined = await replay(first, scope, null)
    if (joined.payload.mode !== 'snapshot') throw new Error('expected an initial snapshot')
    const cursor = joined.payload.snapshot.cursor
    const created = await expectCommand(
      first,
      'session.create',
      {
        environmentId: host.server.identity.environmentId,
        providerId: 'cursor',
        workspaceId: host.workspaceId,
      },
      'create',
    )
    const sessionId = created.payload.session.sessionId
    await collect(first, live(joined), (records) =>
      composerOf(records, sessionId).some((composer) => composer.modeId === 'agent'),
    )
    const requestId = first.command('composer.mode.set', { sessionId, modeId: 'plan' })
    await nextResponse(first, requestId)
    await collect(first, live(joined), (records) =>
      composerOf(records, sessionId).some((composer) => composer.modeId === 'plan'),
    )

    // A client that was away replays exactly what it missed.
    const returning = await connectProtocol(host)
    await handshake(returning)
    const replayed = await replay(returning, scope, cursor)
    if (replayed.payload.mode !== 'replay') throw new Error('expected a replay')
    expect(composerOf(replayed.payload.events, sessionId).at(-1)).toMatchObject({ modeId: 'plan' })

    // A client with no cursor gets it on the session summary instead.
    const fresh = await connectProtocol(host)
    await handshake(fresh)
    const snapshot = await replay(fresh, scope, null)
    if (snapshot.payload.mode !== 'snapshot') throw new Error('expected a snapshot')
    const state = snapshot.payload.snapshot.state
    if (!('sessions' in state)) throw new Error('expected an environment snapshot')
    expect(
      state.sessions.find((session) => session.sessionId === sessionId)?.composer,
    ).toMatchObject({ modeId: 'plan' })

    const listed = await expectCommand(fresh, 'session.list', {}, 'list')
    expect(
      listed.payload.sessions.find((session) => session.sessionId === sessionId)?.composer,
    ).toMatchObject({ modeId: 'plan' })
  })
})
