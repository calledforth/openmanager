// @vitest-environment jsdom
import { act, useContext } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ComposerStateContext,
  EnvironmentApplicationProviders,
  EnvironmentClientProvider,
  PlatformCapabilitiesContext,
  type PlatformCapabilitiesValue,
} from '@openmanager/app-core/logic'
import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
  type MockSeed,
} from '@openmanager/environment-client'
import type { ProviderHealth } from '@openmanager/protocol'

import { providerHealthRows } from '../src/settings/providers'
import {
  createTitleSetting,
  FIRST_TOOL,
  TITLE_TOOLS,
  titleModels,
  titleSummary,
} from '../src/settings/title-generation'

const NOW = Date.parse('2026-10-22T12:00:00.000Z')
const CAPABILITIES = {
  canSetModel: true,
  canSetMode: true,
  canSetConfigOption: false,
  canDeleteSession: true,
  canLoadSession: true,
  canListSessions: true,
  canCancelPrompt: true,
  supportsPlans: false,
  supportsAvailableCommands: false,
  supportsUsage: false,
  supportsPermissionRequests: true,
  supportsAuthentication: false,
  supportsThoughtStreaming: false,
  supportsSubtasks: false,
  supportsExtensions: false,
  supportsQuestions: false,
}
const health = (patch: Partial<ProviderHealth>): ProviderHealth => ({
  summary: 'ready',
  refreshing: false,
  install: 'installed',
  auth: 'authenticated',
  runtime: { state: 'running', liveProcesses: 1, activeTurns: 0 },
  lastProbe: { outcome: 'ok', at: new Date(NOW - 60_000).toISOString(), durationMs: 40 },
  update: 'current',
  ...patch,
})
const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false, providers: ['claude', 'cursor'] },
  exists: true,
}
const SEED: MockSeed = {
  workspaces: [WORKSPACE],
  providers: [
    { id: 'claude', displayName: 'Claude Code', capabilities: CAPABILITIES, health: health({}) },
    {
      id: 'cursor',
      displayName: 'Cursor',
      capabilities: CAPABILITIES,
      health: health({
        summary: 'error',
        install: 'missing',
        runtime: { state: 'never_started', liveProcesses: 0, activeTurns: 0 },
        lastProbe: { outcome: 'failed', at: new Date(NOW - 60_000).toISOString(), durationMs: 40 },
      }),
    },
  ],
  environmentSettings: { titleGeneration: { provider: 'claude', model: '' } },
}

let container: HTMLDivElement
let root: Root
let platform: PlatformCapabilitiesValue | null = null
let profiles: unknown = null
function Probe() {
  platform = useContext(PlatformCapabilitiesContext)
  profiles = useContext(ComposerStateContext)?.providerComposerProfiles ?? null
  return null
}
const clients: MockEnvironmentClient[] = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  platform = null
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  for (const client of clients.splice(0)) client.dispose()
  vi.unstubAllGlobals()
})
const flush = async (rounds = 6) => {
  for (let round = 0; round < rounds; round += 1) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}
const settle = async () => {
  for (let round = 0; round < 6; round += 1) await new Promise((done) => setTimeout(done, 0))
}

async function mount(seed: MockSeed = SEED) {
  const client = createMockEnvironmentClient({ seed })
  clients.push(client)
  await act(() =>
    root.render(
      <EnvironmentClientProvider client={client}>
        <EnvironmentApplicationProviders storage={null} navigateDraft={async () => undefined}>
          <Probe />
        </EnvironmentApplicationProviders>
      </EnvironmentClientProvider>,
    ),
  )
  await flush()
  return client
}

describe('provider health on Settings', () => {
  it('reads each provider in the shared words, marking which can be re-checked', async () => {
    await mount()
    const rows = providerHealthRows(platform!, NOW)
    expect(
      rows.map((row) => [row.providerId, row.health.label, row.health.tone, row.health.canRetry]),
    ).toEqual([
      ['claude', 'Ready', 'ready', false],
      ['cursor', 'CLI not found', 'error', true],
    ])
    // The name stays for the screen reader; the screen shows the mark.
    expect(rows[0]!.name).toBe('Claude Code')
  })

  it('probes a provider in a registered workspace through the shared platform', async () => {
    const client = await mount()
    await act(() => platform!.retryProvider('cursor'))
    await flush()
    expect(client.calls.filter((call) => call.command === 'probeProvider')).toEqual([
      {
        command: 'probeProvider',
        input: { providerId: 'cursor', workspaceId: WORKSPACE.workspaceId },
      },
    ])
  })

  it('says so when there is no workspace to probe in', async () => {
    await mount({ ...SEED, workspaces: [] })
    await act(() => platform!.retryProvider('cursor'))
    await flush()
    expect(platform!.error).toBe('Add a workspace to check providers.')
  })
})

