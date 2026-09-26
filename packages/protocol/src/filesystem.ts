import { z } from 'zod'
import { CommandEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'

export const FILESYSTEM_BROWSE_CAPABILITY = 'filesystem.browse' as const
export const ENVIRONMENT_SETTINGS_GET_CAPABILITY = 'environment.settings.get' as const
export const ENVIRONMENT_SETTINGS_SET_CAPABILITY = 'environment.settings.set' as const

const command = <N extends string, P extends z.ZodType>(name: N, payload: P) =>
  CommandEnvelopeSchema.extend({ name: z.literal(name), payload })
const response = <P extends z.ZodType>(payload: P) => ResponseEnvelopeSchema.extend({ payload })

const EnvironmentPathSchema = z.string().min(1).max(4096)

/** One child folder, named as the environment's filesystem spells it. */
export const FilesystemEntrySchema = z.object({
  name: z.string().min(1).max(1024),
  path: EnvironmentPathSchema,
})

/**
 * Settings that belong to the environment rather than to one client, so every
 * paired device sees the same values. Each is optional on the wire: an
 * environment fills in its defaults, and a client that does not know a newer
 * setting leaves it alone.
 */
export const EnvironmentSettingsSchema = z.object({
  /**
   * The folder Add project's browser opens in, as the user typed it (`~` is
   * allowed and stays unexpanded). Empty means the home folder.
   */
  addProjectStartsIn: z.string().max(4096),
})

export const EnvironmentSettingsPatchSchema = EnvironmentSettingsSchema.partial()

/**
 * Folder browsing for picking a project on the environment's machine. The
 * listing is the whole directory tree the environment's user can read:
 * pairing is the consent (CAL-192), so there is no root it is confined to,
 * but it needs `operate`, the same grant registering a folder needs.
 */
export const FilesystemCommandSchemas = {
  [FILESYSTEM_BROWSE_CAPABILITY]: command(
    FILESYSTEM_BROWSE_CAPABILITY,
    z.object({
      /**
       * An absolute folder path; a leading `~` names the environment's home
       * folder. Omitted, the listing is where Add project starts: the
       * `addProjectStartsIn` setting, or home when that is empty or gone.
       */
      path: EnvironmentPathSchema.optional(),
    }),
  ),
  [ENVIRONMENT_SETTINGS_GET_CAPABILITY]: command(ENVIRONMENT_SETTINGS_GET_CAPABILITY, z.null()),
  // A patch: settings left out keep their value. The environment validates
  // each one and refuses the whole patch if any is wrong.
  [ENVIRONMENT_SETTINGS_SET_CAPABILITY]: command(
    ENVIRONMENT_SETTINGS_SET_CAPABILITY,
    z.object({ settings: EnvironmentSettingsPatchSchema }),
  ),
} as const

export const FilesystemResponseSchemas = {
  [FILESYSTEM_BROWSE_CAPABILITY]: response(
    z.object({
      /** The folder listed, absolute and resolved: `~` expanded, `.` segments gone. */
      path: EnvironmentPathSchema,
      /** The folder above it, or null at a drive, share or filesystem root. */
      parentPath: EnvironmentPathSchema.nullable(),
      /**
       * Every child folder, sorted by name. Links and junctions that resolve
       * to a folder count as folders. Not capped.
       */
      entries: z.array(FilesystemEntrySchema),
      /** False when the folder exists but the environment may not list it. */
      readable: z.boolean(),
    }),
  ),
  [ENVIRONMENT_SETTINGS_GET_CAPABILITY]: response(
    z.object({ settings: EnvironmentSettingsSchema }),
  ),
  [ENVIRONMENT_SETTINGS_SET_CAPABILITY]: response(
    z.object({ settings: EnvironmentSettingsSchema }),
  ),
} as const

export type FilesystemEntry = z.infer<typeof FilesystemEntrySchema>
export type FilesystemListing = z.infer<
  (typeof FilesystemResponseSchemas)[typeof FILESYSTEM_BROWSE_CAPABILITY]
>['payload']
export type EnvironmentSettings = z.infer<typeof EnvironmentSettingsSchema>
export type EnvironmentSettingsPatch = z.infer<typeof EnvironmentSettingsPatchSchema>
