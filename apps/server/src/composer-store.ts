import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ProviderComposerProfileSchema,
  WorkspaceComposerPreferenceSchema,
  type ProviderComposerProfile,
  type WorkspaceComposerPreference,
} from '@openmanager/protocol/node'

type ProfilePatch = Partial<
  Omit<ProviderComposerProfile, 'providerId' | 'updatedAt'>
>
type PreferencePatch = Partial<WorkspaceComposerPreference>

type ProfileRow = {
  provider_id: string
  agent_info_json: string | null
  available_models_json: string | null
  available_modes_json: string | null
  default_model_id: string | null
  default_mode_id: string | null
  updated_at: number
}

type PreferenceRow = {
  model_id: string | null
  mode_id: string | null
  config_values_json: string | null
}

/** SQLite-owned durable composer state. All operations are small synchronous point reads/writes. */
export function openComposerStore(dataDir: string) {
  const database = new DatabaseSync(join(dataDir, 'openmanager.sqlite'))
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  migrate(database)

  const readProfile = database.prepare(`
    SELECT provider_id, agent_info_json, available_models_json, available_modes_json,
           default_model_id, default_mode_id, updated_at
    FROM provider_profiles
    WHERE provider_id = ?
  `)
  const listProfiles = database.prepare(`
    SELECT provider_id, agent_info_json, available_models_json, available_modes_json,
           default_model_id, default_mode_id, updated_at
    FROM provider_profiles
    ORDER BY provider_id
  `)
  const writeProfile = database.prepare(`
    INSERT INTO provider_profiles (
      provider_id, agent_info_json, available_models_json, available_modes_json,
      default_model_id, default_mode_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_id) DO UPDATE SET
      agent_info_json = excluded.agent_info_json,
      available_models_json = excluded.available_models_json,
      available_modes_json = excluded.available_modes_json,
      default_model_id = excluded.default_model_id,
      default_mode_id = excluded.default_mode_id,
      updated_at = excluded.updated_at
  `)
  const readPreference = database.prepare(`
    SELECT model_id, mode_id, config_values_json
    FROM workspace_composer_preferences
    WHERE workspace_id = ? AND provider_id = ?
  `)
  const writePreference = database.prepare(`
    INSERT INTO workspace_composer_preferences (
      workspace_id, provider_id, model_id, mode_id, config_values_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, provider_id) DO UPDATE SET
      model_id = excluded.model_id,
      mode_id = excluded.mode_id,
      config_values_json = excluded.config_values_json,
      updated_at = excluded.updated_at
  `)

  const getProfile = (providerId: string): ProviderComposerProfile | undefined => {
    const row = readProfile.get(providerId) as ProfileRow | undefined
    return row ? profileFromRow(row) : undefined
  }

  const getPreference = (
    workspaceId: string,
    providerId: string,
  ): WorkspaceComposerPreference => {
    const row = readPreference.get(workspaceId, providerId) as PreferenceRow | undefined
    return row ? preferenceFromRow(row) : {}
  }

  return {
    getProfile,

    listProfiles(): ProviderComposerProfile[] {
      return (listProfiles.all() as ProfileRow[]).map(profileFromRow)
    },

    upsertProfile(providerId: string, patch: ProfilePatch): ProviderComposerProfile {
      const current = getProfile(providerId)
      const next = ProviderComposerProfileSchema.parse({
        providerId,
        ...(current ?? {}),
        ...defined(patch),
        updatedAt: Date.now(),
      })
      const comparable = { ...next, updatedAt: current?.updatedAt }
      if (current && JSON.stringify(comparable) === JSON.stringify(current)) return current
      writeProfile.run(
        next.providerId,
        json(next.agentInfo),
        json(next.availableModels),
        json(next.availableModes),
        next.defaultModelId ?? null,
        next.defaultModeId ?? null,
        next.updatedAt,
      )
      return next
    },

    getPreference,

    setPreference(
      workspaceId: string,
      providerId: string,
      patch: PreferencePatch,
    ): WorkspaceComposerPreference {
      const current = getPreference(workspaceId, providerId)
      const next = WorkspaceComposerPreferenceSchema.parse({ ...current, ...defined(patch) })
      if (JSON.stringify(next) === JSON.stringify(current)) return current
      writePreference.run(
        workspaceId,
        providerId,
        next.modelId ?? null,
        next.modeId ?? null,
        json(next.configValues),
        Date.now(),
      )
      return next
    },

    close() {
      database.close()
    },
  }
}

export type ComposerStore = ReturnType<typeof openComposerStore>

function migrate(database: DatabaseSync): void {
  const version = (
    database.prepare('PRAGMA user_version').get() as { user_version: number }
  ).user_version
  if (version > 1) throw new Error(`Composer database version ${version} is newer than supported`)
  if (version === 1) return
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE provider_profiles (
      provider_id TEXT PRIMARY KEY NOT NULL,
      agent_info_json TEXT,
      available_models_json TEXT,
      available_modes_json TEXT,
      default_model_id TEXT,
      default_mode_id TEXT,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE workspace_composer_preferences (
      workspace_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT,
      mode_id TEXT,
      config_values_json TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, provider_id)
    ) STRICT;
    PRAGMA user_version = 1;
    COMMIT;
  `)
}

function profileFromRow(row: ProfileRow): ProviderComposerProfile {
  return ProviderComposerProfileSchema.parse({
    providerId: row.provider_id,
    ...(row.agent_info_json ? { agentInfo: JSON.parse(row.agent_info_json) } : {}),
    ...(row.available_models_json
      ? { availableModels: JSON.parse(row.available_models_json) }
      : {}),
    ...(row.available_modes_json ? { availableModes: JSON.parse(row.available_modes_json) } : {}),
    ...(row.default_model_id ? { defaultModelId: row.default_model_id } : {}),
    ...(row.default_mode_id ? { defaultModeId: row.default_mode_id } : {}),
    updatedAt: row.updated_at,
  })
}

function preferenceFromRow(row: PreferenceRow): WorkspaceComposerPreference {
  return WorkspaceComposerPreferenceSchema.parse({
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.mode_id ? { modeId: row.mode_id } : {}),
    ...(row.config_values_json ? { configValues: JSON.parse(row.config_values_json) } : {}),
  })
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}
