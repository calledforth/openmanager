import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ProofEventSchemas,
  ProviderComposerProfileSchema,
  WorkspaceComposerPreferenceSchema,
  type DurableEvent,
  type ProofEvent,
  type ProviderComposerProfile,
  type WorkspaceComposerPreference,
} from '@openmanager/protocol/node'
import {
  readPreferenceRow,
  readProfileRow,
  readProfileRows,
  preferenceFromRow,
  profileFromRow,
} from './db/composer-rows.ts'

type ProfilePatch = Partial<Omit<ProviderComposerProfile, 'providerId' | 'updatedAt'>>
type PreferencePatch = Partial<WorkspaceComposerPreference>

/** A preference and the number of changes the server has counted for it. */
export interface RevisedPreference {
  preference: WorkspaceComposerPreference
  revision: number
}

/**
 * Where the composer store reads and writes: the event database's connection
 * and the event service's atomic append (docs/sync-foundations.md §4.7.11).
 * It opens no connection of its own and writes no row itself: a profile or
 * preference change is a `provider.catalog.updated` or
 * `composer.preferences.updated` event whose projection writes the row.
 */
export interface ComposerStoreSource {
  database: DatabaseSync
  environmentId: string
  appendAtomic(events: readonly ProofEvent[]): readonly DurableEvent[]
  clock?: () => number
}

/**
 * Durable composer state: provider profiles and per-workspace preferences.
 * Reads are small point reads of the rows; every change is an event.
 */
export function openComposerStore(source: ComposerStoreSource) {
  const { database } = source
  const clock = source.clock ?? Date.now

  const announce = (event: {
    name: 'provider.catalog.updated' | 'composer.preferences.updated'
    payload: unknown
  }) => {
    const schema = ProofEventSchemas[event.name] as { parse(input: unknown): ProofEvent }
    source.appendAtomic([
      schema.parse({
        ...event,
        type: 'event',
        eventId: randomUUID(),
        timestamp: new Date(clock()).toISOString(),
        scope: { type: 'environment', environmentId: source.environmentId },
      }),
    ])
  }

  const getProfile = (providerId: string): ProviderComposerProfile | undefined => {
    const row = readProfileRow(database, providerId)
    return row ? profileFromRow(row) : undefined
  }

  const readPreference = (workspaceId: string, providerId: string): RevisedPreference => {
    const row = readPreferenceRow(database, workspaceId, providerId)
    return row
      ? { preference: preferenceFromRow(row), revision: row.revision }
      : { preference: {}, revision: 0 }
  }

  return {
    getProfile,

    listProfiles(): ProviderComposerProfile[] {
      return readProfileRows(database).map(profileFromRow)
    },

    /**
     * Lay a patch over a provider's profile. A change is announced, and the
     * projection writes it; an unchanged profile writes nothing.
     */
    upsertProfile(providerId: string, patch: ProfilePatch): ProviderComposerProfile {
      const current = getProfile(providerId)
      const next = ProviderComposerProfileSchema.parse({
        providerId,
        ...(current ?? {}),
        ...defined(patch),
        updatedAt: clock(),
      })
      const comparable = { ...next, updatedAt: current?.updatedAt }
      if (current && JSON.stringify(comparable) === JSON.stringify(current)) return current
      announce({ name: 'provider.catalog.updated', payload: { profile: next } })
      return next
    },

    getPreference(workspaceId: string, providerId: string): WorkspaceComposerPreference {
      return readPreference(workspaceId, providerId).preference
    },

    readPreference,

    /**
     * Lay a patch over a workspace's preference. A change is announced with
     * the revision it produces, and the projection writes both.
     */
    setPreference(
      workspaceId: string,
      providerId: string,
      patch: PreferencePatch,
    ): RevisedPreference {
      const current = readPreference(workspaceId, providerId)
      const preference = WorkspaceComposerPreferenceSchema.parse({
        ...current.preference,
        ...defined(patch),
      })
      if (JSON.stringify(preference) === JSON.stringify(current.preference)) return current
      const revision = current.revision + 1
      announce({
        name: 'composer.preferences.updated',
        payload: { workspaceId, providerId, preference, revision },
      })
      return { preference, revision }
    },

    /** Nothing to release: the store holds no connection of its own. */
    close() {},
  }
}

export type ComposerStore = ReturnType<typeof openComposerStore>

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>
}
