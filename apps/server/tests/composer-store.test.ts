import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ProofEventSchemas, type ProofEvent } from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { createEventRepository } from '../src/db/event-repository.js'
import { openTestComposerStore } from './helpers/composer-store.js'

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
    const first = openTestComposerStore(directory)
    first.upsertProfile('cursor', {
      agentInfo: { name: 'Cursor Agent', version: '1.0' },
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
      availableModels: [{ modelId: 'opus', name: 'Opus', supportsImageInput: false }],
      defaultModelId: 'opus',
    })
    first.setPreference('workspace-1', 'cursor', {
      modelId: 'opus',
      modeId: 'plan',
      configValues: { effort: 'high', fast: true },
    })
    first.close()

    const reopened = openTestComposerStore(directory)
    expect(reopened.getProfile('cursor')).toMatchObject({
      providerId: 'cursor',
      agentInfo: { name: 'Cursor Agent', version: '1.0' },
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
      availableModels: [{ modelId: 'opus', name: 'Opus', supportsImageInput: false }],
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
    const store = openTestComposerStore(await dataDir())
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
    const store = openTestComposerStore(await dataDir())
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

  it('writes every change as an event, counting the revisions of a preference', async () => {
    const directory = await dataDir()
    const events: ProofEvent[] = []
    const store = openTestComposerStore(directory, (event) => events.push(event))
    expect(store.readPreference('workspace-1', 'cursor')).toEqual({ preference: {}, revision: 0 })
    expect(store.setPreference('workspace-1', 'cursor', { modelId: 'opus' })).toEqual({
      preference: { modelId: 'opus' },
      revision: 1,
    })
    // An unchanged preference is no change: nothing written, no event.
    expect(store.setPreference('workspace-1', 'cursor', { modelId: 'opus' }).revision).toBe(1)
    expect(store.setPreference('workspace-1', 'cursor', { modeId: 'plan' }).revision).toBe(2)
    store.upsertProfile('cursor', { defaultModelId: 'opus' })
    expect(events.map((event) => event.name)).toEqual([
      'composer.preferences.updated',
      'composer.preferences.updated',
      'provider.catalog.updated',
    ])
    expect(events[1]).toMatchObject({
      payload: { preference: { modelId: 'opus', modeId: 'plan' }, revision: 2 },
    })
    store.close()
    // The row holds what the last event said.
    const database = new DatabaseSync(join(directory, 'openmanager.sqlite'))
    try {
      expect(
        database
          .prepare(
            'SELECT model_id, mode_id, revision FROM workspace_composer_preferences WHERE workspace_id = ?',
          )
          .get('workspace-1'),
      ).toEqual({ model_id: 'opus', mode_id: 'plan', revision: 2 })
    } finally {
      database.close()
    }
  })

  it('refuses a preference change whose revision is out of order', async () => {
    const directory = await dataDir()
    const database = openEnvironmentDatabase(directory)
    try {
      const repository = createEventRepository(database)
      const scope = { type: 'environment', environmentId: 'environment-1' } as const
      const change = (revision: number, eventId = `preference-${revision}`) =>
        ProofEventSchemas['composer.preferences.updated'].parse({
          type: 'event',
          name: 'composer.preferences.updated',
          eventId,
          timestamp: '2026-10-22T00:00:00.000Z',
          scope,
          payload: {
            workspaceId: 'workspace-1',
            providerId: 'cursor',
            preference: { modelId: `model-${revision}` },
            revision,
          },
        })
      expect(() => repository.appendEvents(scope, [change(2)])).toThrow(/out of order/)
      repository.appendEvents(scope, [change(1)])
      // A second change that claims the same revision is out of order too.
      expect(() => repository.appendEvents(scope, [change(1, 'preference-again')])).toThrow(
        /out of order/,
      )
    } finally {
      database.close()
    }
  })

  it('makes a concurrent version-zero migration idempotent', async () => {
    const directory = await dataDir()
    const first = openTestComposerStore(directory)
    first.close()
    const database = new DatabaseSync(join(directory, 'openmanager.sqlite'))
    database.exec('UPDATE schema_version SET version = 0; PRAGMA user_version = 0')
    database.close()

    const migrated = openTestComposerStore(directory)
    expect(migrated.getPreference('workspace-1', 'cursor')).toEqual({})
    migrated.close()
  })
})
