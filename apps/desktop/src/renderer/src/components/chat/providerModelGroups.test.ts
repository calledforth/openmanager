import { describe, expect, it } from 'vitest'
import type { ProviderCapabilities, ProviderMetadata } from '@agentpack/contract'
import type { ProviderComposerProfiles } from '../../../../shared/composer-profile'
import { buildProviderModelGroups, metadataModelOptions } from './providerModelGroups'

const CAPABILITIES = {} as ProviderCapabilities

const PROVIDER_OPTIONS = [
  { id: 'cursor', name: 'Cursor' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'claude', name: 'Claude Code' },
] as const

/** Cursor and OpenCode learn their models from session events, so their
 * metadata never carries a catalog — exactly the shape the probe leaves them
 * in. Claude Code answers at handshake time, so its probe fills one in. */
const PROVIDERS: ProviderMetadata[] = [
  { id: 'cursor', displayName: 'Cursor', capabilities: CAPABILITIES },
  { id: 'opencode', displayName: 'OpenCode', capabilities: CAPABILITIES },
  {
    id: 'claude',
    displayName: 'Claude Code',
    capabilities: CAPABILITIES,
    models: {
      availableModels: [
        { id: 'sonnet', displayName: 'Sonnet' },
        { id: 'opus', displayName: 'Opus' },
      ],
    },
  },
]

const CURSOR_PROFILE: ProviderComposerProfiles = {
  cursor: {
    availableModels: [{ modelId: 'composer-2.5', name: 'Composer 2.5' }],
    updatedAt: 1,
  },
}

describe('buildProviderModelGroups', () => {
  it('gives a never-used provider the models its metadata already knows', () => {
    // The bug: with no composer profile for Claude Code its group was empty,
    // the picker hides empty groups, and a provider you cannot pick can never
    // produce the session events that would have filled the profile.
    const groups = buildProviderModelGroups({
      providerOptions: PROVIDER_OPTIONS,
      currentProviderId: 'cursor',
      currentModels: [{ id: 'composer-2.5', name: 'Composer 2.5' }],
      composerProfiles: CURSOR_PROFILE,
      providers: PROVIDERS,
    })

    expect(groups.find((group) => group.providerId === 'claude')?.models).toEqual([
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'opus', name: 'Opus' },
    ])
  })

  it('leaves providers whose metadata carries no catalog exactly as they were', () => {
    const groups = buildProviderModelGroups({
      providerOptions: PROVIDER_OPTIONS,
      currentProviderId: 'claude',
      currentModels: [{ id: 'sonnet', name: 'Sonnet' }],
      composerProfiles: CURSOR_PROFILE,
      providers: PROVIDERS,
    })

    // Cursor still comes from its remembered profile, and OpenCode — which has
    // neither a profile nor metadata models — is still empty, so the picker
    // hides it exactly as it did before.
    expect(groups.find((group) => group.providerId === 'cursor')?.models).toEqual([
      { id: 'composer-2.5', name: 'Composer 2.5' },
    ])
    expect(groups.find((group) => group.providerId === 'opencode')?.models).toEqual([])
  })

  it('prefers a remembered profile over metadata for a provider already used', () => {
    const groups = buildProviderModelGroups({
      providerOptions: PROVIDER_OPTIONS,
      currentProviderId: 'cursor',
      currentModels: [],
      composerProfiles: {
        ...CURSOR_PROFILE,
        claude: {
          availableModels: [{ modelId: 'haiku', name: 'Haiku' }],
          updatedAt: 2,
        },
      },
      providers: PROVIDERS,
    })

    expect(groups.find((group) => group.providerId === 'claude')?.models).toEqual([
      { id: 'haiku', name: 'Haiku' },
    ])
  })
})

describe('metadataModelOptions', () => {
  it('is empty for a provider that only lists models on a live session', () => {
    expect(metadataModelOptions(PROVIDERS, 'cursor')).toEqual([])
    expect(metadataModelOptions(PROVIDERS, 'opencode')).toEqual([])
  })
})
