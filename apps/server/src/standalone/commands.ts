import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { isSea } from 'node:sea'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { runServiceCommand } from '../service/cli.ts'
import {
  COMPLETE_MARKER,
  CURRENT_FILE,
  defaultBinDir,
  executableName,
  INSTALL_RECORD,
  installedCopy,
  isVersion,
  launcherName,
  pathContains,
  versionDirectory,
  windowsLauncher,
  type InstalledCopy,
} from './layout.ts'
import {
  archiveName,
  CHECKSUMS_FILE,
  compareVersions,
  fetchNewestRelease,
  parseChecksums,
  releaseBaseUrl,
  releaseTag,
  releaseTarget,
} from './release.ts'
import { serverVersion } from './version.ts'

/**
 * `openmanager update`, `openmanager uninstall` and the internal
 * `openmanager activate`, for the released executable (layout.ts).
 */

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface StandaloneDeps {
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  env: NodeJS.ProcessEnv
  homedir: string
  /** This executable. */
  execPath: string
  /** Whether this process is the released single executable. */
  standalone: boolean
  version: string
  fetch: typeof fetch
  /** Run a program to completion, capturing its output. */
  run: (file: string, args: readonly string[]) => Promise<RunResult>
  /** Run a program with this terminal attached; resolves to its exit code. */
  runAttached: (file: string, args: readonly string[]) => Promise<number>
  /** The service commands, for `uninstall`. */
  service: (args: readonly string[]) => Promise<number>
  stdout: (line: string) => void
  stderr: (line: string) => void
}

function capture(file: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function attached(file: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
}

export function defaultDeps(): StandaloneDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homedir: homedir(),
    execPath: process.execPath,
    standalone: isSea(),
    version: serverVersion(),
    fetch,
    run: capture,
    runAttached: attached,
    service: (args) => runServiceCommand(args, { entry: undefined }),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  }
}

class CommandError extends Error {}

function pathFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix
}

/** The install this executable runs from, or a clear error for a checkout or moved copy. */
function requireInstall(deps: StandaloneDeps, command: string): InstalledCopy {
  if (!deps.standalone) {
    throw new CommandError(
      `"openmanager ${command}" manages a released install. From a checkout, use git pull, rebuild, and "service update" instead.`,
    )
  }
  const copy = installedCopy(deps.execPath, deps.platform)
  if (!copy) {
    throw new CommandError(
      `${deps.execPath} is not inside an OpenManager install (…/versions/<version>/). Reinstall with the install script.`,
    )
  }
  return copy
}

interface InstallRecord {
  binDir: string
}

async function readRecord(root: string, deps: StandaloneDeps): Promise<InstallRecord> {
  const path = pathFor(deps.platform).join(root, INSTALL_RECORD)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { binDir?: unknown }
    if (typeof parsed.binDir === 'string' && parsed.binDir) return { binDir: parsed.binDir }
  } catch {
    // Missing or unreadable: fall back to where activate would have put it.
  }
  return { binDir: defaultBinDir(deps.platform, deps.env, deps.homedir, root) }
}

