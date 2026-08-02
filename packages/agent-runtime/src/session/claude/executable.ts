import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { ClaudeProviderConfig } from '../../providers/index.js'

/** Where the Claude Code CLI is, resolved by us rather than by the SDK.
 *
 * The SDK does no PATH lookup at all. Left to itself it resolves
 * `pathToClaudeCodeExecutable` to the `claude` binary shipped inside its own
 * optional platform package (`@anthropic-ai/claude-agent-sdk-win32-x64` and
 * friends) and throws if that package is missing. That is the fallback this
 * provider deliberately refuses: a binary pinned to the SDK's version is not
 * the CLI the user authenticated, upgrades, or configured hooks for, and
 * silently running it would make "signed in" mean two different things.
 *
 * So resolution is ours, and it lives in one place because the probe and the
 * session runtime must agree: a health check that resolved a different binary
 * from the one a session spawns is a health check that reports on nothing. */

export class ClaudeExecutableNotFoundError extends Error {
  readonly kind = 'install' as const

  constructor(
    readonly bin: string,
    readonly envOverride: string,
    detail?: string,
  ) {
    super(
      detail ??
        `Claude Code CLI ("${bin}") was not found on PATH. Install it, or point ${envOverride} at the executable.`,
    )
    this.name = 'ClaudeExecutableNotFoundError'
  }
}

/** Resolve to an absolute path, or throw an *install* failure.
 *
 * Never an auth failure: telling somebody to sign in when the CLI is not on
 * their machine sends them to a login screen that cannot fix anything. The
 * caller distinguishes the two by catching this type.
 *
 * `env` is injectable so tests can drive both branches without mutating the
 * real process environment, and so a spawn env that differs from
 * `process.env` resolves against the PATH it will actually run under. */
export function resolveClaudeExecutable(
  config: ClaudeProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[config.binary.envOverride]?.trim()
  if (override) {
    // An override is a statement of intent: if it is wrong, say so about the
    // override rather than quietly searching PATH and running something else.
    const resolved = isAbsolute(override) ? executableAt(override) : searchPath(override, env)
    if (!resolved)
      throw new ClaudeExecutableNotFoundError(
        config.binary.bin,
        config.binary.envOverride,
        `${config.binary.envOverride} points at "${override}", which is not an executable file.`,
      )
    return resolved
  }
  const resolved = searchPath(config.binary.bin, env)
  if (!resolved)
    throw new ClaudeExecutableNotFoundError(config.binary.bin, config.binary.envOverride)
  return resolved
}

/** PATH lookup, PATHEXT included.
 *
 * Windows installs of Claude Code are not consistently one shape: the native
 * installer drops `claude.exe`, while an npm global install leaves a `claude`
 * shim next to `claude.cmd` (and `claude.ps1`). Node's `spawn` will not apply
 * PATHEXT for us unless the command runs through a shell, and running through
 * a shell is how quoting bugs get in, so the extension search happens here and
 * the SDK receives a fully qualified path it can spawn directly. */
function searchPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = env.PATH ?? env.Path ?? env.path ?? ''
  const extensions = executableExtensions(env)
  for (const directory of path.split(delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = executableAt(join(directory.replace(/^"|"$/g, ''), command + extension))
      if (candidate) return candidate
    }
  }
  return undefined
}

/** The empty string first, so an extensionless POSIX binary — and the
 * extensionless npm shim that also exists on Windows — wins over a `.cmd`
 * wrapper around it when both are present in the same directory. */
function executableExtensions(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return ['']
  const pathext = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  return ['', ...pathext.split(';').filter(Boolean)]
}

function executableAt(candidate: string): string | undefined {
  try {
    if (!statSync(candidate).isFile()) return undefined
    // X_OK is a no-op on Windows (every readable file reports executable), so
    // there the extension list is what carries the meaning.
    accessSync(candidate, constants.X_OK)
    return candidate
  } catch {
    return undefined
  }
}
