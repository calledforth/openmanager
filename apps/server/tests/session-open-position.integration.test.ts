import { afterEach, describe, expect, it } from 'vitest'
import { FakeConnectionFactory } from '@agentpack/runtime/testing'
import {
  cleanupProtocolHosts,
  connectProtocol,
  handshake,
  startProtocolHost,
} from './helpers/protocol-client.js'
import { expectCommand } from './helpers/proof-slice.js'

afterEach(async () => {
  await cleanupProtocolHosts()
})

/**
 * A read has no place of its own in the event stream, so the answer states
 * one: the heads of the streams that change what it read, taken as it read.
 */
describe('the answer to session.open', () => {
  it('states the heads of the environment and session streams it read at', async () => {
    let workspaceRoot = ''
    const host = await startProtocolHost({
      runtimeOptions: {
        connections: new FakeConnectionFactory({
          initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
          newSession: async () => ({ sessionId: 'stub-session' }),
        }),
        health: { schedule: () => ({ cancel() {} }) },
      },
      resolveWorkspace: () => ({
        providerId: 'opencode',
        providers: ['opencode'],
        cwd: workspaceRoot,
      }),
    })
    workspaceRoot = host.workspaceRoot
    const client = await connectProtocol(host)
    await handshake(client)
    const environmentId = host.server.identity.environmentId
    const created = await expectCommand(
      client,
      'session.create',
      { environmentId, providerId: 'opencode', workspaceId: host.workspaceId },
      'create',
    )
    const { sessionId } = created.payload.session

    const first = await expectCommand(client, 'session.open', { sessionId }, 'open')
    const { environment, session } = first.payload.at
    expect(environment.scope).toEqual({ type: 'environment', environmentId })
    expect(environment.sequence).toBeGreaterThan(0)
    // `thread.created` is the session stream's first record.
    expect(session).toMatchObject({
      scope: { type: 'session', environmentId, sessionId },
      sequence: 1,
    })

    await expectCommand(client, 'session.rename', { sessionId, title: 'Renamed' }, 'rename')
    const second = await expectCommand(client, 'session.open', { sessionId }, 'open again')
    // The rename is on the environment stream, and this read includes it.
    expect(second.payload.session.title).toBe('Renamed')
    expect(second.payload.at.environment.epoch).toBe(environment.epoch)
    expect(second.payload.at.environment.sequence).toBeGreaterThan(environment.sequence)
    expect(second.payload.at.session).toEqual(session)
  })
})
