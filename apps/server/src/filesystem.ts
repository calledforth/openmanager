import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  ENVIRONMENT_SETTINGS_GET_CAPABILITY,
  ENVIRONMENT_SETTINGS_SET_CAPABILITY,
  FILESYSTEM_BROWSE_CAPABILITY,
  FilesystemCommandSchemas,
  FilesystemResponseSchemas,
  type CommandEnvelope,
  type EnvironmentSettingsPatch,
  type ErrorCode,
  type FilesystemEntry,
  type FilesystemListing,
} from '@openmanager/protocol/node'
import type { CommandContext } from './command-context.ts'
import type { EnvironmentSettingsStore } from './environment-settings.ts'
import { PathBoundaryError, validateRegistrationPath } from './workspace-paths.ts'

/** A refusal the client shows as is: the path was wrong or is not there. */
export class BrowseError extends Error {
  readonly code: 'validation' | 'not_found'
  constructor(code: 'validation' | 'not_found', message: string) {
    super(message)
    this.name = 'BrowseError'
    this.code = code
  }
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && 'code' in error && codes.includes(String(error.code))
}

/**
 * Turn what a user typed into the absolute folder it names. `~` is the
 * environment's home folder; a bare drive (`C:`) is that drive's root, not
 * its current directory. Anything else must already be absolute: there is
 * no working directory a relative path could mean.
 */
export function resolveBrowsePath(
  input: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let path = input.trim()
  if (path === '~') path = home
  else if (/^~[\\/]/.test(path)) path = join(home, path.slice(2))
  if (platform === 'win32' && /^[a-z]:$/i.test(path)) path = `${path}\\`
  try {
    validateRegistrationPath(path, platform)
  } catch (error) {
    if (error instanceof PathBoundaryError) throw new BrowseError('validation', error.message)
    throw error
  }
  return resolve(path)
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Whether a directory entry is a folder, following links and junctions to their target. */
async function isFolder(parent: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return (await stat(join(parent, entry.name))).isDirectory()
  } catch {
    // A dangling link, or one pointing somewhere unreadable.
    return false
  }
}

/**
 * The child folders of `path`, every one of them. A folder the environment
 * may not read lists as unreadable rather than failing, so the picker can
 * still step back out of it.
 */
export async function listFolder(path: string): Promise<FilesystemListing> {
  try {
    if (!(await stat(path)).isDirectory()) {
      throw new BrowseError('validation', `${path} is a file, not a folder.`)
    }
  } catch (error) {
    if (error instanceof BrowseError) throw error
    if (hasCode(error, 'ENOENT', 'ENOTDIR')) {
      throw new BrowseError('not_found', `No folder exists at ${path}.`)
    }
    if (!hasCode(error, 'EACCES', 'EPERM')) throw error
  }
  const parent = dirname(path)
  const parentPath = parent === path ? null : parent
  let dirents: Dirent[]
  try {
    dirents = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (hasCode(error, 'EACCES', 'EPERM')) return { path, parentPath, entries: [], readable: false }
    throw error
  }
  const folders = await Promise.all(
    dirents.map(async (entry) => ((await isFolder(path, entry)) ? entry.name : null)),
  )
  const entries: FilesystemEntry[] = folders
    .filter((name): name is string => name !== null)
    .sort(byName.compare)
    .map((name) => ({ name, path: join(path, name) }))
  return { path, parentPath, entries, readable: true }
}

export interface FilesystemServiceOptions {
  settings: EnvironmentSettingsStore
  home?: () => string
  platform?: NodeJS.Platform
}

/**
 * Folder browsing for Add project, and the environment settings it reads.
 * Browsing is not confined to registered workspaces: pairing is the consent,
 * and the `operate` grant this needs is the one that registers a folder.
 */
