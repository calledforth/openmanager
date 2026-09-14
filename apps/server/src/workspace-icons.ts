import { open } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { canonicalizeRoot, PathBoundaryError, resolveWorkspacePath } from './workspace-paths.ts'

/**
 * Resolves a representative icon for a workspace from the folder itself, so
 * a browser sidebar can show the same mark the desktop app does. This is the
 * server port of `apps/desktop/src/main/project-icon.ts`; keep the candidate
 * lists in step.
 *
 * Every candidate goes through `resolveWorkspacePath`, so the file actually
 * read is the canonical target and must sit inside the canonical root: a
 * symlink or junction inside the workspace that points elsewhere is skipped,
 * not followed. The bytes are read through one open handle whose own size is
 * checked, so a file swapped or grown between check and read cannot exceed
 * the cap. A missing icon is the ordinary outcome and answers `null`;
 * nothing here throws.
 */

export const WORKSPACE_ICON_CONFIG_FILE = 'openmanager.json'
export const WORKSPACE_ICON_MAX_BYTES = 256 * 1024
/** Upper bound on an `openmanager.json` we are willing to parse for `iconPath`. */
const WORKSPACE_ICON_CONFIG_MAX_BYTES = 64 * 1024

/**
 * Common nested package roots for monorepos / split frontend-backend trees.
 * Checked after workspace-root candidates, only when the directory exists.
 */
export const WORKSPACE_ICON_NESTED_ROOTS = [
  'apps/desktop',
  'packages/desktop',
  'apps/web',
  'packages/web',
  'frontend',
  'client',
  'web',
  'app',
] as const

/** Well-known relative icon paths, checked in order after openmanager.json iconPath. */
export const WORKSPACE_ICON_CANDIDATES = [
  // Electron (electron-builder defaults / common buildResources)
  'build/icon.svg',
  'build/icon.png',
  'build/icon.ico',
  'resources/icon.svg',
  'resources/icon.png',
  'resources/icon.ico',
  // Tauri
  'src-tauri/icons/icon.png',
  'src-tauri/icons/icon.svg',
  'src-tauri/icons/icon.ico',
  'app-icon.png',
  'app-icon.svg',
  // Web / framework favicons
  'favicon.svg',
  'favicon.ico',
  'favicon.png',
  'public/favicon.svg',
  'public/favicon.ico',
  'public/favicon.png',
  'app/favicon.ico',
  'app/favicon.png',
  'app/icon.svg',
  'app/icon.png',
  'app/icon.ico',
  'src/favicon.ico',
  'src/favicon.svg',
  'src/app/favicon.ico',
  'src/app/icon.svg',
  'src/app/icon.png',
  'assets/icon.svg',
  'assets/icon.png',
  'assets/logo.svg',
  'assets/logo.png',
  '.idea/icon.svg',
] as const

const MIME_BY_EXT: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function mimeForPath(filePath: string): string | null {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? null
}

/**
 * The canonical on-disk path for a relative candidate, or null when it is
 * absolute, escapes the root (lexically or through a link), or is otherwise
 * invalid. Existence is checked by the read that follows.
 */
function containedPath(root: string, relativePath: string): string | null {
  const trimmed = relativePath.trim()
  if (!trimmed) return null
  try {
    return resolveWorkspacePath(root, trimmed)
  } catch (error) {
    if (error instanceof PathBoundaryError) return null
    return null
  }
}

/**
 * Read a regular file of at most `maxBytes` through a single handle. The
 * size comes from the opened descriptor and the read is bounded to it, so a
 * concurrent replace or append cannot hand back more than the cap.
 */
async function readBounded(filePath: string, maxBytes: number): Promise<Buffer | null> {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return null
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) return null
    const buffer = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0)
    return bytesRead === info.size ? buffer : null
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readIconPathFromConfig(root: string): Promise<string | null> {
  const configPath = containedPath(root, WORKSPACE_ICON_CONFIG_FILE)
  if (!configPath) return null
  const raw = await readBounded(configPath, WORKSPACE_ICON_CONFIG_MAX_BYTES)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const iconPath = (parsed as { iconPath?: unknown }).iconPath
    if (typeof iconPath !== 'string') return null
    const trimmed = iconPath.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

async function toDataUrl(root: string, relativePath: string): Promise<string | null> {
  const filePath = containedPath(root, relativePath)
  if (!filePath) return null
  const mime = mimeForPath(filePath)
  if (!mime) return null
  const bytes = await readBounded(filePath, WORKSPACE_ICON_MAX_BYTES)
  return bytes ? `data:${mime};base64,${bytes.toString('base64')}` : null
}

async function resolveFromCandidates(
  root: string,
  baseRelative: string | null,
): Promise<string | null> {
  for (const candidate of WORKSPACE_ICON_CANDIDATES) {
    const dataUrl = await toDataUrl(root, baseRelative ? join(baseRelative, candidate) : candidate)
    if (dataUrl) return dataUrl
  }
  return null
}

/** Resolve a representative workspace icon as a data URL, or null when none is found. */
export async function resolveWorkspaceIconDataUrl(workspaceRoot: string): Promise<string | null> {
  let root: string
  try {
    root = canonicalizeRoot(workspaceRoot)
  } catch {
    return null
  }

  const configuredIconPath = await readIconPathFromConfig(root)
  if (configuredIconPath) {
    const dataUrl = await toDataUrl(root, configuredIconPath)
    if (dataUrl) return dataUrl
  }

  const fromRoot = await resolveFromCandidates(root, null)
  if (fromRoot) return fromRoot

  for (const nestedRoot of WORKSPACE_ICON_NESTED_ROOTS) {
    // A nested root that is itself a link out of the workspace is skipped;
    // candidates under a real one are checked the same way at read time.
    if (!containedPath(root, nestedRoot)) continue
    const fromNested = await resolveFromCandidates(root, nestedRoot)
    if (fromNested) return fromNested
  }

  return null
}