describe('the session titles setting', () => {
  it('reads the environment’s value, then saves picks and shows the answer', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    clients.push(client)
    const setting = createTitleSetting(client)
    setting.start()
    expect(setting.getState().saved).toBeNull()
    await settle()
    expect(setting.getState().saved).toEqual({ provider: 'claude', model: '' })

    expect(await setting.save({ provider: 'claude', model: 'sonnet' })).toBe(true)
    expect(setting.getState().saved).toEqual({ provider: 'claude', model: 'sonnet' })
    expect(
      client.calls.filter((call) => call.command === 'setEnvironmentSettings').at(-1)!.input,
    ).toEqual({ titleGeneration: { provider: 'claude', model: 'sonnet' } })
  })

  it('turns off, and back on with what was in use before', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    clients.push(client)
    const setting = createTitleSetting(client)
    setting.start()
    await settle()
    await setting.save({ provider: 'opencode', model: 'anthropic/haiku' })
    await setting.toggle()
    expect(setting.getState().saved).toEqual({ provider: 'off', model: '' })
    await setting.toggle()
    expect(setting.getState().saved).toEqual({ provider: 'opencode', model: 'anthropic/haiku' })
  })

  it('switching on from nothing picks the environment’s default tool', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEED, environmentSettings: { titleGeneration: { provider: 'off', model: '' } } },
    })
    clients.push(client)
    const setting = createTitleSetting(client)
    setting.start()
    await settle()
    await setting.toggle()
    expect(setting.getState().saved).toEqual({ provider: FIRST_TOOL, model: '' })
  })

  it('recovers from a read the connection dropped: the reconnect reads again', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    clients.push(client)
    let first = true
    const read = client.commands.getEnvironmentSettings
    client.commands.getEnvironmentSettings = () => {
      if (!first) return read()
      first = false
      // The socket drops while the read is out.
      client.setConnection({ phase: 'reconnecting' })
      return Promise.reject(new Error('The connection closed.'))
    }
    const setting = createTitleSetting(client)
    setting.start()
    await settle()
    expect(setting.getState()).toMatchObject({ saved: null, error: 'The connection closed.' })
    client.setConnection({ phase: 'connected' })
    await settle()
    expect(setting.getState()).toMatchObject({
      saved: { provider: 'claude', model: '' },
      error: null,
    })
  })

  it('reads again on retry after a refusal', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    clients.push(client)
    let refuse = true
    const read = client.commands.getEnvironmentSettings
    client.commands.getEnvironmentSettings = () =>
      refuse ? Promise.reject(new Error('Busy.')) : read()
    const setting = createTitleSetting(client)
    setting.start()
    await settle()
    expect(setting.getState().error).toBe('Busy.')
    refuse = false
    setting.retry()
    await settle()
    expect(setting.getState().saved).toEqual({ provider: 'claude', model: '' })
  })

  it('picks nothing before the environment’s value is known', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    clients.push(client)
    const setting = createTitleSetting(client)
    expect(await setting.save({ provider: 'codex', model: '' })).toBe(false)
    expect(client.calls.map((call) => call.command)).not.toContain('setEnvironmentSettings')
  })

  it('lists each tool’s default first, then what its catalog names', async () => {
    await mount()
    const claude = titleModels('claude', platform!.providers, profiles as never, null)
    expect(claude[0]).toMatchObject({ id: '', name: 'haiku (default)' })
    const codex = titleModels('codex', platform!.providers, profiles as never, {
      provider: 'codex',
      model: 'gpt-x',
    })
    expect(codex.map((model) => model.id)).toEqual(['', 'gpt-x'])
    expect(TITLE_TOOLS).toEqual(['claude', 'cursor', 'opencode', 'codex'])
    expect(titleSummary({ provider: 'codex', model: '' }, codex)).toBe('gpt-6-luna (default)')
    expect(titleSummary({ provider: 'off', model: '' }, codex)).toMatch(/^Off/)
  })
})
