import { describe, expect, it, vi } from 'vitest'
import type { CodexProviderState } from './codex-account.js'
import { CodexProcessExitedError } from './CodexAppServerClient.js'
import { RPC_METHOD_NOT_FOUND } from './CodexRpcPeer.js'
import { PROVIDER_HEALTH_PROBE_TIMEOUT_MS } from '../../core/ProviderHealthMonitor.js'
import { CODEX_SERVICE_REQUEST_MS, CodexService, type CodexServiceDeps } from './CodexService.js'
import { CodexNotInstalledError } from './start.js'
import { codexBuilders, fakeCodexStarter, type FakeCodexAppServer } from './testing/index.js'

const { buildAccountResponse, buildModel, buildRateLimits } = codexBuilders

/** A service on fakes, with the idle timer in the test's hands. */
function build(
  setup?: (server: FakeCodexAppServer, index: number) => void,
  deps: Partial<CodexServiceDeps> = {},
) {
  const fakes = fakeCodexStarter(setup)
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = []
  const service = new CodexService({
    providerId: 'codex',
    host: { log: vi.fn() },
    start: fakes.start,
    cwd: '/home/u',
    setTimer: (run, ms) => {
      const timer = { run, ms, cancelled: false }
      timers.push(timer)
      return { cancel: () => (timer.cancelled = true) }
    },
    ...deps,
  })
  /** Fire the idle timer that is armed now, as if the idle time had passed. */
  const idle = () => {
    const armed = timers.filter((timer) => !timer.cancelled)
    expect(armed).toHaveLength(1)
    armed[0]!.cancelled = true
    armed[0]!.run()
  }
  const armed = () => timers.filter((timer) => !timer.cancelled).length
  return { service, fakes, idle, armed }
}

function nextState(service: CodexService): Promise<CodexProviderState> {
  return new Promise((resolve) => {
    const off = service.onStateChange((state) => {
      off()
      resolve(state)
    })
  })
}

