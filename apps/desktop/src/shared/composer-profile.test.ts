import { describe, expect, it } from 'vitest'
import {
  composerPreferencesFromDocs,
  composerProfilesFromDocs,
  mergeProviderComposerProfiles,
  mergeWorkspaceComposerPreferences,
  resolveComposerChoice,
  withProviderCatalog,
  workspaceComposerPreferenceKey,
} from './composer-profile'

describe('composer profile resolution', () => {
  const options = [{ id: 'model-a' }, { id: 'model-b' }]

  it('keeps workspace and provider preferences independently keyed', () => {
    expect(workspaceComposerPreferenceKey('/repos/alpha', 'cursor')).toBe('/repos/alpha::cursor')
    expect(workspaceComposerPreferenceKey('/repos/beta', 'cursor')).toBe('/repos/beta::cursor')
    expect(workspaceComposerPreferenceKey('/repos/alpha', 'opencode')).toBe(
      '/repos/alpha::opencode',
    )
  })

  it('prefers a valid workspace choice over the provider default', () => {
    expect(resolveComposerChoice(['model-b', 'model-a'], options)).toBe('model-b')
  })

  it('falls back when a saved workspace choice is no longer available', () => {
    expect(resolveComposerChoice(['removed-model', 'model-a'], options)).toBe('model-a')
    expect(resolveComposerChoice(['removed-model'], options)).toBe('model-a')
  })

  it('merges startup hydration without dropping state learned during startup', () => {
    expect(
      mergeProviderComposerProfiles(
        {
          cursor: {
            availableModels: [{ modelId: 'model-a', name: 'Model A' }],
            updatedAt: 1,
          },
        },
        {
          cursor: {
            agentInfo: { name: 'Cursor', version: '1.0' },
            updatedAt: 2,
          },
        },
      ).cursor,
    ).toMatchObject({
      agentInfo: { name: 'Cursor', version: '1.0' },
      availableModels: [{ modelId: 'model-a', name: 'Model A' }],
    })

    expect(
      mergeWorkspaceComposerPreferences(
        { '/repos/alpha::cursor': { modeId: 'plan' } },
        { '/repos/alpha::cursor': { modelId: 'model-a' } },
      ),
    ).toEqual({
      '/repos/alpha::cursor': { modelId: 'model-a', modeId: 'plan' },
    })
  })
})

describe('convex document conversion', () => {
  it('keys profiles by provider and drops unknown providers', () => {
    const profiles = composerProfilesFromDocs([
      {
        providerId: 'cursor',
        agentInfo: { name: 'Cursor', version: '1.0' },
        availableModels: [{ modelId: 'model-a', name: 'Model A' }],
        defaultModelId: 'model-a',
        updatedAt: 10,
      },
      { providerId: 'not-a-provider', updatedAt: 5 },
    ])

    expect(Object.keys(profiles)).toEqual(['cursor'])
    expect(profiles.cursor).toEqual({
      agentInfo: { name: 'Cursor', version: '1.0' },
      availableModels: [{ modelId: 'model-a', name: 'Model A' }],
      defaultModelId: 'model-a',
      updatedAt: 10,
    })
  })

  it('keys preferences by workspace and provider', () => {
    expect(
      composerPreferencesFromDocs([
        {
          workspacePath: '/repos/alpha',
          providerId: 'cursor',
          modelId: 'model-a',
          configValues: { thought_level: 'high', fast: true },
        },
        { workspacePath: '/repos/alpha', providerId: 'opencode', modeId: 'build' },
        { workspacePath: '/repos/beta', providerId: 'bogus', modelId: 'model-x' },
      ]),
    ).toEqual({
      '/repos/alpha::cursor': {
        modelId: 'model-a',
        configValues: { thought_level: 'high', fast: true },
      },
      '/repos/alpha::opencode': { modeId: 'build' },
    })
  })
})

