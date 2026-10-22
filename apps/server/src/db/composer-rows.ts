import type { DatabaseSync } from 'node:sqlite'
import {
  ProviderComposerProfileSchema,
  WorkspaceComposerPreferenceSchema,
  type ProviderComposerProfile,
  type WorkspaceComposerPreference,
} from '@openmanager/protocol/node'

/**
 * The composer's rows as one module reads and writes them: the composer
 * store's reads, and the projection that is their one writer
 * (docs/sync-foundations.md §4.4, §4.7.11).
 */

export type ProfileRow = {
  provider_id: string
  agent_info_json: string | null
  prompt_capabilities_json: string | null
  available_models_json: string | null
  available_modes_json: string | null
  default_model_id: string | null
  default_mode_id: string | null
  updated_at: number
}

export type PreferenceRow = {
  model_id: string | null
  mode_id: string | null
  config_values_json: string | null
  revision: number
}

const PROFILE_COLUMNS = `provider_id, agent_info_json, prompt_capabilities_json,
  available_models_json, available_modes_json, default_model_id, default_mode_id, updated_at`

export function readProfileRow(database: DatabaseSync, providerId: string): ProfileRow | undefined {
  return database
    .prepare(`SELECT ${PROFILE_COLUMNS} FROM provider_profiles WHERE provider_id = ?`)
    .get(providerId) as ProfileRow | undefined
}

export function readProfileRows(database: DatabaseSync): ProfileRow[] {
  return database
    .prepare(`SELECT ${PROFILE_COLUMNS} FROM provider_profiles ORDER BY provider_id`)
    .all() as unknown as ProfileRow[]
}

export function readPreferenceRow(
  database: DatabaseSync,
  workspaceId: string,
  providerId: string,
): PreferenceRow | undefined {
  return database
    .prepare(
      `SELECT model_id, mode_id, config_values_json, revision
       FROM workspace_composer_preferences WHERE workspace_id = ? AND provider_id = ?`,
    )
    .get(workspaceId, providerId) as PreferenceRow | undefined
}

export function profileFromRow(row: ProfileRow): ProviderComposerProfile {
  return ProviderComposerProfileSchema.parse({
    providerId: row.provider_id,
    ...(row.agent_info_json ? { agentInfo: JSON.parse(row.agent_info_json) } : {}),
    ...(row.prompt_capabilities_json
      ? { promptCapabilities: JSON.parse(row.prompt_capabilities_json) }
      : {}),
    ...(row.available_models_json
      ? { availableModels: JSON.parse(row.available_models_json) }
      : {}),
    ...(row.available_modes_json ? { availableModes: JSON.parse(row.available_modes_json) } : {}),
    ...(row.default_model_id ? { defaultModelId: row.default_model_id } : {}),
    ...(row.default_mode_id ? { defaultModeId: row.default_mode_id } : {}),
    updatedAt: row.updated_at,
  })
}

export function preferenceFromRow(row: PreferenceRow): WorkspaceComposerPreference {
  return WorkspaceComposerPreferenceSchema.parse({
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.mode_id ? { modeId: row.mode_id } : {}),
    ...(row.config_values_json ? { configValues: JSON.parse(row.config_values_json) } : {}),
  })
}

const json = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value)

/** The projection's statements for both rows, run inside the event transaction. */
export function prepareComposerProjection(database: DatabaseSync) {
  const writeProfile = database.prepare(`
    INSERT INTO provider_profiles (
      provider_id, agent_info_json, prompt_capabilities_json, available_models_json,
      available_modes_json, default_model_id, default_mode_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_id) DO UPDATE SET
      agent_info_json = excluded.agent_info_json,
      prompt_capabilities_json = excluded.prompt_capabilities_json,
      available_models_json = excluded.available_models_json,
      available_modes_json = excluded.available_modes_json,
      default_model_id = excluded.default_model_id,
      default_mode_id = excluded.default_mode_id,
      updated_at = excluded.updated_at
  `)
  const writePreference = database.prepare(`
    INSERT INTO workspace_composer_preferences (
      workspace_id, provider_id, model_id, mode_id, config_values_json, revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, provider_id) DO UPDATE SET
      model_id = excluded.model_id,
      mode_id = excluded.mode_id,
      config_values_json = excluded.config_values_json,
      revision = excluded.revision,
      updated_at = excluded.updated_at
  `)
  return {
    /** A profile replaces the row whole; it must read back as it was announced. */
    profile(profile: ProviderComposerProfile): void {
      writeProfile.run(
        profile.providerId,
        json(profile.agentInfo),
        json(profile.promptCapabilities),
        json(profile.availableModels),
        json(profile.availableModes),
        profile.defaultModelId ?? null,
        profile.defaultModeId ?? null,
        profile.updatedAt,
      )
    },
    /**
     * A preference and the revision its change produced. The revision must be
     * the stored one plus one: a change out of order rolls the write back.
     */
    preference(
      target: { workspaceId: string; providerId: string },
      preference: WorkspaceComposerPreference,
      revision: number,
      at: number,
    ): void {
      const stored = readPreferenceRow(database, target.workspaceId, target.providerId)
      const expected = (stored?.revision ?? 0) + 1
      if (revision !== expected) {
        throw new Error(
          `Preference ${target.workspaceId}/${target.providerId} is at revision ${expected - 1}; a change to ${revision} is out of order`,
        )
      }
      writePreference.run(
        target.workspaceId,
        target.providerId,
        preference.modelId ?? null,
        preference.modeId ?? null,
        json(preference.configValues),
        revision,
        at,
      )
    },
  }
}
