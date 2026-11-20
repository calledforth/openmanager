import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../../backends/Backend.js'
import { AuthRequiredError, CapabilityMissingError } from '../../core/errors.js'
import { codex } from '../../providers/codex.js'
import { CodexVersionUnsupportedError } from './CodexAppServerClient.js'
import { codexAccountState, CodexProbeRuntime } from './CodexProbeRuntime.js'
import { CodexService } from './CodexService.js'
import { CodexNotInstalledError, type CodexStarter } from './start.js'
import { codexBuilders, fakeCodexStarter, type FakeCodexAppServer } from './testing/index.js'

const { buildAccountResponse, buildModel, buildRequirements } = codexBuilders

const services: CodexService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
})

function serviceOn(start: CodexStarter): CodexService {
  const service = new CodexService({ providerId: 'codex', host: { log: vi.fn() }, start })
  services.push(service)
  return service
}

function build(service: CodexService, events: BackendEvent[] = []) {
  return new CodexProbeRuntime(
    { providerId: 'codex', cwd: '/work', threadId: 'probe-thread' },
    { config: codex, host: { log: vi.fn() }, service, onEvent: (event) => events.push(event) },
  )
}

function onFakes(setup?: (server: FakeCodexAppServer) => void, version?: string) {
  const fakes = fakeCodexStarter(setup, version ? { version } : {})
  return { fakes, service: serviceOn(fakes.start) }
}

describe('codexAccountState', () => {
  // A signed-in account also says `requiresOpenaiAuth: true`; the flag alone
  // must never read as "signed out".
  it('tells signed in, signed out and not required apart', () => {
    const signedIn = buildAccountResponse()
    expect(codexAccountState(signedIn).state).toBe('signed_in')
    expect(codexAccountState({ ...signedIn, account: null }).state).toBe('signed_out')
    expect(
      codexAccountState({ ...signedIn, account: null, requiresOpenaiAuth: false }).state,
    ).toBe('not_required')
  })
})

