import { access, readFile, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Resolves a representative icon for a workspace from the folder itself, so
 * a browser sidebar can show the same mark the desktop app does. This is the
 * server port of `apps/desktop/src/main/project-icon.ts`; keep the candidate
 * lists in step.
 *
 * Every read stays inside the workspace root: `openmanager.json` may name an
 * icon path, but a path that escapes the root or is absolute is ignored rather
 * than followed. A missing icon is the ordinary outcome and answers `null`;
 * nothing here throws.
 */

export const WORKSPACE_ICON_CONFIG_FILE = 'openmanager.json'
export const WORKSPACE_ICON_MAX_BYTES = 256 * 1024

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

function isPathInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK)
    const info = await stat(filePath)
    return info.isFile()
  } catch {
    return false
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const info = await stat(dirPath)
    return info.isDirectory()
  } catch {
    return false
  }
}

async function resolveRelativeWithinRoot(
  workspaceRoot: string,
  relativePath: string,
): Promise<string | null> {
  const trimmed = relativePath.trim()
  if (!trimmed || isAbsolute(trimmed)) return null
  const absolutePath = resolve(workspaceRoot, trimmed)
  if (!isPathInsideRoot(workspaceRoot, absolutePath)) return null
  if (!(await fileExists(absolutePath))) return null
  return absolutePath
}

async function readIconPathFromConfig(workspaceRoot: string): Promise<string | null> {
  const configPath = join(workspaceRoot, WORKSPACE_ICON_CONFIG_FILE)
  if (!(await fileExists(configPath))) return null
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const iconPath = (parsed as { iconPath?: unknown }).iconPath
    if (typeof iconPath !== 'string') return null
    const trimmed = iconPath.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

async function toDataUrl(filePath: string): Promise<string | null> {
  const mime = mimeForPath(filePath)
  if (!mime) return null
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size <= 0 || info.size > WORKSPACE_ICON_MAX_BYTES) return null
    const bytes = await readFile(filePath)
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

async function resolveFromCandidates(
  workspaceRoot: string,
  baseRelative: string | null,
): Promise<string | null> {
  for (const candidate of WORKSPACE_ICON_CANDIDATES) {
    const relativePath = baseRelative ? join(baseRelative, candidate) : candidate
    const absolutePath = await resolveRelativeWithinRoot(workspaceRoot, relativePath)
    if (!absolutePath) continue
    const dataUrl = await toDataUrl(absolutePath)
    if (dataUrl) return dataUrl
  }
  return null
}

/** Resolve a representative workspace icon as a data URL, or null when none is found. */
export async function resolveWorkspaceIconDataUrl(workspaceRoot: string): Promise<string | null> {
  const root = resolve(workspaceRoot)
  if (!(await directoryExists(root))) return null

  const configuredIconPath = await readIconPathFromConfig(root)
  if (configuredIconPath) {
    const configuredAbsolute = await resolveRelativeWithinRoot(root, configuredIconPath)
    if (configuredAbsolute) {
      const dataUrl = await toDataUrl(configuredAbsolute)
      if (dataUrl) return dataUrl
    }
  }

  const fromRoot = await resolveFromCandidates(root, null)
  if (fromRoot) return fromRoot

  for (const nestedRoot of WORKSPACE_ICON_NESTED_ROOTS) {
    const nestedAbsolute = resolve(root, nestedRoot)
    if (!isPathInsideRoot(root, nestedAbsolute)) continue
    if (!(await directoryExists(nestedAbsolute))) continue
    const fromNested = await resolveFromCandidates(root, nestedRoot)
    if (fromNested) return fromNested
  }

  return null
}
