import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, posix, resolve, sep, win32 } from 'node:path'

/**
 * Server-side path canonicalization under a registered workspace root
 * (threat model D9, T11). Clients send a path relative to a workspace; the
 * server resolves what the operating system would actually open and refuses
 * anything that lands outside the root. Symlinks, Windows junctions, 8.3 short
 * names and case-insensitive filesystems are all resolved by `realpath.native`,
 * so the check compares final on-disk locations, not spellings.
 */
export type PathRejection = 'invalid' | 'absolute' | 'escape'

export class PathBoundaryError extends Error {
  readonly reason: PathRejection
  constructor(reason: PathRejection, message: string) {
    super(message)
    this.name = 'PathBoundaryError'
    this.reason = reason
  }
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'
const fold = (path: string) => (CASE_INSENSITIVE ? path.toLowerCase() : path)
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && 'code' in error && codes.includes(String(error.code))
}

/** Resolve a configured root to its final on-disk directory. Throws when it does not exist. */
export function canonicalizeRoot(root: string): string {
  const real = realpathSync.native(root)
  if (!statSync(real).isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${root}`)
  }
  return real
}

/** Whether `candidate` is `root` or below it, comparing whole path segments. */
export function isWithinRoot(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return fold(candidate) === fold(root) || fold(candidate).startsWith(fold(prefix))
}

/** Absolute on either platform, drive-relative (`C:file`) or UNC (`\\server`, `//server`, `\\wsl$`). */
function looksAbsolute(path: string): boolean {
  return (
    win32.isAbsolute(path) ||
    posix.isAbsolute(path) ||
    /^[a-zA-Z]:/.test(path) ||
    /^[\\/]{2}/.test(path)
  )
}

/** Canonicalize the deepest existing ancestor, then append the not-yet-created remainder. */
function canonicalize(candidate: string): string {
  const missing: string[] = []
  let current = candidate
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return missing.length ? join(real, ...missing) : real
    } catch (error) {
      if (!hasCode(error, 'ENOENT', 'ENOTDIR')) throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve a client-supplied path relative to a canonical workspace root.
 * Returns the canonical absolute path the caller must use for the filesystem
 * operation; the path may not exist yet. Both `/` and `\` separate segments on
 * every platform. Throws `PathBoundaryError` for absolute or invalid input and
 * for anything that resolves outside the root.
 */
export function resolveWorkspacePath(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
    throw new PathBoundaryError('invalid', 'Path contains an invalid character.')
  }
  const normalized = relativePath.replace(/\\/g, '/')
  if (looksAbsolute(normalized) || looksAbsolute(relativePath)) {
    throw new PathBoundaryError('absolute', 'Paths must be relative to the workspace root.')
  }
  if (process.platform === 'win32') {
    for (const segment of normalized.split('/')) {
      if (segment.includes(':') || WINDOWS_DEVICE_NAME.test(segment)) {
        throw new PathBoundaryError('invalid', 'Path contains a reserved name or stream.')
      }
    }
  }
  const lexical = resolve(root, normalized)
  if (!isWithinRoot(root, lexical)) {
    throw new PathBoundaryError('escape', 'Path escapes the workspace root.')
  }
  const real = canonicalize(lexical)
  if (!isWithinRoot(root, real)) {
    throw new PathBoundaryError('escape', 'Path escapes the workspace root.')
  }
  return real
}
