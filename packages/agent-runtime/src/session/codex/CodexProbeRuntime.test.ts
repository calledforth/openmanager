import type { v2 } from '@openmanager/codex-app-server-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../../backends/Backend.js'
import { AuthRequiredError, CapabilityMissingError } from '../../core/errors.js'
import { codex } from '../../providers/codex.js'
import {
  CodexVersionUnsupportedError,
  type CodexAppServerClient,
  type CodexHandshake,
} from './CodexAppServerClient.js'
import { codexAccountState, CodexProbeRuntime } from './CodexProbeRuntime.js'
import { CodexNotInstalledError, type CodexStarter } from './start.js'


const HANDSHAKE: CodexHandshake = {
  userAgent: 'OpenManager/0.170.0 (Linux; x86_64)',
  codexHome: '/home/u/.codex',
  platformFamily: 'unix',
  platformOs: 'linux',
  version: { version: '0.170.0', status: 'supported' },
}

const SIGNED_IN: v2.GetAccountResponse = {
  account: { type: 'chatgpt', email: 'u@example.com', planType: 'plus', workspaceName: null },
  userId: 'user-1',
  requiresOpenaiAuth: true,
  workspaceRouting: null,
}

function model(id: string, extra: Partial<v2.Model> = {}): v2.Model {
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: id.toUpperCase(),
    description: `${id} model`,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'fast' },
      { reasoningEffort: 'high', description: 'thorough' },
    ],
    defaultReasoningEffort: 'low',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    availableAccessPrograms: null,
    isDefault: false,
    ...extra,
  } as v2.Model
}

/** Just enough of `CodexAppServerClient` for the probe: answers by method. */
function stubClient(answers: Record<string, unknown | ((params: unknown) => unknown)>) {
  const requests: Array<{ method: string; params: unknown }> = []
  const terminate = vi.fn(async () => ({ exitCode: 0, signal: null, forced: false, at: '' }))
  const client = {
    info: HANDSHAKE,
    request: vi.fn(async (method: string, params: unknown) => {
      requests.push({ method, params })
      const answer = answers[method]
      if (answer === undefined) throw new Error(`unexpected ${method}`)
      return typeof answer === 'function' ? (answer as (p: unknown) => unknown)(params) : answer
    }),
    terminate,
  }
  return { client: client as unknown as CodexAppServerClient, requests, terminate }
}

function build(start: CodexStarter, events: BackendEvent[] = []) {
  return new CodexProbeRuntime(
    { providerId: 'codex', cwd: '/work', threadId: 'probe-thread' },
    { config: codex, host: { log: vi.fn() }, start, onEvent: (event) => events.push(event) },
  )
}

describe('codexAccountState', () => {
  // A signed-in account also says `requiresOpenaiAuth: true`; the flag alone
  // must never read as "signed out".
  it('tells signed in, signed out and not required apart', () => {
    expect(codexAccountState(SIGNED_IN).state).toBe('signed_in')
    expect(codexAccountState({ ...SIGNED_IN, account: null }).state).toBe('signed_out')
    expect(
      codexAccountState({ ...SIGNED_IN, account: null, requiresOpenaiAuth: false }).state,
    ).toBe('not_required')
  })
})

