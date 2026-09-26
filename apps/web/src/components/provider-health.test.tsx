import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMockEnvironmentClient,
  type MockSeed,
  type ProviderCatalogEntry,
} from '@openmanager/environment-client'
import { ENVIRONMENT_STORAGE_KEY } from '../lib/environment-store'
import { renderWebApp } from '../test-utils'

const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  exists: true,
  capabilities: { git: false, providers: ['opencode'] },
}

const CAPABILITIES: ProviderCatalogEntry['capabilities'] = {
  canSetModel: true,
  canSetMode: true,
  canSetConfigOption: true,
  canDeleteSession: false,
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

const provider = (
  id: string,
  displayName: string,
  health: Partial<ProviderCatalogEntry['health']>,
): ProviderCatalogEntry => ({
  id,
  displayName,
  capabilities: CAPABILITIES,
  health: {
    summary: 'ready',
    refreshing: false,
    install: 'installed',
    auth: 'authenticated',
    runtime: { state: 'never_started', liveProcesses: 0, activeTurns: 0 },
    lastProbe: { outcome: 'ok', at: new Date().toISOString(), durationMs: 12 },
    update: 'current',
    ...health,
  },
})

const seed = (providers: ProviderCatalogEntry[]): MockSeed => ({
  environment: { environmentId: 'env-local', name: 'Local environment' },
  workspaces: [WORKSPACE],
  providers,
})

/** How long a probe stays evidence; mirrors `PROVIDER_HEALTH_STALE_MS`. */
const PROVIDER_HEALTH_STALE_MS = 10 * 60 * 1000

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

function renderConnected(path: string, providers: ProviderCatalogEntry[]) {
  localStorage.setItem(
    ENVIRONMENT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      selectedId: 'env-local',
      environments: [
        {
          environmentId: 'env-local',
          label: 'Local environment',
          endpoints: ['http://127.0.0.1:43120'],
          credential: '',
        },
      ],
    }),
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: ['connection.heartbeat'],
        environmentId: 'env-local',
        label: 'Local environment',
      }),
    })),
  )
  const client = createMockEnvironmentClient({ seed: seed(providers) })
  const result = renderWebApp(path, { createEnvironmentClient: () => client })
  return { ...result, client }
}

describe('provider health on web', () => {
  it('describes each provider the way desktop does and retries a broken one', async () => {
    const user = userEvent.setup()
    const { client } = renderConnected('/settings?tab=providers', [
      provider('opencode', 'OpenCode', {}),
      provider('cursor', 'Cursor', { summary: 'error', auth: 'unauthenticated' }),
      provider('claude', 'Claude Code', { summary: 'error', install: 'missing' }),
    ])
    expect(await screen.findByText('Ready · No session running')).toBeInTheDocument()
    expect(screen.getByText('Sign-in required')).toBeInTheDocument()
    expect(screen.getByText('CLI not found')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry OpenCode' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry Cursor' }))
    await waitFor(() =>
      expect(client.calls.filter((call) => call.command === 'probeProvider')).toEqual([
        expect.objectContaining({
          input: { providerId: 'cursor', workspaceId: WORKSPACE.workspaceId },
        }),
      ]),
    )
    // The mock's health never moves, so the retry comes back still broken.
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to connect to Cursor.')
  })

  it('stops calling a provider ready once its last check is too old to trust', async () => {
    const almostStale = new Date(Date.now() - PROVIDER_HEALTH_STALE_MS + 400).toISOString()
    renderConnected('/settings?tab=providers', [
      provider('opencode', 'OpenCode', {
        lastProbe: { outcome: 'ok', at: almostStale, durationMs: 12 },
      }),
    ])
    expect(await screen.findByText('Ready · No session running')).toBeInTheDocument()
    // No health event arrives; the reading ages out on its own.
    expect(await screen.findByText(/^Not checked yet/, {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry OpenCode' })).toBeInTheDocument()
  })

  it('refuses a new chat against an unhealthy provider before creating a session', async () => {
    const user = userEvent.setup()
    const { client } = renderConnected('/', [
      provider('opencode', 'OpenCode', { summary: 'error', auth: 'unauthenticated' }),
    ])
    await user.click(await screen.findByRole('button', { name: 'New agent' }))
    const textbox = await screen.findByRole('textbox')
    await waitFor(() => expect(textbox).toBeEnabled())
    await user.type(textbox, 'hello')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(/OpenCode is unavailable/)).toBeInTheDocument()
    expect(client.calls.map((call) => call.command)).not.toContain('createSession')
  })
})