export function createFilesystemService(options: FilesystemServiceOptions) {
  const home = options.home ?? homedir
  const platform = options.platform ?? process.platform

  const errorResult = (requestId: string, code: ErrorCode, message: string) => ({
    type: 'error' as const,
    requestId,
    error: { code, message },
  })

  /** Where Add project opens: the setting, or home when it is empty or gone. */
  const startListing = async (): Promise<FilesystemListing> => {
    const startsIn = options.settings.get().addProjectStartsIn
    if (startsIn) {
      try {
        return await listFolder(resolveBrowsePath(startsIn, home(), platform))
      } catch (error) {
        // The folder was moved or deleted since it was chosen. Home still
        // gets the user somewhere; the setting is theirs to fix.
        if (!(error instanceof BrowseError)) throw error
      }
    }
    return listFolder(resolve(home()))
  }

  const browse = (path: string | undefined): Promise<FilesystemListing> =>
    path === undefined ? startListing() : listFolder(resolveBrowsePath(path, home(), platform))

  /** Check each setting in a patch; returns the refusal message, if any. */
  const checkSettings = async (patch: EnvironmentSettingsPatch): Promise<string | null> => {
    const startsIn = patch.addProjectStartsIn?.trim()
    if (startsIn) {
      try {
        await listFolder(resolveBrowsePath(startsIn, home(), platform))
      } catch (error) {
        if (error instanceof BrowseError) return error.message
        throw error
      }
    }
    return null
  }

  return {
    browse,

    dispatch(command: CommandEnvelope, _context?: CommandContext): Promise<unknown> | undefined {
      switch (command.name) {
        case FILESYSTEM_BROWSE_CAPABILITY:
          return (async () => {
            const parsed = FilesystemCommandSchemas[FILESYSTEM_BROWSE_CAPABILITY].safeParse(command)
            if (!parsed.success) {
              return errorResult(command.requestId, 'validation', 'Invalid browse request.')
            }
            try {
              const listing = await browse(parsed.data.payload.path)
              return FilesystemResponseSchemas[FILESYSTEM_BROWSE_CAPABILITY].parse({
                type: 'response',
                requestId: command.requestId,
                payload: listing,
              })
            } catch (error) {
              if (error instanceof BrowseError) {
                return errorResult(command.requestId, error.code, error.message)
              }
              throw error
            }
          })()
        case ENVIRONMENT_SETTINGS_GET_CAPABILITY: {
          const parsed =
            FilesystemCommandSchemas[ENVIRONMENT_SETTINGS_GET_CAPABILITY].safeParse(command)
          if (!parsed.success) {
            return Promise.resolve(
              errorResult(command.requestId, 'validation', 'Invalid settings request.'),
            )
          }
          return Promise.resolve(
            FilesystemResponseSchemas[ENVIRONMENT_SETTINGS_GET_CAPABILITY].parse({
              type: 'response',
              requestId: command.requestId,
              payload: { settings: options.settings.get() },
            }),
          )
        }
        case ENVIRONMENT_SETTINGS_SET_CAPABILITY:
          return (async () => {
            const parsed =
              FilesystemCommandSchemas[ENVIRONMENT_SETTINGS_SET_CAPABILITY].safeParse(command)
            if (!parsed.success) {
              return errorResult(command.requestId, 'validation', 'Invalid settings change.')
            }
            const patch = parsed.data.payload.settings
            const refusal = await checkSettings(patch)
            if (refusal) return errorResult(command.requestId, 'validation', refusal)
            const trimmed: EnvironmentSettingsPatch = {
              ...patch,
              ...(patch.addProjectStartsIn === undefined
                ? {}
                : { addProjectStartsIn: patch.addProjectStartsIn.trim() }),
            }
            return FilesystemResponseSchemas[ENVIRONMENT_SETTINGS_SET_CAPABILITY].parse({
              type: 'response',
              requestId: command.requestId,
              payload: { settings: options.settings.set(trimmed) },
            })
          })()
        default:
          return undefined
      }
    },
  }
}
