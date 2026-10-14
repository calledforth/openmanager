import { posix, win32 } from 'node:path'

/**
 * Where a released `openmanager` lives. The install scripts and `update`
 * share this layout:
 *
 *   <root>/versions/<version>/openmanager[.exe]   one folder per version
 *   <root>/install.json                           where the launcher was put
 *   <bin>/openmanager[.cmd]                       launcher on PATH
 *
 * Windows: root `%LOCALAPPDATA%\OpenManager`, bin `<root>\bin`.
 * Linux:   root `${XDG_DATA_HOME:-~/.local/share}/openmanager`, bin `~/.local/bin`.
 * `OPENMANAGER_INSTALL_DIR` and `OPENMANAGER_BIN_DIR` override them.
 *
 * Data (identity, SQLite, credentials) is not here: it stays in the data
 * directory (`~/.openmanager` by default), so removing an install keeps it.
 */

export const VERSIONS_DIR = 'versions'
export const INSTALL_RECORD = 'install.json'
export const COMPLETE_MARKER = '.install-complete'

export type ReleasePlatform = 'win32' | 'linux'

function pathFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix
}

export function executableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'openmanager.exe' : 'openmanager'
}

export function launcherName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'openmanager.cmd' : 'openmanager'
}

export function defaultInstallRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  if (env.OPENMANAGER_INSTALL_DIR) return env.OPENMANAGER_INSTALL_DIR
  const path = pathFor(platform)
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'OpenManager')
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'openmanager')
}

export function defaultBinDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
  root: string,
): string {
  if (env.OPENMANAGER_BIN_DIR) return env.OPENMANAGER_BIN_DIR
  const path = pathFor(platform)
  return platform === 'win32' ? path.join(root, 'bin') : path.join(home, '.local', 'bin')
}

export interface InstalledCopy {
  root: string
  version: string
  versionsDir: string
  versionDir: string
}

/**
 * The install this executable belongs to, read from its own path
 * (`<root>/versions/<version>/openmanager`), or `undefined` when it does not
 * sit in that layout (a copy someone moved, or a checkout).
 */
export function installedCopy(
  execPath: string,
  platform: NodeJS.Platform,
): InstalledCopy | undefined {
  const path = pathFor(platform)
  const versionDir = path.dirname(execPath)
  const versionsDir = path.dirname(versionDir)
  if (path.basename(versionsDir).toLowerCase() !== VERSIONS_DIR) return undefined
  const version = path.basename(versionDir)
  if (!isVersion(version)) return undefined
  return { root: path.dirname(versionsDir), version, versionsDir, versionDir }
}

export function versionDirectory(root: string, version: string, platform: NodeJS.Platform) {
  return pathFor(platform).join(root, VERSIONS_DIR, version)
}

/** `1.2.3` or `1.2.3-beta.1`; the only version shape releases use. */
export function isVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
}

/** Windows: the version the launcher runs, one line, in `<root>\current`. */
export const CURRENT_FILE = 'current'

/**
 * Text of the Windows launcher. It reads the version from `<root>\current`
 * instead of naming it, so its text never changes: cmd.exe reads a batch file
 * by byte offset while running it, and rewriting the launcher an `update` is
 * running from would make cmd continue mid-line in the new text. UTF-8
 * without a BOM, since the path may hold non-ASCII profile characters.
 */
export function windowsLauncher(root: string): string {
  return [
    '@echo off',
    'setlocal',
    `set /p OPENMANAGER_VERSION=<"${root}\\${CURRENT_FILE}"`,
    `"${root}\\${VERSIONS_DIR}\\%OPENMANAGER_VERSION%\\openmanager.exe" %*`,
    '',
  ].join('\r\n')
}

/** Whether `dir` is one of the entries of a `PATH` value (case-insensitive on Windows). */
export function pathContains(
  pathValue: string | undefined,
  dir: string,
  platform: NodeJS.Platform,
): boolean {
  const path = pathFor(platform)
  const normalize = (value: string) => {
    const trimmed = path.normalize(value.trim()).replace(/[\\/]+$/, '')
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed
  }
  const target = normalize(dir)
  return (pathValue ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .some((entry) => entry.trim() !== '' && normalize(entry) === target)
}
