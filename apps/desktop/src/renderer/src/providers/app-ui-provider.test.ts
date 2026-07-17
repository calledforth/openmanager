import { describe, expect, it, vi } from 'vitest'
import { coordinateProviderConnection, resolveDraftComposerRuntime } from './app-ui-provider'
import type { ProviderComposerProfile } from '../../../shared/composer-profile'

const profile: ProviderComposerProfile = {
  availableModels: [
    { modelId: 'cursor/default', name: 'Default' },
    { modelId: 'cursor/fast', name: 'Fast' },
  ],
  availableModes: [
    { id: 'agent', name: 'Agent' },
    { id: 'plan', name: 'Plan' },
  ],
  defaultModelId: 'cursor/default',
  defaultModeId: 'agent',
  updatedAt: 1,
}

describe('draft composer profiles', () => {
  it('combines the global provider catalog with a workspace-specific selection', () => {
    const alpha = resolveDraftComposerRuntime({
      workspacePath: '/repos/alpha',
      providerId: 'cursor',
      preference: { modelId: 'cursor/fast', modeId: 'plan' },
      profile,
    })
    const beta = resolveDraftComposerRuntime({
      workspacePath: '/repos/beta',
      providerId: 'cursor',
      preference: { modelId: 'cursor/default', modeId: 'agent' },
      profile,
    })

    expect(alpha.models?.availableModels).toEqual(profile.availableModels)
    expect(alpha.models?.currentModelId).toBe('cursor/fast')
    expect(alpha.modes?.currentModeId).toBe('plan')
    expect(beta.models?.currentModelId).toBe('cursor/default')
    expect(beta.modes?.currentModeId).toBe('agent')
  })

  it('falls back to provider defaults when a workspace preference is stale', () => {
    const draft = resolveDraftComposerRuntime({
      workspacePath: '/repos/alpha',
      providerId: 'cursor',
      preference: { modelId: 'cursor/removed', modeId: 'removed' },
      profile,
    })

    expect(draft.models?.currentModelId).toBe('cursor/default')
    expect(draft.modes?.currentModeId).toBe('agent')
  })

  it('uses refreshed workspace state instead of an older draft seed', () => {
    const draft = resolveDraftComposerRuntime({
      workspacePath: '/repos/alpha',
      providerId: 'cursor',
      selection: { modelId: 'cursor/default', modeId: 'agent' },
      preference: { modelId: 'cursor/fast', modeId: 'plan' },
      profile,
    })

    expect(draft.models?.currentModelId).toBe('cursor/fast')
    expect(draft.modes?.currentModeId).toBe('plan')
  })
})

describe('provider connection coordination', () => {
  it('shares one in-flight provider startup and allows a later retry', async () => {
    const connections = new Map()
    let release: ((ready: boolean) => void) | undefined
    const start = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
    )

    const first = coordinateProviderConnection(connections, 'cursor', start)
    const second = coordinateProviderConnection(connections, 'cursor', start)
    expect(second).toBe(first)
    expect(start).toHaveBeenCalledTimes(1)

    release?.(true)
    await expect(first).resolves.toBe(true)
    await Promise.resolve()

    const third = coordinateProviderConnection(connections, 'cursor', async () => true)
    expect(third).not.toBe(first)
    await expect(third).resolves.toBe(true)
  })
})