describe('CodexProbeRuntime', () => {
  it('reads the account, catalog and policy on the service process without a thread', async () => {
    const { fakes, service } = onFakes((server) => {
      server.respond('model/list', (params) =>
        params.cursor === 'page-2'
          ? { data: [buildModel('gpt-6-luna', { inputModalities: ['text'] })], nextCursor: null }
          : {
              data: [buildModel('gpt-6.2-sol', { isDefault: true }), buildModel('secret', { hidden: true })],
              nextCursor: 'page-2',
            },
      )
      server.respond('configRequirements/read', {
        supportsIndependentSpeedModes: true,
        requirements: buildRequirements({ allowedSandboxModes: ['read-only', 'workspace-write'] }),
      })
    })
    const events: BackendEvent[] = []
    const result = await build(service, events).probe()

    const methods = fakes.last.requests().map((request) => request.method)
    expect(methods.some((method) => method.startsWith('thread/') || method.startsWith('turn/'))).toBe(false)
    expect(methods).not.toContain('collaborationMode/list')
    expect(result).toMatchObject({
      authenticated: true,
      accountLabel: 'user@example.com',
      agentInfo: { name: 'Codex', version: '0.170.0' },
      update: { state: 'current', minimumVersion: '0.160.0' },
    })
    expect(result.models?.currentModelId).toBe('gpt-6.2-sol')
    // Hidden models never reach a picker.
    expect(result.models?.availableModels?.map((m) => m.id)).toEqual(['gpt-6.2-sol', 'gpt-6-luna'])
    expect(result.models?.availableModels?.[0]).toMatchObject({
      effortLevels: ['low', 'high'],
      supportsFastMode: true,
      supportsImageInput: true,
    })
    expect(result.models?.availableModels?.[1]?.supportsImageInput).toBe(false)
    expect(result.policy?.blockedModes?.map((block) => block.id)).toEqual(['full-access'])
    expect(events.map((e) => e.event)).toEqual(['process_spawned', 'initialized'])
  })

  it('reports signed out as an auth failure with the login hint, reading nothing else', async () => {
    const { fakes, service } = onFakes((server) =>
      server.respond('account/read', buildAccountResponse({ account: null })),
    )
    const failure = build(service).probe()
    await expect(failure).rejects.toBeInstanceOf(AuthRequiredError)
    await expect(failure).rejects.toMatchObject({ loginHint: 'codex login' })
    expect(fakes.last.requests('model/list')).toHaveLength(0)
  })

  it('treats an account that needs no sign-in as authenticated', async () => {
    const { service } = onFakes((server) =>
      server.respond('account/read', buildAccountResponse({ account: null, requiresOpenaiAuth: false })),
    )
    await expect(build(service).probe()).resolves.toMatchObject({ authenticated: true })
  })

  it('reports an outdated CLI as behind', async () => {
    const { service } = onFakes(undefined, '0.165.0')
    await expect(build(service).probe()).resolves.toMatchObject({
      update: { state: 'behind', latestVersion: '0.170.0' },
    })
  })

  // Health reads ENOENT as "missing", anything after a spawn as "unusable".
  it('surfaces a missing binary as ENOENT and a too-old CLI as its own error', async () => {
    const missing = build(
      serviceOn(async () => {
        throw new CodexNotInstalledError(['codex'])
      }),
    ).probe()
    await expect(missing).rejects.toMatchObject({ code: 'ENOENT' })

    const { service } = onFakes(undefined, '0.150.0')
    const old = build(service).probe()
    await expect(old).rejects.toBeInstanceOf(CodexVersionUnsupportedError)
    await expect(old).rejects.toThrow(/Update Codex to 0\.160\.0 or later/)
  })

  it('is memoised, and probes share the service process', async () => {
    const { fakes, service } = onFakes()
    const probe = build(service)
    await Promise.all([probe.probe(), probe.probe()])
    await probe.listModels('/work')
    expect(fakes.last.requests('account/read')).toHaveLength(1)

    // Review: a probe that found the process running announced a spawn.
    const events: BackendEvent[] = []
    await build(service, events).probe()
    expect(fakes.servers).toHaveLength(1)
    expect(fakes.last.requests('account/read')).toHaveLength(2)
    expect(events.map((event) => event.event)).toEqual(['initialized'])
  })

  it('abandons its questions on dispose and leaves the process to the service', async () => {
    const { fakes, service } = onFakes((server) =>
      server.respond('account/read', () => new Promise(() => undefined)),
    )
    const probe = build(service)
    const probing = probe.probe()
    await vi.waitFor(() => expect(fakes.servers[0]?.requests('account/read')).toHaveLength(1))
    await probe.dispose()
    await expect(probing).rejects.toThrow(/disposed/)
    expect(fakes.last.exited).toBe(false)
    expect(service.status.state).toBe('running')
  })

  // A session deleted while no runtime held its thread.
  it('archives a thread on the service process without reading the account or the catalog', async () => {
    const { fakes, service } = onFakes((server) => server.respond('thread/archive', {}))
    await build(service).archiveSession('thread-9')
    expect(fakes.last.requests().map((request) => request.method)).toEqual([
      'initialize',
      'thread/archive',
    ])
    expect(fakes.last.requests('thread/archive')[0]!.params).toEqual({ threadId: 'thread-9' })
  })

  it('takes a thread Codex no longer has as archived, and throws any other refusal', async () => {
    const gone = onFakes((server) =>
      server.fail('thread/archive', -32600, 'no rollout found for thread id thread-9'),
    )
    await expect(build(gone.service).archiveSession('thread-9')).resolves.toBeUndefined()
    const held = onFakes((server) =>
      server.fail('thread/archive', -32600, 'thread thread-9 already has an active writer'),
    )
    await expect(build(held.service).archiveSession('thread-9')).rejects.toThrow(/active writer/)
  })

  it('does not list sessions', async () => {
    const { service } = onFakes()
    await expect(build(service).listSessions('/work')).rejects.toBeInstanceOf(CapabilityMissingError)
  })
})