describe('CodexProbeRuntime', () => {
  it('reads the account and the whole catalog without starting a thread', async () => {
    const { client, requests } = stubClient({
      'account/read': SIGNED_IN,
      'model/list': (params: unknown) =>
        (params as { cursor?: string }).cursor === 'page-2'
          ? { data: [model('gpt-6-luna', { inputModalities: ['text'] })], nextCursor: null }
          : {
              data: [
                model('gpt-6.2-sol', { isDefault: true }),
                model('secret', { hidden: true }),
              ],
              nextCursor: 'page-2',
            },
    })
    const events: BackendEvent[] = []
    const result = await build(async () => client, events).probe()

    expect(requests.map((r) => r.method)).toEqual(['account/read', 'model/list', 'model/list'])
    expect(requests.some((r) => r.method.startsWith('thread/'))).toBe(false)
    expect(result.authenticated).toBe(true)
    expect(result.agentInfo).toEqual({ name: 'Codex', version: '0.170.0' })
    expect(result.models?.currentModelId).toBe('gpt-6.2-sol')
    // Hidden models never reach a picker.
    expect(result.models?.availableModels?.map((m) => m.id)).toEqual(['gpt-6.2-sol', 'gpt-6-luna'])
    expect(result.models?.availableModels?.[0]).toMatchObject({
      displayName: 'GPT-6.2-SOL',
      effortLevels: ['low', 'high'],
      supportsImageInput: true,
    })
    // Codex always says whether a model reads images; text-only is a real "no".
    expect(result.models?.availableModels?.[1]?.supportsImageInput).toBe(false)
    expect(events.map((e) => e.event)).toEqual(['process_spawned', 'initialized'])
  })

  it('reports signed out as an auth failure with the login hint', async () => {
    const { client } = stubClient({ 'account/read': { ...SIGNED_IN, account: null } })
    const failure = build(async () => client).probe()
    await expect(failure).rejects.toBeInstanceOf(AuthRequiredError)
    await expect(failure).rejects.toMatchObject({ loginHint: 'codex login' })
  })

  it('treats an account that needs no sign-in as authenticated', async () => {
    const { client } = stubClient({
      'account/read': { ...SIGNED_IN, account: null, requiresOpenaiAuth: false },
      'model/list': { data: [model('local')], nextCursor: null },
    })
    await expect(build(async () => client).probe()).resolves.toMatchObject({
      authenticated: true,
    })
  })

  // Health reads ENOENT as "missing", anything after a spawn as "unusable".
  it('surfaces a missing binary as ENOENT and a too-old CLI as its own error', async () => {
    const missing = build(async () => {
      throw new CodexNotInstalledError(['codex'])
    }).probe()
    await expect(missing).rejects.toMatchObject({ code: 'ENOENT' })

    const old = build(async () => {
      throw new CodexVersionUnsupportedError('0.150.0')
    }).probe()
    await expect(old).rejects.toThrow(/Update Codex to 0\.160\.0 or later/)
  })

  it('is memoised: a second probe spawns nothing', async () => {
    const { client } = stubClient({
      'account/read': SIGNED_IN,
      'model/list': { data: [model('a')], nextCursor: null },
    })
    const start = vi.fn(async () => client)
    const probe = build(start)
    await Promise.all([probe.probe(), probe.probe()])
    await probe.listModels('/work')
    expect(start).toHaveBeenCalledTimes(1)
  })

  // The health monitor lets the next probe go once dispose resolves, so it
  // must not resolve while a process it started is still on its way up.
  it('waits for a process still starting, and stops it, before dispose resolves', async () => {
    const { client, terminate } = stubClient({})
    let finishStart: (c: CodexAppServerClient) => void = () => undefined
    const probe = build(() => new Promise((resolve) => (finishStart = resolve)))
    const probing = probe.probe()
    let disposed = false
    const disposing = probe.dispose().then(() => (disposed = true))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(disposed).toBe(false)
    finishStart(client)
    await disposing
    await expect(probing).rejects.toThrow(/disposed/)
    expect(terminate).toHaveBeenCalled()
  })

  it('stops the earlier process when a failed probe is retried', async () => {
    const first = stubClient({ 'account/read': { ...SIGNED_IN, account: null } })
    const second = stubClient({
      'account/read': SIGNED_IN,
      'model/list': { data: [model('a')], nextCursor: null },
    })
    const clients = [first.client, second.client]
    const probe = build(async () => clients.shift()!)
    await expect(probe.probe()).rejects.toBeInstanceOf(AuthRequiredError)
    await expect(probe.probe()).resolves.toMatchObject({ authenticated: true })
    expect(first.terminate).toHaveBeenCalledTimes(1)
    expect(second.terminate).not.toHaveBeenCalled()
  })

  it('does not list sessions', async () => {
    await expect(build(async () => stubClient({}).client).listSessions('/work')).rejects.toBeInstanceOf(
      CapabilityMissingError,
    )
  })
})
