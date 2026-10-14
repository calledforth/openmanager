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
  rmdir,
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
  launcherRootExpression,
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
  if (deps.platform === 'win32' && copy.root.includes('%')) {
    // cmd.exe expands %NAME% in the launcher's own path before running it.
    throw new CommandError(
      `The install folder ${copy.root} contains '%', which the openmanager command cannot run from on Windows. Install into a folder without '%'.`,
    )
  }
  return copy
}

interface InstallRecord {
  binDir: string
  /** The version the launcher ran before, when known. */
  version?: string
}

/**
 * Where the launcher lives (OPENMANAGER_BIN_DIR, else the recorded folder,
 * else the default) and which version was last activated.
 */
async function readRecord(root: string, deps: StandaloneDeps): Promise<InstallRecord> {
  const path = pathFor(deps.platform).join(root, INSTALL_RECORD)
  let recorded: { binDir?: unknown; version?: unknown } = {}
  try {
    recorded = JSON.parse(await readFile(path, 'utf8')) as typeof recorded
  } catch {
    // Missing or unreadable: fall back to where activate would have put it.
  }
  const binDir =
    // Absolute, so a later update from another folder finds the same launcher.
    pathFor(deps.platform).resolve(
      deps.env.OPENMANAGER_BIN_DIR ||
        (typeof recorded.binDir === 'string' && recorded.binDir
          ? recorded.binDir
          : defaultBinDir(deps.platform, deps.env, deps.homedir, root)),
    )
  const version =
    typeof recorded.version === 'string' && isVersion(recorded.version)
      ? recorded.version
      : undefined
  return { binDir, ...(version ? { version } : {}) }
}

const LOCK_FILE = '.lock'

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Run `action` holding `<root>/.lock`, so two updates (or an update and an
 * install script) cannot prune or swap each other's versions. A lock whose
 * process is gone is taken over.
 */
async function withInstallLock<T>(
  root: string,
  deps: StandaloneDeps,
  action: () => Promise<T>,
): Promise<T> {
  const file = pathFor(deps.platform).join(root, LOCK_FILE)
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(file, String(process.pid), { flag: 'wx' })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw error
      const holder = Number((await readFile(file, 'utf8').catch(() => '')).trim())
      if (Number.isInteger(holder) && holder > 0 && processAlive(holder)) {
        throw new CommandError(
          `Another openmanager install or update is running (process ${holder}). Let it finish, then try again.`,
        )
      }
      await rm(file, { force: true })
    }
  }
  try {
    return await action()
  } finally {
    await rm(file, { force: true })
  }
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
    const text = windowsLauncher(launcherRootExpression(copy.root, binDir, deps.env))
    if ((await readFile(launcher, 'utf8').catch(() => undefined)) !== text) {
      await replaceAtomically(launcher, (temporary) => writeFile(temporary, text, 'utf8'))
    }
  } else {
    const executable = path.join(copy.versionDir, executableName(deps.platform))
    await replaceAtomically(launcher, (temporary) => symlink(executable, temporary))
  }
  return launcher
}

/**
 * Make `copy` the version on PATH and record where the launcher lives.
 * Returns the launcher and the version that was active before.
 */
async function activateCopy(
  copy: InstalledCopy,
  deps: StandaloneDeps,
): Promise<{ launcher: string; previous: string | undefined }> {
  const path = pathFor(deps.platform)
  const { binDir, version: previous } = await readRecord(copy.root, deps)
  const launcher = await writeLauncher(binDir, copy, deps)
  await writeFile(
    path.join(copy.root, INSTALL_RECORD),
    `${JSON.stringify({ binDir, version: copy.version }, null, 2)}\n`,
    'utf8',
  )
  return { launcher, previous }
}

/** The version folder an installed service runs from, when it runs a released executable. */
function serviceVersion(service: ServiceLookup, deps: StandaloneDeps): string | undefined {
  if (service.state !== 'installed' || service.program.length !== 1) return undefined
  return installedCopy(service.program[0]!, deps.platform)?.version
}

