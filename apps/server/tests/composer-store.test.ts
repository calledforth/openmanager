import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openComposerStore } from '../src/composer-store.js'

const directories: string[] = []

async function dataDir() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-composer-store-test-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('composer SQLite store', () => {
  it('persists profiles and workspace/provider preferences across reopen', async () => {
    const directory = await dataDir()
    const first = openComposerStore(directory)
    first.upsertProfile('cursor', {
      agentInfo: { name: 'Cursor Agent', version: '1.0' },
      availableModels: [{ modelId: 'opus', name: 'Opus' }],
      defaultModelId: 'opus',
    })
    first.setPreference('workspace-1', 'cursor', {
      modelId: 'opus',
      modeId: 'plan',
      configValues: { effort: 'high', fast: true },
    })
    first.close()

    const reopened = openComposerStore(directory)
    expect(reopened.getProfile('cursor')).toMatchObject({
      providerId: 'cursor',
      agentInfo: { name: 'Cursor Agent', version: '1.0' },
      availableModels: [{ modelId: 'opus', name: 'Opus' }],
      defaultModelId: 'opus',
    })
    expect(reopened.getPreference('workspace-1', 'cursor')).toEqual({
      modelId: 'opus',
      modeId: 'plan',
      configValues: { effort: 'high', fast: true },
    })
    reopened.close()
  })

  it('patches fields without crossing workspace or provider boundaries', async () => {
    const store = openComposerStore(await dataDir())
    store.setPreference('workspace-1', 'cursor', { modelId: 'opus', modeId: 'plan' })
    store.setPreference('workspace-1', 'cursor', { modeId: 'agent' })
    store.setPreference('workspace-2', 'cursor', { modelId: 'sonnet' })
    store.setPreference('workspace-1', 'claude', { modelId: 'haiku' })

    expect(store.getPreference('workspace-1', 'cursor')).toEqual({
      modelId: 'opus',
      modeId: 'agent',
    })
    expect(store.getPreference('workspace-2', 'cursor')).toEqual({ modelId: 'sonnet' })
    expect(store.getPreference('workspace-1', 'claude')).toEqual({ modelId: 'haiku' })
    expect(store.getPreference('missing', 'cursor')).toEqual({})
    store.close()
  })

  it('keeps the prior timestamp for no-op profile observations', async () => {
    const store = openComposerStore(await dataDir())
    const first = store.upsertProfile('cursor', {
      availableModels: [{ modelId: 'opus', name: 'Opus' }],
    })
    const unchanged = store.upsertProfile('cursor', {
      availableModels: [{ modelId: 'opus', name: 'Opus' }],
    })

    expect(unchanged.updatedAt).toBe(first.updatedAt)
    expect(store.listProfiles()).toEqual([first])
    store.close()
  })

  it('makes a concurrent version-zero migration idempotent', async () => {
    const directory = await dataDir()
    const first = openComposerStore(directory)
    first.close()
    const database = new DatabaseSync(join(directory, 'openmanager.sqlite'))
    database.exec('PRAGMA user_version = 0')
    database.close()

    const migrated = openComposerStore(directory)
    expect(migrated.getPreference('workspace-1', 'cursor')).toEqual({})
    migrated.close()
  })
})
