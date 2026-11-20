import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { posix, win32 } from 'node:path'

/** Which `codex` binary openmanager spawns as `codex app-server`.
 *
 * One helper, shared by the session runtime, the provider health probe and
 * (later) title generation, so `CODEX_BIN` means the same binary everywhere. A
 * health check that resolved a different binary from the one a session spawns
 * would report on nothing, which is the same reason Claude's resolution lives
 * in one place (`../claude/executable.ts`).
 *
 * Resolution order, as decided in `docs/decisions/codex-app-server.md`:
 *
 * 1. `CODEX_BIN`, an absolute path or a name looked up on PATH.
 * 2. `codex` on PATH. On Windows an npm `codex.cmd` shim is unwrapped to the
 *    native `codex.exe` it ends up running.
 * 3. The standalone CLI the Codex desktop app installs and keeps updated, under
 *    `$CODEX_HOME/packages/standalone`.
 *
 * "Not installed" is an answer, not an exception: callers turn it into a
 * provider-health message rather than a crash. */

export const CODEX_BIN_ENV = 'CODEX_BIN'

export type CodexExecutableSource = 'env' | 'path' | 'standalone'

export type CodexExecutable = {
  /** Absolute path when we found the file, which is always, except that an
   * unrecognised `.cmd` shim is returned as the shim itself. */
  command: string
  source: CodexExecutableSource
  /** True only when `command` is a `.cmd`/`.bat` file. Node refuses to spawn
   * those without `shell: true` (since the CVE-2024-27980 fix), and going
   * through a shell means the caller must quote arguments itself. */
  needsShell: boolean
}

export type CodexExecutableResolution =
  | { found: true; executable: CodexExecutable }
  | {
      found: false
      /** The places looked at, for the health message and for logs. */
      searched: string[]
      /** Set when `CODEX_BIN` was given but does not name an executable. We do
       * not fall back to PATH then: an override is a statement of intent, and
       * quietly running some other `codex` would hide the mistake. */
      envOverride?: string
    }

/** Everything the resolver reads from the outside world, injectable so tests
 * can cover Windows layouts on Linux without touching the real filesystem. */
export type CodexExecutableDeps = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  homedir?: string
  /** True when the path is an existing file we may execute. */
  exists?: (path: string) => boolean
  readFile?: (path: string) => string | undefined
  listDir?: (path: string) => string[]
  /** Symlinks and junctions followed; the input back when it cannot be. */
  realpath?: (path: string) => string
}

/** Resolve the Codex executable.
 *
 * Only trusted configuration may choose the binary: `env` here is the
 * environment's own process environment (or the spawn env derived from it),
 * never anything that arrived over the wire. Letting a client name the
 * executable would be remote code execution. */
export function resolveCodexExecutable(deps: CodexExecutableDeps = {}): CodexExecutableResolution {
  const platform = deps.platform ?? process.platform
  const ctx: Context = {
    env: deps.env ?? process.env,
    platform,
    arch: deps.arch ?? process.arch,
    homedir: deps.homedir ?? osHomedir(),
    path: platform === 'win32' ? win32 : posix,
    exists: deps.exists ?? isExecutableFile,
    readFile: deps.readFile ?? readText,
    listDir: deps.listDir ?? listDirectory,
    realpath: deps.realpath ?? realpathOrSelf,
  }

  const override = readEnv(ctx, CODEX_BIN_ENV)?.trim()
  if (override) {
    const resolved = resolveOverride(ctx, override)
    if (!resolved) return { found: false, searched: [override], envOverride: override }
    return { found: true, executable: finish(ctx, resolved, 'env') }
  }

  const onPath = searchPath(ctx, 'codex')
  if (onPath) return { found: true, executable: finish(ctx, onPath, 'path') }

  const standalone = standaloneCandidates(ctx)
  for (const candidate of standalone.files) {
    if (ctx.exists(candidate))
      return { found: true, executable: { command: candidate, source: 'standalone', needsShell: false } }
  }
  const newest = newestStandaloneRelease(ctx, standalone.releases)
  if (newest) return { found: true, executable: { command: newest, source: 'standalone', needsShell: false } }

  return { found: false, searched: ['PATH', ...standalone.files, standalone.releases] }
}