/** Replace `target` with what `write` puts at a temporary path, by rename. */
async function replaceAtomically(target: string, write: (temporary: string) => Promise<void>) {
  const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await write(temporary)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Point the launcher on PATH at `copy`. Linux: a symlink to its executable,
 * swapped by rename. Windows: `<root>\current` names the version; the
 * launcher's own text only changes when the install folder does.
 */
async function writeLauncher(binDir: string, copy: InstalledCopy, deps: StandaloneDeps) {
  const path = pathFor(deps.platform)
  await mkdir(binDir, { recursive: true })
  const launcher = path.join(binDir, launcherName(deps.platform))
  if (deps.platform === 'win32') {
    await replaceAtomically(path.join(copy.root, CURRENT_FILE), (temporary) =>
      writeFile(temporary, copy.version, 'utf8'),
    )
    const text = windowsLauncher(copy.root)
    if ((await readFile(launcher, 'utf8').catch(() => undefined)) !== text) {
      await replaceAtomically(launcher, (temporary) => writeFile(temporary, text, 'utf8'))
    }
  } else {
    const executable = path.join(copy.versionDir, executableName(deps.platform))
    await replaceAtomically(launcher, (temporary) => symlink(executable, temporary))
  }
  return launcher
}

/** Make `copy` the version on PATH and record where the launcher lives. */
async function activateCopy(copy: InstalledCopy, deps: StandaloneDeps): Promise<string> {
  const path = pathFor(deps.platform)
  const { binDir } = await readRecord(copy.root, deps)
  const launcher = await writeLauncher(binDir, copy, deps)
  await writeFile(
    path.join(copy.root, INSTALL_RECORD),
    `${JSON.stringify({ binDir, version: copy.version }, null, 2)}\n`,
    'utf8',
  )
  return launcher
}

/** `openmanager activate`: called by the install scripts on the version they unpacked. */
export async function runActivate(
  args: readonly string[],
  deps: StandaloneDeps = defaultDeps(),
): Promise<number> {
  try {
    if (args.length > 0) throw new CommandError('"openmanager activate" takes no arguments.')
    const copy = requireInstall(deps, 'activate')
    const launcher = await activateCopy(copy, deps)
    const binDir = pathFor(deps.platform).dirname(launcher)
    deps.stdout(`OpenManager ${copy.version} is installed: ${launcher}`)
    const moved = await moveServiceTo(deps.execPath, deps)
    if (moved !== 0) return moved
    if (!pathContains(deps.env.PATH, binDir, deps.platform)) {
      deps.stdout(
        deps.platform === 'win32'
          ? `Open a new terminal so ${binDir} is on your PATH.`
          : `${binDir} is not on your PATH yet. Add it (for example in ~/.profile), then open a new terminal.`,
      )
    }
    return 0
  } catch (error) {
    return fail(error, deps)
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

async function download(url: string, file: string, deps: StandaloneDeps): Promise<void> {
  const response = await deps.fetch(url, {
    headers: { 'user-agent': 'openmanager-update' },
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!response.ok || !response.body) {
    throw new CommandError(`Download failed (${response.status}): ${url}`)
  }
  await pipeline(
    Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
    createWriteStream(file),
  )
}

async function extract(archive: string, into: string, deps: StandaloneDeps): Promise<void> {
  // Windows ships bsdtar in System32, which reads zip; take that one, not
  // whatever tar comes first on PATH (Git's GNU tar cannot).
  const tar =
    deps.platform === 'win32'
      ? win32.join(deps.env.SystemRoot ?? deps.env.windir ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  const result = await deps.run(tar, ['-xf', archive, '-C', into])
  if (result.code !== 0) {
    throw new CommandError(
      `Could not unpack ${archive}: ${`${result.stderr}${result.stdout}`.trim()}`,
    )
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

/**
 * Download, verify and unpack `version` into its own folder, unless a complete
 * copy is already there. Returns the folder's executable.
 */
async function installVersion(
  root: string,
  version: string,
  deps: StandaloneDeps,
): Promise<string> {
  const path = pathFor(deps.platform)
  const target = releaseTarget(deps.platform, deps.arch)
  if (!target) throw new CommandError(`No OpenManager build for ${deps.platform}-${deps.arch}.`)
  const versionDir = versionDirectory(root, version, deps.platform)
  const executable = path.join(versionDir, executableName(deps.platform))
  const marker = path.join(versionDir, COMPLETE_MARKER)
  if ((await readFile(marker, 'utf8').catch(() => '')).trim() === version) return executable

  const archive = archiveName(version, target)
  const base = `${releaseBaseUrl(deps.env)}/${releaseTag(version)}`
  const staging = path.join(path.dirname(versionDir), `.staging-${randomBytes(6).toString('hex')}`)
  await mkdir(staging, { recursive: true })
  try {
    deps.stdout(`Downloading ${archive}...`)
    const sumsFile = path.join(staging, CHECKSUMS_FILE)
    await download(`${base}/${CHECKSUMS_FILE}`, sumsFile, deps)
    const expected = parseChecksums(await readFile(sumsFile, 'utf8')).get(archive)
    if (!expected)
      throw new CommandError(`${CHECKSUMS_FILE} of ${version} does not list ${archive}.`)
    const archiveFile = path.join(staging, archive)
    await download(`${base}/${archive}`, archiveFile, deps)
    const actual = await sha256(archiveFile)
    if (actual !== expected) {
      throw new CommandError(
        `Checksum mismatch for ${archive}: expected ${expected}, got ${actual}. Nothing was changed.`,
      )
    }
    const unpacked = path.join(staging, 'unpacked')
    await mkdir(unpacked)
    await extract(archiveFile, unpacked, deps)
    const unpackedExecutable = path.join(unpacked, executableName(deps.platform))
    if (!(await exists(unpackedExecutable))) {
      throw new CommandError(`${archive} has no ${executableName(deps.platform)}.`)
    }
    if (deps.platform !== 'win32') await chmod(unpackedExecutable, 0o755)
    const reported = await deps.run(unpackedExecutable, ['--version'])
    if (reported.code !== 0 || reported.stdout.trim() !== version) {
      throw new CommandError(
        `The downloaded ${version} does not run here: ${`${reported.stderr}${reported.stdout}`.trim() || `exit ${reported.code}`}`,
      )
    }
    await writeFile(path.join(unpacked, COMPLETE_MARKER), version, 'utf8')
    await rm(versionDir, { recursive: true, force: true })
    await rename(unpacked, versionDir)
    return executable
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Remove version folders other than `keep`, skipping any still in use. */
async function pruneVersions(copy: InstalledCopy, keep: readonly string[], deps: StandaloneDeps) {
  const path = pathFor(deps.platform)
  const entries = await readdir(copy.versionsDir).catch(() => [] as string[])
  for (const entry of entries) {
    if (keep.includes(entry) || !(isVersion(entry) || entry.startsWith('.staging-'))) continue
    // A version whose server is still running is locked on Windows; next time.
    await rm(path.join(copy.versionsDir, entry), { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The installed background service as `executable` sees it: `undefined` when
 * there is none, or when the service manager could not be asked at all (a
 * WSL distro without systemd, say), which leaves nothing to move or remove.
 */
async function installedService(
  executable: string,
  deps: StandaloneDeps,
): Promise<{ program: string[] } | undefined> {
  const result = await deps.run(executable, ['service', 'status', '--json'])
  try {
    const status = JSON.parse(result.stdout) as { installed?: unknown; program?: unknown }
    if (status.installed !== true) return undefined
    const program = Array.isArray(status.program)
      ? status.program.filter((part): part is string => typeof part === 'string')
      : []
    return { program }
  } catch {
    return undefined
  }
}

function samePath(a: string | undefined, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a?.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Hand an installed service over to `executable` (CAL-95's `service update`)
 * unless it already runs it. Returns the exit code.
 */
async function moveServiceTo(executable: string, deps: StandaloneDeps): Promise<number> {
  const service = await installedService(executable, deps)
  if (!service) return 0
  if (service.program.length === 1 && samePath(service.program[0], executable, deps.platform)) {
    return 0
  }
  deps.stdout('Moving the background service to this version...')
  // The new build performs the handoff, so its own service code applies.
  const code = await deps.runAttached(executable, ['service', 'update'])
  if (code !== 0) {
    deps.stderr(
      'The background service did not move to this version; see "openmanager service status".',
    )
  }
  return code
}

/** `openmanager update [<version>]`. */
export async function runUpdate(
  args: readonly string[],
  deps: StandaloneDeps = defaultDeps(),
): Promise<number> {
  try {
    if (args.length > 1 || (args[0] !== undefined && !isVersion(args[0]))) {
      throw new CommandError('Usage: openmanager update [<version>]   (for example 0.2.0)')
    }
    const copy = requireInstall(deps, 'update')
    const target = args[0] ?? (await fetchNewestRelease(deps.fetch, deps.env))
    if (
      (args[0] === undefined && compareVersions(target, copy.version) <= 0) ||
      target === copy.version
    ) {
      deps.stdout(
        `OpenManager ${copy.version} is already the ${args[0] ? 'installed' : 'newest'} version.`,
      )
      // An install script may have unpacked it without moving the service.
      return await moveServiceTo(deps.execPath, deps)
    }
    const executable = await installVersion(copy.root, target, deps)
    await activateCopy(
      { ...copy, version: target, versionDir: versionDirectory(copy.root, target, deps.platform) },
      deps,
    )
    deps.stdout(`OpenManager ${target} is installed; "openmanager" now runs it.`)
    const moved = await moveServiceTo(executable, deps)
    // Both versions stay when the handoff failed.
    if (moved !== 0) return moved
    // Keep the version moved from, for a manual rollback.
    await pruneVersions(copy, [target, copy.version], deps)
    return 0
  } catch (error) {
    return fail(error, deps)
  }
}

const USER_PATH_SCRIPT = (dir: string) =>
  [
    "$ErrorActionPreference = 'Stop'",
    `$dir = '${dir.replaceAll("'", "''")}'`,
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    "$value = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
    "$kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { 'ExpandString' }",
    "$kept = @($value -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ne $dir.TrimEnd('\\')) })",
    "$key.SetValue('Path', ($kept -join ';'), $kind)",
    // Setting and clearing a variable broadcasts the change to new terminals.
    "[Environment]::SetEnvironmentVariable('OPENMANAGER_PATH_REFRESH', '1', 'User')",
    "[Environment]::SetEnvironmentVariable('OPENMANAGER_PATH_REFRESH', $null, 'User')",
  ].join('\n')

/** `openmanager uninstall`: the service, the launcher and every version; never the data. */
export async function runUninstall(
  args: readonly string[],
  deps: StandaloneDeps = defaultDeps(),
): Promise<number> {
  try {
    if (args.length > 0) throw new CommandError('"openmanager uninstall" takes no arguments.')
    const copy = requireInstall(deps, 'uninstall')
    const path = pathFor(deps.platform)
    if (await installedService(deps.execPath, deps)) {
      const serviceCode = await deps.service(['uninstall'])
      if (serviceCode !== 0) {
        deps.stderr(
          'The background service could not be removed, so the install was left in place.',
        )
        return serviceCode
      }
    }
    const { binDir } = await readRecord(copy.root, deps)
    const launcher = path.join(binDir, launcherName(deps.platform))
    if (deps.platform === 'win32') {
      // install.ps1 put the folder on the user PATH; take exactly that entry off.
      const result = await deps.run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(USER_PATH_SCRIPT(binDir), 'utf16le').toString('base64'),
      ])
      if (result.code !== 0) deps.stderr(`Remove ${binDir} from your user PATH yourself.`)
      // This executable runs from the install folder, which Windows will not
      // delete until it exits, and cmd.exe may still be reading the launcher
      // that started it. A detached helper removes both a moment later.
      const script = `ping -n 3 127.0.0.1 >nul & del /f /q "${launcher}" & rmdir /s /q "${copy.root}"`
      spawn('cmd.exe', ['/d', '/c', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
      }).unref()
    } else {
      await rm(launcher, { force: true })
      await rm(copy.root, { recursive: true, force: true })
    }
    deps.stdout(`Removed OpenManager from ${copy.root}.`)
    deps.stdout(
      'Your environment data (identity, sessions, credentials) is kept in its data directory, ~/.openmanager unless you chose another. Delete it yourself to remove it too.',
    )
    return 0
  } catch (error) {
    return fail(error, deps)
  }
}

function fail(error: unknown, deps: StandaloneDeps): number {
  deps.stderr(error instanceof Error ? error.message : String(error))
  return 1
}
