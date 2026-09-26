import {
  EnvironmentSettingsSchema,
  type EnvironmentSettings,
  type EnvironmentSettingsPatch,
} from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from './db/database.ts'

/** What a setting is until someone changes it. */
export const DEFAULT_ENVIRONMENT_SETTINGS: EnvironmentSettings = Object.freeze({
  addProjectStartsIn: '',
})

type SettingKey = keyof EnvironmentSettings
type SettingRow = { key: string; value_json: string }

const isSettingKey = (key: string): key is SettingKey =>
  Object.hasOwn(DEFAULT_ENVIRONMENT_SETTINGS, key)

/**
 * Settings the environment keeps for every client, one SQLite row per key.
 * The store only persists values; what makes a value acceptable (a folder
 * that exists, say) is checked by whoever owns that setting before it is set.
 */
export function openEnvironmentSettings(dataDir: string, clock: () => number = Date.now) {
  const database = openEnvironmentDatabase(dataDir)
  const readAll = database.prepare('SELECT key, value_json FROM environment_settings')
  const write = database.prepare(`
    INSERT INTO environment_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `)

  const get = (): EnvironmentSettings => {
    const settings: Record<string, unknown> = { ...DEFAULT_ENVIRONMENT_SETTINGS }
    for (const row of readAll.all() as SettingRow[]) {
      if (!isSettingKey(row.key)) continue
      // A value this build cannot read (written by another version, say)
      // falls back to its default rather than failing every read.
      const candidate = { ...DEFAULT_ENVIRONMENT_SETTINGS, [row.key]: JSON.parse(row.value_json) }
      if (EnvironmentSettingsSchema.safeParse(candidate).success) {
        settings[row.key] = candidate[row.key]
      }
    }
    return EnvironmentSettingsSchema.parse(settings)
  }

  return {
    get,

    /** Apply a patch in one transaction; keys it leaves out keep their value. */
    set(patch: EnvironmentSettingsPatch): EnvironmentSettings {
      const next = EnvironmentSettingsSchema.parse({ ...get(), ...defined(patch) })
      const now = clock()
      database.exec('BEGIN IMMEDIATE')
      try {
        for (const key of Object.keys(patch)) {
          if (isSettingKey(key) && patch[key] !== undefined) {
            write.run(key, JSON.stringify(next[key]), now)
          }
        }
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      return next
    },

    close() {
      database.close()
    },
  }
}

export type EnvironmentSettingsStore = ReturnType<typeof openEnvironmentSettings>

function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>
}
