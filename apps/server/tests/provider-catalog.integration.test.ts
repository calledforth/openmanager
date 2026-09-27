import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeClaudeSdk, FakeConnectionFactory } from '@agentpack/runtime/testing'
import type { AgentRuntimeOptions } from '@agentpack/runtime/node'
import { startServer } from '../src/server.js'
import {
  cleanupProtocolHosts,
  connectProtocol,
  handshake,
  nextResponse,
  startProtocolHost,
} from './helpers/protocol-client.js'
import { expectCommand } from './helpers/proof-slice.js'

const servers: Array<Awaited<ReturnType<typeof startServer>>> = []
const directories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await cleanupProtocolHosts()
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const CURSOR_LISTING = {
  models: [
    { value: 'composer-2.5', name: 'Composer 2.5' },
    { value: 'gpt-5.4', name: 'GPT-5.4' },
  ],
}
const OPENCODE_LISTING = [
  'opencode/big-pickle',
  JSON.stringify({
    id: 'big-pickle',
    providerID: 'opencode',
    name: 'Big Pickle',
    capabilities: { input: { text: true, image: false } },
  }),
].join('\n')

/** Every provider faked at its own seam: nothing here spawns a CLI. */
function providers() {
  // The runtime checks that the executable exists before the fake SDK takes
  // over, and the CI runners have no Claude Code. Any executable will do.
  vi.stubEnv('CLAUDE_CODE_BIN', process.execPath)
  const newSession = vi.fn(async () => ({ sessionId: 'never-opened' }))
  const connections = new FakeConnectionFactory({
    initialize: async () => ({
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: { promptCapabilities: { image: true } },
    }),
    request: async (method) => (method === 'cursor/list_available_models' ? CURSOR_LISTING : {}),
    newSession,
  })
  const execFile = vi.fn(async () => ({ stdout: OPENCODE_LISTING }))
  const runtimeOptions: AgentRuntimeOptions = {
    connections,
    claudeSdk: new FakeClaudeSdk(),
    execFile,
    health: { schedule: () => ({ cancel() {} }) },
  }
  return { runtimeOptions, connections, execFile, newSession }
}

type Host = Awaited<ReturnType<typeof startProtocolHost>>

const models = (host: Host, providerId: string) =>
  host.server.composerStore.getProfile(providerId)?.availableModels

const spawnedIn = (connections: FakeConnectionFactory) =>
  connections.connections.map(({ spec }) => `${spec.providerId}@${spec.cwd}`)

describe('a provider nobody has opened', () => {
  it('is probed at boot in the registered workspace and offered with its models', async () => {
    const { runtimeOptions, connections, execFile, newSession } = providers()
    const host = await startProtocolHost({ probeProviders: true, runtimeOptions })

    await vi.waitFor(() => {
      expect(models(host, 'cursor')).toEqual([
        { modelId: 'composer-2.5', name: 'Composer 2.5' },
        { modelId: 'gpt-5.4', name: 'GPT-5.4' },
      ])
      expect(models(host, 'opencode')).toEqual([
        { modelId: 'opencode/big-pickle', name: 'opencode/Big Pickle', supportsImageInput: false },
      ])
    })
    // No client named a folder, and nothing was opened to find any of it out.
    // The registry's own spelling of the root: a temp directory can reach the
    // test under a short name the registry has already resolved.
    const root = host.server.workspaces.get(host.workspaceId)?.root
    expect(root).toBeDefined()
    expect(spawnedIn(connections)).toEqual([`cursor@${root}`, `opencode@${root}`])
    expect(newSession).not.toHaveBeenCalled()
    // The listing already said whether each model reads images.
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(host.server.composerStore.getProfile('cursor')?.promptCapabilities).toEqual({
      image: true,
      audio: false,
      embeddedContext: false,
    })

    // What a client's picker is built from.
    const client = await connectProtocol(host)
    await handshake(client)
    const catalog = await nextResponse(client, client.command('provider.catalog.get', null))
    expect(catalog).toMatchObject({
      type: 'response',
      payload: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'cursor',
            profile: expect.objectContaining({
              availableModels: [
                { modelId: 'composer-2.5', name: 'Composer 2.5' },
                { modelId: 'gpt-5.4', name: 'GPT-5.4' },
              ],
            }),
          }),
          expect.objectContaining({
            id: 'opencode',
            profile: expect.objectContaining({
              availableModels: [expect.objectContaining({ modelId: 'opencode/big-pickle' })],
            }),
          }),
        ]),
      },
    })
  })

  it('is probed as soon as the first workspace is added', async () => {
    const { runtimeOptions, connections } = providers()
    const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-catalog-test-'))
    directories.push(dataDir)
    const server = await startServer({
      port: 0,
      dataDir,
      logLevel: 'silent',
      probeProviders: true,
      runtimeOptions,
    })
    servers.push(server)
    // Nowhere to run a provider yet, so nothing is.
    await server.runtime.health.drain()
    expect(connections.connections).toHaveLength(0)

    const added = join(dataDir, 'added-later')
    await mkdir(added)
    expect(server.workspaces.register({ path: added })).toMatchObject({ ok: true })

    await vi.waitFor(() =>
      expect(server.composerStore.getProfile('cursor')?.availableModels).toHaveLength(2),
    )
    expect(spawnedIn(connections)[0]).toBe(`cursor@${server.workspaces.mostRecent()?.root}`)
  })

  it('stays unprobed on a server that was not asked to probe', async () => {
    const { runtimeOptions, connections, execFile } = providers()
    const host = await startProtocolHost({ runtimeOptions })
    const client = await connectProtocol(host)
    await handshake(client)
    await expectCommand(client, 'workspace.list', null, 'list')

    expect(connections.connections).toHaveLength(0)
    expect(execFile).not.toHaveBeenCalled()
    expect(models(host, 'cursor')).toBeUndefined()
  })
})