type Context = {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  homedir: string
  path: typeof posix
  exists: (path: string) => boolean
  readFile: (path: string) => string | undefined
  listDir: (path: string) => string[]
  realpath: (path: string) => string
}

/** An absolute override is taken as given (plus PATHEXT on Windows, so
 * `C:\tools\codex` finds `codex.exe`). A bare name is looked up on PATH. A
 * relative path is refused: it would resolve against whatever directory the
 * server happened to start in. */
function resolveOverride(ctx: Context, override: string): string | undefined {
  if (ctx.path.isAbsolute(override)) {
    for (const extension of extensionsFor(ctx, override)) {
      if (ctx.exists(override + extension)) return override + extension
    }
    return undefined
  }
  if (override.includes('/') || (ctx.platform === 'win32' && override.includes('\\'))) return undefined
  return searchPath(ctx, override)
}

/** PATH lookup, done here rather than left to `spawn`, so the probe and the
 * session agree on an absolute path and Windows extensions are applied without
 * going through a shell. */
function searchPath(ctx: Context, name: string): string | undefined {
  const value = readEnv(ctx, 'PATH') ?? ''
  const delimiter = ctx.platform === 'win32' ? win32.delimiter : posix.delimiter
  for (const raw of value.split(delimiter)) {
    const directory = raw.trim().replace(/^"|"$/g, '')
    if (!directory) continue
    for (const extension of extensionsFor(ctx, name)) {
      const candidate = ctx.path.join(directory, name + extension)
      if (ctx.exists(candidate)) return candidate
    }
  }
  return undefined
}

/** On Windows, PATHEXT only, and no bare name: an npm global install puts an
 * extensionless `codex` *sh* script next to `codex.cmd`, and Windows cannot
 * execute it. A name that already carries one of the extensions is tried as is.
 * Extensions are lowercased because the filesystem does not care and
 * `codex.cmd` reads better in logs than `codex.CMD`. */