/** `openmanager activate`: called by the install scripts on the version they unpacked. */
export async function runActivate(
  args: readonly string[],
  deps: StandaloneDeps = defaultDeps(),
): Promise<number> {
  try {
    if (args.length > 0) throw new CommandError('"openmanager activate" takes no arguments.')
    const copy = requireInstall(deps, 'activate')
    return await withInstallLock(copy.root, deps, () => activate(copy, deps))
  } catch (error) {
    return fail(error, deps)
  }
}

async function activate(copy: InstalledCopy, deps: StandaloneDeps): Promise<number> {
  try {
    const { launcher, previous } = await activateCopy(copy, deps)
    const binDir = pathFor(deps.platform).dirname(launcher)
    deps.stdout(`OpenManager ${copy.version} is installed: ${launcher}`)
    const service = await lookUpService(deps.execPath, deps)
    const moved = await moveServiceTo(deps.execPath, service, deps)
    if (moved !== 0) return moved
    // Like update: keep this version and the one before it, for a rollback.
    if (service.state !== 'unknown') {
      const keep = [copy.version, previous, serviceVersion(service, deps)].filter(
        (version): version is string => version !== undefined,
      )
      await pruneVersions(copy, keep, deps)
    }
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
/** A staging folder younger than this may belong to an install script still running. */
const STALE_STAGING_MS = 24 * 60 * 60_000

async function pruneVersions(copy: InstalledCopy, keep: readonly string[], deps: StandaloneDeps) {
  const path = pathFor(deps.platform)
  const entries = await readdir(copy.versionsDir).catch(() => [] as string[])
  for (const entry of entries) {
    if (keep.includes(entry)) continue
    if (entry.startsWith('.staging-')) {
      // The install scripts stage here without the lock; leave recent ones.
      const modified = await stat(path.join(copy.versionsDir, entry)).then(
        (info) => info.mtimeMs,
        () => Date.now(),
      )
      if (Date.now() - modified < STALE_STAGING_MS) continue
    } else if (!isVersion(entry)) {
      continue
    }
    // A version whose server is still running is locked on Windows; next time.
    await rm(path.join(copy.versionsDir, entry), { recursive: true, force: true }).catch(() => {})
  }
}

type ServiceLookup =
  | { state: 'none' }
  | { state: 'installed'; program: string[] }
  /** The service manager could not be asked (Task Scheduler down, no systemd). */
  | { state: 'unknown'; reason: string }

/** The installed background service as `executable` sees it. */
async function lookUpService(executable: string, deps: StandaloneDeps): Promise<ServiceLookup> {
  const result = await deps.run(executable, ['service', 'status', '--json'])
  try {
    const status = JSON.parse(result.stdout) as { installed?: unknown; program?: unknown }
    if (status.installed !== true) return { state: 'none' }
    const program = Array.isArray(status.program)
      ? status.program.filter((part): part is string => typeof part === 'string')
      : []
    return { state: 'installed', program }
  } catch {
    const reason = `${result.stderr}${result.stdout}`.trim() || `exit ${result.code}`
    return { state: 'unknown', reason }
  }
}

function samePath(a: string | undefined, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a?.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Hand an installed service over to `executable` (CAL-95's `service update`)
 * unless it already runs it. Returns the exit code.
 */
async function moveServiceTo(
  executable: string,
  service: ServiceLookup,
  deps: StandaloneDeps,
): Promise<number> {
  if (service.state === 'unknown') {
    deps.stderr(
      `Could not check for a background service, so none was moved to this version (${service.reason}). Run "openmanager service update" once that works.`,
    )
    return 0
  }
  if (service.state === 'none') return 0
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
    return await withInstallLock(copy.root, deps, () => update(copy, target, args[0], deps))
  } catch (error) {
    return fail(error, deps)
  }
}

async function update(
  copy: InstalledCopy,
  target: string,
  requested: string | undefined,
  deps: StandaloneDeps,
): Promise<number> {
  try {
    if (
      (requested === undefined && compareVersions(target, copy.version) <= 0) ||
      target === copy.version
    ) {
      deps.stdout(
        `OpenManager ${copy.version} is already the ${requested ? 'installed' : 'newest'} version.`,
      )
      // An install script may have unpacked it without moving the service.
      return await moveServiceTo(deps.execPath, await lookUpService(deps.execPath, deps), deps)
    }
    // The build the service runs now is the last known good one; keep it.
    const running = serviceVersion(await lookUpService(deps.execPath, deps), deps)
    const executable = await installVersion(copy.root, target, deps)
    await activateCopy(
      { ...copy, version: target, versionDir: versionDirectory(copy.root, target, deps.platform) },
      deps,
    )
    deps.stdout(`OpenManager ${target} is installed; "openmanager" now runs it.`)
    const service = await lookUpService(executable, deps)
    const moved = await moveServiceTo(executable, service, deps)
    // Both versions stay when the handoff failed or could not be checked.
    if (moved !== 0 || service.state === 'unknown') return moved
    // Keep the version moved from, for a manual rollback.
    const keep = [target, copy.version, running].filter(
      (version): version is string => version !== undefined,
    )
    await pruneVersions(copy, keep, deps)
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

/**
 * `openmanager uninstall [--force]`: the service, the launcher and every
 * version. Only what the install layout owns is deleted, so a data directory
 * someone placed inside the install folder survives.
 */
export async function runUninstall(
  args: readonly string[],
  deps: StandaloneDeps = defaultDeps(),
): Promise<number> {
  try {
    const force = args.length === 1 && args[0] === '--force'
    if (args.length > 0 && !force) {
      throw new CommandError('Usage: openmanager uninstall [--force]')
    }
    const copy = requireInstall(deps, 'uninstall')
    const path = pathFor(deps.platform)
    const service = await lookUpService(deps.execPath, deps)
    if (service.state === 'unknown' && !force) {
      throw new CommandError(
        `Could not check for an installed background service (${service.reason}), so nothing was removed: a service left pointing at a deleted program fails at every start. Fix that, or run "openmanager uninstall --force" to remove the program anyway.`,
      )
    }
    if (service.state === 'installed') {
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
    const binInRoot = path.dirname(launcher) === path.join(copy.root, 'bin')
    const owned = [INSTALL_RECORD, CURRENT_FILE].map((name) => path.join(copy.root, name))
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
      // that started it. A detached helper removes them a moment later,
      // retrying the versions folder while the exiting process lets go.
      // PowerShell with -LiteralPath: no path character (%, &, ^) is special.
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
      const removeIfEmpty = (folder: string) =>
        `if (-not (Get-ChildItem -LiteralPath ${quote(folder)} -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath ${quote(folder)} -Force -ErrorAction SilentlyContinue }`
      const script = [
        'Start-Sleep -Seconds 2',
        `$versions = ${quote(copy.versionsDir)}`,
        'for ($i = 0; $i -lt 15 -and (Test-Path -LiteralPath $versions); $i++) {',
        '  Remove-Item -LiteralPath $versions -Recurse -Force -ErrorAction SilentlyContinue',
        '  if (Test-Path -LiteralPath $versions) { Start-Sleep -Seconds 1 }',
        '}',
        ...[launcher, ...owned].map(
          (file) => `Remove-Item -LiteralPath ${quote(file)} -Force -ErrorAction SilentlyContinue`,
        ),
        ...(binInRoot ? [removeIfEmpty(path.join(copy.root, 'bin'))] : []),
        removeIfEmpty(copy.root),
      ].join('\n')
      // A detached powershell.exe gets no console and never starts; started
      // from a detached cmd.exe it does. The base64 script has no character
      // cmd would expand.
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      spawn(
        'cmd.exe',
        [
          '/d',
          '/c',
          `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
        ],
        { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true },
      ).unref()
    } else {
      await rm(launcher, { force: true })
      await rm(copy.versionsDir, { recursive: true, force: true })
      for (const file of owned) await rm(file, { force: true })
      if (binInRoot) await rmdir(path.join(copy.root, 'bin')).catch(() => {})
      // Only when empty: anything else in the folder is not ours to delete.
      await rmdir(copy.root).catch(() => {})
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