describe('withProviderCatalog', () => {
  // The five rows the real CLI returns at `initialize`, probed against
  // claude 2.1.220. `default` leads, which is why an unanchored picker shows it.
  const CLAUDE_MODELS = {
    availableModels: [
      { id: 'default', displayName: 'Default (recommended)', description: 'Sonnet 5 · Efficient' },
      { id: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient' },
      { id: 'opus', displayName: 'Opus', description: 'Opus 5 · Best for everyday tasks' },
    ],
  }

  it('backs an empty profile with the handshake catalog', () => {
    const profile = withProviderCatalog(undefined, { models: CLAUDE_MODELS })

    expect(profile?.availableModels).toEqual([
      { modelId: 'default', name: 'Default (recommended)', description: 'Sonnet 5 · Efficient' },
      { modelId: 'sonnet', name: 'Sonnet', description: 'Sonnet 5 · Efficient' },
      { modelId: 'opus', name: 'Opus', description: 'Opus 5 · Best for everyday tasks' },
    ])
  })

  it('rescues a remembered pick that an empty catalog would have discarded', () => {
    // This is the whole bug. `resolveComposerChoice` validates the user's
    // choice against the profile's catalog and returns the head of the list
    // when it cannot find it — so with no catalog, "opus" was silently
    // replaced by "default", and the launch went out with no model at all.
    expect(resolveComposerChoice(['opus'], undefined)).toBeUndefined()

    const profile = withProviderCatalog(undefined, { models: CLAUDE_MODELS })
    expect(
      resolveComposerChoice(
        ['opus'],
        profile?.availableModels?.map((model) => ({ id: model.modelId })),
      ),
    ).toBe('opus')
  })

  it('lets a live session catalog win over the handshake one', () => {
    // A profile written from session events describes the exact process a
    // prompt will run on; the probe's answer came from a different one.
    const profile = withProviderCatalog(
      { availableModels: [{ modelId: 'sonnet', name: 'Sonnet' }], updatedAt: 7 },
      { models: CLAUDE_MODELS },
    )

    expect(profile?.availableModels).toEqual([{ modelId: 'sonnet', name: 'Sonnet' }])
    expect(profile?.updatedAt).toBe(7)
  })

  it('fills modes and models independently', () => {
    const profile = withProviderCatalog(
      { availableModels: [{ modelId: 'sonnet', name: 'Sonnet' }], updatedAt: 1 },
      {
        models: CLAUDE_MODELS,
        modes: { availableModes: [{ id: 'plan', displayName: 'Plan', description: 'No tools' }] },
      },
    )

    expect(profile?.availableModels).toHaveLength(1)
    expect(profile?.availableModes).toEqual([{ id: 'plan', name: 'Plan', description: 'No tools' }])
  })

  it('leaves an ACP provider untouched, catalog or not', () => {
    // ACP probes report neither listing, so this must be a no-op rather than
    // an empty catalog that would start discarding valid picks.
    expect(withProviderCatalog(undefined, undefined)).toBeUndefined()
    expect(withProviderCatalog(undefined, { models: { availableModels: [] } })).toBeUndefined()

    const existing = { availableModels: [{ modelId: 'gpt', name: 'GPT' }], updatedAt: 3 }
    expect(withProviderCatalog(existing, {})).toBe(existing)
  })
})

describe('capability flags survive every hop', () => {
  // Regression: the flags were carried into the contract and the probe, but
  // dropped by three separate mappers on the way to the composer — the
  // renderer's `toAcpModels`, the Convex projector, and the chrome picker
  // projection. Each drop hid the effort pill for a different source of the
  // model list, and none of them failed a type check, because every field
  // involved is optional. This pins the one hop that is pure and testable
  // here; the others are pinned by the composer's own capability lookup.
  it('carries effort levels and mode support out of provider metadata', () => {
    const profile = withProviderCatalog(undefined, {
      models: {
        availableModels: [
          {
            id: 'opus',
            displayName: 'Opus',
            description: 'Opus 5 · Best for everyday tasks',
            effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            supportsFastMode: true,
            supportsAutoMode: true,
          },
          // Haiku carries none of them, and that absence is itself meaningful:
          // it is what hides the effort pill and filters out `auto`.
          { id: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest' },
        ],
      },
    })

    expect(profile?.availableModels?.[0]).toEqual({
      modelId: 'opus',
      name: 'Opus',
      description: 'Opus 5 · Best for everyday tasks',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsFastMode: true,
      supportsAutoMode: true,
    })
    expect(profile?.availableModels?.[1]).toEqual({
      modelId: 'haiku',
      name: 'Haiku',
      description: 'Haiku 4.5 · Fastest',
    })
  })
})
