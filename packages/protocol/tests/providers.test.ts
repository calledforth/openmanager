import { describe, expect, it } from 'vitest'
import {
  BootstrapResponseSchema,
  PROTOCOL_VERSION,
  PROVIDER_DISCOVERY_CAPABILITY,
  PROVIDER_HEALTH_CAPABILITY,
  ProviderHealthChangedEventSchema,
  ProviderProbeCommandSchema,
} from '@openmanager/protocol'

const health = {
  summary: 'unknown',
  refreshing: false,
  install: 'unknown',
  auth: 'unknown',
  runtime: { state: 'never_started', liveProcesses: 0, activeTurns: 0 },
  lastProbe: null,
  update: 'unknown',
} as const

const provider = {
  id: 'cursor',
  displayName: 'Cursor',
  capabilities: {
    canSetModel: true,
    canSetMode: true,
    canSetConfigOption: true,
    canDeleteSession: true,
    canLoadSession: true,
    canListSessions: true,
    canCancelPrompt: true,
    supportsPlans: true,
    supportsAvailableCommands: true,
    supportsUsage: true,
    supportsPermissionRequests: true,
    supportsAuthentication: true,
    supportsThoughtStreaming: true,
    supportsSubtasks: true,
    supportsExtensions: true,
    supportsQuestions: true,
  },
  health,
} as const

describe('provider service wire contract', () => {
  it('requires a provider snapshot when discovery or health is advertised', () => {
    const bootstrap = {
      protocolVersion: PROTOCOL_VERSION,
      environmentId: 'env-1',
      capabilities: [PROVIDER_DISCOVERY_CAPABILITY, PROVIDER_HEALTH_CAPABILITY],
    }
    expect(BootstrapResponseSchema.safeParse(bootstrap).success).toBe(false)
    expect(
      BootstrapResponseSchema.parse({ ...bootstrap, providers: [provider] }).providers,
    ).toEqual([provider])
  })

  it('rejects duplicate provider identities in bootstrap', () => {
    expect(
      BootstrapResponseSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        environmentId: 'env-1',
        capabilities: [PROVIDER_DISCOVERY_CAPABILITY],
        providers: [provider, provider],
      }).success,
    ).toBe(false)
  })

  it('validates provider probe commands and health transition events', () => {
    expect(
      ProviderProbeCommandSchema.parse({
        type: 'command',
        requestId: 'probe-1',
        name: 'provider.probe',
        payload: { providerId: 'cursor', cwd: 'C:\\workspace' },
      }),
    ).toMatchObject({ name: 'provider.probe' })
    expect(
      ProviderHealthChangedEventSchema.parse({
        type: 'event',
        name: 'provider_health_changed',
        payload: { providerId: 'cursor', health },
      }),
    ).toMatchObject({ payload: { providerId: 'cursor' } })
  })
})
