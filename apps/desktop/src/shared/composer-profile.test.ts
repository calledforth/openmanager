import { describe, expect, it } from 'vitest'
import {
  mergeProviderComposerProfiles,
  mergeWorkspaceComposerPreferences,
  resolveComposerChoice,
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