function extensionsFor(ctx: Context, name: string): string[] {
  if (ctx.platform !== 'win32') return ['']
  const extensions = (readEnv(ctx, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
  return extensions.includes(win32.extname(name).toLowerCase()) ? [''] : extensions
}

function finish(ctx: Context, command: string, source: CodexExecutableSource): CodexExecutable {
  if (ctx.platform !== 'win32' || !/\.(cmd|bat)$/i.test(command))
    return { command, source, needsShell: false }
  const native = unwrapNpmShim(ctx, command)
  return native ? { command: native, source, needsShell: false } : { command, source, needsShell: true }
}

/** The native `codex.exe` behind an npm (or pnpm) `codex.cmd` shim.
 *
 * Spawning the shim costs a `cmd.exe` and a `node` for the life of every
 * session, only for `bin/codex.js` to spawn the native binary anyway. That
 * launcher finds the binary by resolving `@openai/codex-win32-<arch>` from the
 * `@openai/codex` package (the platform build is an optional dependency) and
 * looking in its `vendor/<target triple>/bin/codex.exe`, falling back to the
 * package's own `vendor/`. We mirror that lookup without running node.
 *
 * The package directory comes from the shim itself (npm writes
 * `"%dp0%\node_modules\@openai\codex\bin\codex.js"`, pnpm `"%~dp0\...\codex.js"`),
 * so a shim we do not recognise is left alone rather than guessed at. */
function unwrapNpmShim(ctx: Context, shim: string): string | undefined {
  const text = ctx.readFile(shim)
  const match = text?.match(/%~?dp0%?\\?([^"%\r\n]*?@openai\\codex)\\bin\\codex\.js/i)
  if (!match?.[1]) return undefined
  const lexical = win32.join(win32.dirname(shim), match[1])
  // pnpm links the package out of its store; the platform build sits next to
  // the real directory, not next to the link.
  const packageDirs = [...new Set([lexical, ctx.realpath(lexical)])]
  for (const triple of windowsTriples(ctx.arch)) {
    const platformPackage = `codex-win32-${triple.startsWith('aarch64') ? 'arm64' : 'x64'}`
    for (const packageDir of packageDirs) {
      const candidates = [
        // Nested under the package (npm's usual placement for this alias).
        win32.join(packageDir, 'node_modules', '@openai', platformPackage, 'vendor', triple, 'bin', 'codex.exe'),
        // Hoisted next to it (npm when nothing conflicts, and pnpm's store).
        win32.join(win32.dirname(packageDir), platformPackage, 'vendor', triple, 'bin', 'codex.exe'),
        // Bundled in the package itself, the launcher's own fallback.
        win32.join(packageDir, 'vendor', triple, 'bin', 'codex.exe'),
        // Older releases kept the binary under `codex/` rather than `bin/`.
        win32.join(packageDir, 'vendor', triple, 'codex', 'codex.exe'),
      ]
      for (const candidate of candidates) {
        if (ctx.exists(candidate)) return candidate
      }
    }
  }
  return undefined
}

/** The launcher picks one build by `process.arch`; so do we. */
function windowsTriples(arch: NodeJS.Architecture): string[] {
  if (arch === 'x64') return ['x86_64-pc-windows-msvc']
  if (arch === 'arm64') return ['aarch64-pc-windows-msvc']
  return ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']
}

/** The desktop app's standalone CLI. `current` is a link the app moves on each
 * update; on Windows the app also links `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`
 * to `current/bin`. The releases directory is the fallback for an install whose
 * link is missing (an interrupted update, or a filesystem without links). */
function standaloneCandidates(ctx: Context): { files: string[]; releases: string } {
  const codexHome = readEnv(ctx, 'CODEX_HOME')?.trim() || ctx.path.join(ctx.homedir, '.codex')
  const standalone = ctx.path.join(codexHome, 'packages', 'standalone')
  const binary = ctx.platform === 'win32' ? 'codex.exe' : 'codex'
  const files = [ctx.path.join(standalone, 'current', 'bin', binary)]
  const localAppData = ctx.platform === 'win32' ? readEnv(ctx, 'LOCALAPPDATA')?.trim() : undefined
  if (localAppData) files.push(win32.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', binary))
  return { files, releases: ctx.path.join(standalone, 'releases') }
}

/** Release directories are named `<version>-<target triple>`, for example
 * `0.170.0-x86_64-unknown-linux-musl`. The highest version with a binary wins. */
function newestStandaloneRelease(ctx: Context, releases: string): string | undefined {
  const binary = ctx.platform === 'win32' ? 'codex.exe' : 'codex'
  const versioned = ctx
    .listDir(releases)
    .map((name) => ({ name, version: parseReleaseVersion(name) }))
    .filter((entry): entry is { name: string; version: ReleaseVersion } => entry.version !== undefined)
    .sort((a, b) => compareReleaseVersions(b.version, a.version))
  for (const { name } of versioned) {
    const candidate = ctx.path.join(releases, name, 'bin', binary)
    if (ctx.exists(candidate)) return candidate
  }
  return undefined
}

type ReleaseVersion = { numbers: [number, number, number]; prerelease: boolean }

function parseReleaseVersion(name: string): ReleaseVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.*))?$/.exec(name)
  if (!match) return undefined
  // Anything between the version and the target triple is a prerelease tag.
  const rest = match[4] ?? ''
  const prerelease = rest !== '' && !/^(x86_64|aarch64|arm64|universal)/.test(rest)
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease }
}

function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  for (let index = 0; index < 3; index++) {
    const difference = a.numbers[index]! - b.numbers[index]!
    if (difference !== 0) return difference
  }
  return Number(b.prerelease) - Number(a.prerelease)
}

/** Windows environment names are case-insensitive (`Path`, `PATH`), but a
 * copied env object is a plain one, so look the name up the way Windows would. */
function readEnv(ctx: Context, name: string): string | undefined {
  const exact = ctx.env[name]
  if (exact !== undefined || ctx.platform !== 'win32') return exact
  const upper = name.toUpperCase()
  for (const [key, value] of Object.entries(ctx.env)) {
    if (key.toUpperCase() === upper) return value
  }
  return undefined
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    // X_OK is a no-op on Windows, where the extension list carries the meaning.
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function listDirectory(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}
