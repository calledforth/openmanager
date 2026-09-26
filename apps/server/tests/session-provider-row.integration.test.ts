import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeClaudeSdk, FakeConnectionFactory } from '@agentpack/runtime/testing'
import {
  cleanupProtocolHosts,
  connectProtocol,
  handshake,
  startProtocolHost,
} from './helpers/protocol-client.js'
import { expectCommand } from './helpers/proof-slice.js'

afterEach(async () => {
  vi.unstubAllEnvs()
  await cleanupProtocolHosts()
})

/**
 * `session.list` and `session.open` answer from the projected session row,
 * and the host binds the row's provider to the thread service. This drives
 * the real server so a miswired binding fails it, not only the service.
 */
describe('a session created on a provider other than the workspace default', () => {
  it('is listed and opened on its own provider before its runtime has started', async () => {
    // The runtime checks that the executable exists before the fake SDK takes
    // over, and the CI runners have no Claude Code. Any executable will do.
    vi.stubEnv('CLAUDE_CODE_BIN', process.execPath)
    const claude = new FakeClaudeSdk()
    // The runtime stamp follows the provider's handshake. Held, so the row
    // has to be right on its own.
    let releaseHandshake!: () => void
    const handshakeHeld = new Promise<void>((resolve) => {
      releaseHandshake = resolve
    })
    claude.prepare = (query) => {
      const initialize = query.initializationResult.bind(query)
      query.initializationResult = () => handshakeHeld.then(initialize)
    }
    let workspaceRoot = ''
    const host = await startProtocolHost({
      runtimeOptions: {
        connections: new FakeConnectionFactory({
          initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
          newSession: async () => ({ sessionId: 'stub-session' }),
        }),
        claudeSdk: claude,
        health: { schedule: () => ({ cancel() {} }) },
      },
      resolveWorkspace: () => ({
        providerId: 'opencode',
        providers: ['opencode', 'claude'],
        cwd: workspaceRoot,
      }),
    })
    workspaceRoot = host.workspaceRoot
    const client = await connectProtocol(host)
    await handshake(client)

    try {
      const created = await expectCommand(
        client,
        'session.create',
        {
          environmentId: host.server.identity.environmentId,
          providerId: 'claude',
          workspaceId: host.workspaceId,
        },
        'create',
      )
      const { sessionId } = created.payload.session
      // The provider did start, on the requested provider, and is still in
      // its handshake while the reads below are answered.
      await vi.waitFor(() => expect(claude.queries).toHaveLength(1))

      const listed = await expectCommand(client, 'session.list', {}, 'list')
      expect(listed.payload.sessions).toMatchObject([{ sessionId, providerId: 'claude' }])
      const opened = await expectCommand(client, 'session.open', { sessionId }, 'open')
      expect(opened.payload.session).toMatchObject({ sessionId, providerId: 'claude' })
    } finally {
      // A failed assertion must not leave the host's shutdown waiting on it.
      releaseHandshake()
    }
  })
})
