import type { Migration } from './migrate.ts'

/**
 * Forward-only numbered migrations for `openmanager.sqlite`.
 * Append the next integer version; never edit a migration that has shipped.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'composer_profiles',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS provider_profiles (
          provider_id TEXT PRIMARY KEY NOT NULL,
          agent_info_json TEXT,
          available_models_json TEXT,
          available_modes_json TEXT,
          default_model_id TEXT,
          default_mode_id TEXT,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS workspace_composer_preferences (
          workspace_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model_id TEXT,
          mode_id TEXT,
          config_values_json TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, provider_id)
        ) STRICT;
      `)
    },
  },
]