describe('CodexService lifecycle', () => {
  it('starts nothing until asked, then serves every request from one process', async () => {
    const { service, fakes } = build()
    expect(service.status).toEqual({ state: 'stopped', starts: 0 })
    expect(fakes.requests).toHaveLength(0)

    // Concurrent first requests share one start.
    await Promise.all([service.readAccount(), service.readAccount()])
    await service.request('model/list', {})
    expect(fakes.requests).toHaveLength(1)
    expect(fakes.requests[0]!.cwd).toBe('/home/u')
    expect(service.status).toMatchObject({ state: 'running', pid: 5000, starts: 1 })
    expect(service.handshake?.version.version).toBeTruthy()
    await service.shutdown()
  })

  it('stops the process once idle, and starts another on the next request', async () => {
    const { service, fakes, idle } = build()
    await service.readAccount()
    idle()
    await vi.waitFor(() =>
      expect(service.status.lastExit).toMatchObject({ expected: true, reason: 'reaped' }),
    )
    expect(service.status.state).toBe('stopped')
    expect(fakes.servers[0]!.signals).toContain('SIGTERM')

    await service.readAccount()
    expect(fakes.servers).toHaveLength(2)
    expect(service.status).toMatchObject({ state: 'running', starts: 2 })
    await service.shutdown()
  })

  it('is not reaped while a request is in flight', async () => {
    let answer: () => void = () => undefined
    const { service, armed, fakes } = build((server) =>
      server.respond(
        'model/list',
        () => new Promise((resolve) => (answer = () => resolve({ data: [], nextCursor: null }))),
      ),
    )
    const listing = service.request('model/list', {})
    await vi.waitFor(() => expect(fakes.servers[0]?.requests('model/list')).toHaveLength(1))
    expect(armed()).toBe(0)
    answer()
    await listing
    expect(armed()).toBe(1)
    await service.shutdown()
  })

  it('fails what was waiting on a crashed process and starts afresh on the next request', async () => {
    const { service, fakes } = build((server, index) => {
      if (index === 0) server.respond('model/list', () => new Promise(() => undefined))
    })
    const waiting = service.request('model/list', {})
    await vi.waitFor(() => expect(fakes.servers[0]?.requests('model/list')).toHaveLength(1))
    fakes.servers[0]!.crash({ stderr: "thread 'main' panicked at src/x.rs:1:1:\nboom" })

    await expect(waiting).rejects.toBeInstanceOf(CodexProcessExitedError)
    await vi.waitFor(() =>
      expect(service.status.lastExit).toMatchObject({ expected: false, exitCode: 1 }),
    )
    expect(service.status.state).toBe('stopped')

    await expect(service.request('model/list', {})).resolves.toMatchObject({ data: expect.any(Array) })
    expect(fakes.servers).toHaveLength(2)
    expect(service.status).toMatchObject({ state: 'running', starts: 2 })
    await service.shutdown()
  })

  it('replaces a process that stops answering', async () => {
    const { service, fakes } = build((server, index) => {
      if (index === 0) server.respond('model/list', () => new Promise(() => undefined))
    })
    await expect(service.request('model/list', {}, { timeoutMs: 20 })).rejects.toThrow(/did not answer/)
    await vi.waitFor(() =>
      expect(service.status.lastExit).toMatchObject({ expected: true, reason: 'restart' }),
    )
    expect(fakes.servers[0]!.exited).toBe(true)

    await service.request('model/list', {})
    expect(fakes.servers).toHaveLength(2)
    await service.shutdown()
  })

  // Review: the health probe's own timeout aborted the request before the
  // request's timed out, so a hung process was never replaced.
  it('replaces a process whose request was abandoned after it had waited too long', async () => {
    const { service, fakes } = build(
      (server, index) => {
        if (index === 0) server.respond('model/list', () => new Promise(() => undefined))
      },
      { hungAfterMs: 20, requestTimeoutMs: 60_000 },
    )
    const controller = new AbortController()
    const waiting = service.request('model/list', {}, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 40))
    controller.abort(new Error('the probe gave up'))
    await expect(waiting).rejects.toThrow(/gave up/)
    await vi.waitFor(() =>
      expect(service.status.lastExit).toMatchObject({ expected: true, reason: 'restart' }),
    )
    await service.request('model/list', {})
    expect(fakes.servers).toHaveLength(2)
    await service.shutdown()
  })

  it('keeps a process whose request was abandoned at once', async () => {
    const { service, fakes } = build(
      (server) => server.respond('model/list', () => new Promise(() => undefined)),
      { hungAfterMs: 10_000 },
    )
    const controller = new AbortController()
    const waiting = service.request('model/list', {}, { signal: controller.signal })
    await vi.waitFor(() => expect(fakes.servers[0]?.requests('model/list')).toHaveLength(1))
    controller.abort(new Error('not wanted'))
    await expect(waiting).rejects.toThrow(/not wanted/)
    expect(service.status.state).toBe('running')
    expect(fakes.servers[0]!.exited).toBe(false)
    await service.shutdown()
  })

  it('gives every request its own budget, below the health probe timeout', async () => {
    expect(CODEX_SERVICE_REQUEST_MS).toBeLessThan(PROVIDER_HEALTH_PROBE_TIMEOUT_MS)
    const { service, fakes } = build(
      (server, index) => {
        if (index === 0) server.respond('model/list', () => new Promise(() => undefined))
      },
      { requestTimeoutMs: 20 },
    )
    // No timeout named by the caller: the service's own budget applies.
    await expect(service.request('model/list', {})).rejects.toThrow(/did not answer/)
    await vi.waitFor(() => expect(fakes.servers[0]!.exited).toBe(true))
    await service.shutdown()
  })

  // Review: a hung optional read replaced the process and failed `model/list`
  // in the middle of its pages.
  it('lets an optional read time out early without replacing the process', async () => {
    const { service, fakes } = build(
      (server) => {
        server.respond('experimentalFeature/list', () => new Promise(() => undefined))
        server.respond(
          'model/list',
          (params) =>
            params.cursor === 'page-2'
              ? { data: [buildModel('gpt-6-luna')], nextCursor: null }
              : { data: [buildModel('gpt-6.2-sol')], nextCursor: 'page-2' },
          { delayMs: 40 },
        )
      },
      { optionalRequestTimeoutMs: 20 },
    )
    const discovery = await service.discover()
    expect(discovery.models.map((model) => model.id)).toEqual(['gpt-6.2-sol', 'gpt-6-luna'])
    expect(discovery.features).toBeUndefined()
    expect(fakes.servers).toHaveLength(1)
    expect(service.status.state).toBe('running')
    await service.shutdown()
  })

  // Review: shutdown only waited for the current process, not one being
  // reaped or replaced, still in its SIGTERM grace.
  it('waits on shutdown for a process it was already stopping', async () => {
    const fakes = fakeCodexStarter(undefined, { ignoreSigterm: true })
    let reap: () => void = () => undefined
    const service = new CodexService({
      providerId: 'codex',
      host: { log: vi.fn() },
      start: fakes.start,
      setTimer: (run) => {
        reap = run
        return { cancel: () => undefined }
      },
    })
    await service.readAccount()
    reap()
    expect(service.status.state).toBe('stopped')
    expect(fakes.last.exited).toBe(false)
    await service.shutdown()
    // SIGTERM was ignored; shutdown returned only once SIGKILL had landed.
    expect(fakes.last.exited).toBe(true)
    expect(fakes.last.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('reports a start that fails, and tries again on the next request', async () => {
    const fakes = fakeCodexStarter()
    let missing = true
    const service = new CodexService({
      providerId: 'codex',
      host: { log: vi.fn() },
      start: async (request) => {
        if (missing) throw new CodexNotInstalledError(['codex'])
        return fakes.start(request)
      },
    })
    await expect(service.readAccount()).rejects.toMatchObject({ code: 'ENOENT' })
    expect(service.status).toEqual({ state: 'stopped', starts: 0 })
    missing = false
    await expect(service.readAccount()).resolves.toMatchObject({ state: 'signed_in' })
    await service.shutdown()
  })

  it('refuses requests once shut down, and leaves no process behind', async () => {
    const { service, fakes } = build()
    await service.readAccount()
    await service.shutdown()
    expect(fakes.last.exited).toBe(true)
    expect(service.status.state).toBe('stopped')
    await expect(service.readAccount()).rejects.toThrow(/stopped/)
  })
})

describe('CodexService provider-level state', () => {
  it('merges account notifications, which carry no thread, into the account it read', async () => {
    const { service, fakes } = build()
    await service.readAccount()
    expect(service.state.account).toMatchObject({ state: 'signed_in', account: { planType: 'plus' } })

    const upgraded = nextState(service)
    fakes.last.respond('account/read', buildAccountResponse({
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro', workspaceName: null },
    }))
    fakes.last.notify('account/updated', { authMode: 'chatgpt', planType: 'pro' })
    // At once from the update, then confirmed by reading the account again.
    expect((await upgraded).account).toMatchObject({
      state: 'signed_in',
      account: { email: 'user@example.com', planType: 'pro' },
    })
    await vi.waitFor(() => expect(fakes.last.requests('account/read')).toHaveLength(2))
    await vi.waitFor(() => expect(service.state.account).toMatchObject({ account: { planType: 'pro' } }))

    const signedOut = nextState(service)
    fakes.last.notify('account/updated', { authMode: null, planType: null })
    expect((await signedOut).account).toEqual({ state: 'signed_out' })
    await service.shutdown()
  })

  it('merges sparse rate-limit updates into the last full reading', async () => {
    const { service, fakes } = build((server) =>
      server.respond('account/rateLimits/read', {
        ordinaryUsageAllowed: true,
        rateLimits: buildRateLimits(),
        rateLimitsByLimitId: { codex: buildRateLimits() },
        rateLimitResetCredits: null,
        accountId: null,
        rateLimitUpsell: null,
      }),
    )
    await service.readRateLimits()
    const updated = nextState(service)
    fakes.last.notify('account/rateLimits/updated', {
      rateLimits: buildRateLimits({
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
        secondary: null,
        planType: null,
        spendControlReached: null,
      }),
    })
    const state = await updated
    // What the update carried replaces; its nulls keep what was known.
    expect(state.rateLimits?.primary?.usedPercent).toBe(40)
    expect(state.rateLimits?.secondary?.usedPercent).toBe(33)
    expect(state.rateLimits?.planType).toBe('plus')
    expect(state.rateLimitsByLimitId?.codex?.primary?.usedPercent).toBe(40)
    await service.shutdown()
  })

  // T3 Code: another bucket's update, taken as the main one, overwrote it.
  it('keeps another bucket out of the main limits, even before any read', async () => {
    const { service, fakes } = build()
    await service.readAccount()
    const updated = nextState(service)
    fakes.last.notify('account/rateLimits/updated', {
      rateLimits: buildRateLimits({ limitId: 'codex_other' }),
    })
    const state = await updated
    expect(state.rateLimits).toBeUndefined()
    expect(state.rateLimitsByLimitId?.codex_other?.primary?.usedPercent).toBe(1)
    await service.shutdown()
  })

  // Review: one account's limits stayed up after switching to another.
  it('forgets the limits when the account changes', async () => {
    const { service, fakes } = build((server) =>
      server.respond('account/rateLimits/read', {
        ordinaryUsageAllowed: true,
        rateLimits: buildRateLimits(),
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
        accountId: null,
        rateLimitUpsell: null,
      }),
    )
    await service.readAccount()
    await service.readRateLimits()

    // The same login announcing itself again keeps them.
    fakes.last.notify('account/updated', { authMode: 'chatgpt', planType: 'plus' })
    await vi.waitFor(() => expect(fakes.last.requests('account/read')).toHaveLength(2))
    expect(service.state.rateLimits).toBeDefined()

    // A new plan is new limits.
    const planChanged = nextState(service)
    fakes.last.notify('account/updated', { authMode: 'chatgpt', planType: 'pro' })
    expect((await planChanged).rateLimits).toBeUndefined()

    // Another account on the same kind of login: told by the account read.
    await service.readRateLimits()
    fakes.last.respond(
      'account/read',
      buildAccountResponse({
        account: { type: 'chatgpt', email: 'other@example.com', planType: 'plus', workspaceName: null },
      }),
    )
    await service.readAccount()
    expect(service.state.rateLimits).toBeUndefined()
    expect(service.state.rateLimitsByLimitId).toBeUndefined()

    // An API key in place of the login.
    await service.readRateLimits()
    const switched = nextState(service)
    fakes.last.notify('account/updated', { authMode: 'apikey', planType: null })
    expect((await switched).rateLimits).toBeUndefined()
    await service.shutdown()
  })

  // Review: health stayed signed out after signing back in.
  it('reads the account again when Codex says the login changed', async () => {
    const { service, fakes } = build()
    await service.readAccount()
    const out = nextState(service)
    fakes.last.notify('account/updated', { authMode: null, planType: null })
    expect((await out).account).toEqual({ state: 'signed_out' })

    fakes.last.respond(
      'account/read',
      buildAccountResponse({
        account: { type: 'chatgpt', email: 'other@example.com', planType: 'pro', workspaceName: null },
      }),
    )
    fakes.last.notify('account/updated', { authMode: 'chatgpt', planType: 'pro' })
    await vi.waitFor(() =>
      expect(service.state.account).toMatchObject({
        state: 'signed_in',
        account: { email: 'other@example.com' },
      }),
    )
    expect(fakes.last.requests('account/read')).toHaveLength(2)
    await service.shutdown()
  })

  it('forgets the limits on sign-out', async () => {
    const { service, fakes } = build((server) =>
      server.respond('account/rateLimits/read', {
        ordinaryUsageAllowed: true,
        rateLimits: buildRateLimits(),
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
        accountId: null,
        rateLimitUpsell: null,
      }),
    )
    await service.readRateLimits()
    const out = nextState(service)
    fakes.last.notify('account/updated', { authMode: null, planType: null })
    const state = await out
    expect(state.rateLimits).toBeUndefined()
    expect(state.rateLimitsByLimitId).toBeUndefined()
    await service.shutdown()
  })

  it('keeps the merged state across a process restart', async () => {
    const { service, fakes, idle } = build()
    await service.readAccount()
    idle()
    await vi.waitFor(() => expect(service.status.state).toBe('stopped'))
    expect(service.state.account?.state).toBe('signed_in')
    await service.readAccount()
    const update = nextState(service)
    fakes.last.notify('account/updated', { authMode: null, planType: null })
    expect((await update).account).toEqual({ state: 'signed_out' })
    await service.shutdown()
  })
})

describe('CodexService archives', () => {
  // Review: a project's worth of archives went out together; one hung answer
  // replaced the process and failed every other archive on it.
  it('archives one thread at a time, so a hung one fails alone', async () => {
    const { service, fakes } = build(
      (server, index) => {
        if (index === 0)
          server.respond('thread/archive', (params) =>
            params.threadId === 'a' ? (new Promise(() => undefined) as never) : {},
          )
        else server.respond('thread/archive', {})
      },
      { requestTimeoutMs: 30 },
    )
    const archives = ['a', 'b', 'c'].map((id) =>
      service.archiveThread(id).then(
        () => 'ok',
        () => 'failed',
      ),
    )
    await vi.waitFor(() => expect(fakes.servers[0]?.requests('thread/archive')).toHaveLength(1))
    // Only the first is out while it waits.
    expect(fakes.servers[0]!.requests('thread/archive')).toHaveLength(1)
    expect(await Promise.all(archives)).toEqual(['failed', 'ok', 'ok'])
    expect(fakes.servers[1]!.requests('thread/archive').map((r) => r.params.threadId)).toEqual(['b', 'c'])
    await service.shutdown()
  })

  it('tries an archive once more when the process dies under it', async () => {
    const { service, fakes } = build((server, index) => {
      if (index === 0)
        server.respond('thread/archive', () => {
          setTimeout(() => server.crash(), 1)
          return new Promise(() => undefined) as never
        })
      else server.respond('thread/archive', {})
    })
    await expect(service.archiveThread('a')).resolves.toBeUndefined()
    expect(fakes.servers).toHaveLength(2)
    expect(fakes.servers[1]!.requests('thread/archive')[0]!.params).toEqual({ threadId: 'a' })
    await service.shutdown()
  })
})

describe('CodexService discovery', () => {
  it('reads account, catalog, profiles, policy and flags without a thread or plan mode', async () => {
    const { service, fakes } = build((server) =>
      server.respond('model/list', (params) =>
        params.cursor === 'page-2'
          ? { data: [buildModel('gpt-6-luna')], nextCursor: null }
          : { data: [buildModel('gpt-6.2-sol', { isDefault: true })], nextCursor: 'page-2' },
      ),
    )
    const discovery = await service.discover({ cwd: '/work' })

    expect(discovery.account.state).toBe('signed_in')
    expect(discovery.models.map((model) => model.id)).toEqual(['gpt-6.2-sol', 'gpt-6-luna'])
    expect(discovery.permissionProfiles?.map((profile) => profile.id)).toEqual([
      ':read-only',
      ':workspace',
      ':danger-full-access',
    ])
    expect(discovery.requirements).toEqual({ supportsIndependentSpeedModes: true, requirements: null })
    expect(discovery.features).toEqual({ fast_mode: true, guardian_approval: true })
    expect(discovery.webSearch).toBeNull()
    expect(fakes.last.requests('config/read')[0]!.params).toEqual({ cwd: '/work' })

    const methods = fakes.last.requests().map((request) => request.method)
    expect(methods.filter((method) => method !== 'initialize').sort()).toEqual(
      [
        'account/read',
        'config/read',
        'configRequirements/read',
        'experimentalFeature/list',
        'model/list',
        'model/list',
        'permissionProfile/list',
      ].sort(),
    )
    expect(fakes.last.requests('permissionProfile/list')[0]!.params).toEqual({ cwd: '/work' })
    expect(fakes.last.requests('model/list')[0]!.params).toEqual({})
    await service.shutdown()
  })

  it('goes on without what an older CLI cannot answer', async () => {
    const { service } = build((server) => {
      server.fail('permissionProfile/list', RPC_METHOD_NOT_FOUND, 'unknown method')
      server.fail('experimentalFeature/list', RPC_METHOD_NOT_FOUND, 'unknown method')
    })
    const discovery = await service.discover()
    expect(discovery.models).toHaveLength(1)
    expect(discovery.permissionProfiles).toBeUndefined()
    expect(discovery.features).toBeUndefined()
    expect(discovery.requirements).toBeDefined()
    await service.shutdown()
  })

  it('stops at the account when signed out', async () => {
    const { service, fakes } = build((server) =>
      server.respond('account/read', buildAccountResponse({ account: null })),
    )
    const discovery = await service.discover()
    expect(discovery.account).toEqual({ state: 'signed_out' })
    expect(fakes.last.requests().map((request) => request.method)).toEqual(['initialize', 'account/read'])
    await service.shutdown()
  })
})
