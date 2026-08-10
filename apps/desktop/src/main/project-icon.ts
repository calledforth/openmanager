import { access, readFile, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

export const PROJECT_ICON_CONFIG_FILE = 'openmanager.json'
export const PROJECT_ICON_MAX_BYTES = 256 * 1024

/**
 * Common nested package roots for monorepos / split frontend-backend trees.
 * Checked after workspace-root candidates, only when the directory exists.
 */
export const PROJECT_ICON_NESTED_ROOTS = [
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
export const PROJECT_ICON_CANDIDATES = [
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

type OpenManagerProjectFile = {
  iconPath?: unknown
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
  const configPath = join(workspaceRoot, PROJECT_ICON_CONFIG_FILE)
  if (!(await fileExists(configPath))) return null
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as OpenManagerProjectFile
    if (typeof parsed.iconPath !== 'string') return null
    const iconPath = parsed.iconPath.trim()
    return iconPath.length > 0 ? iconPath : null
  } catch {
    return null
  }
}

async function toDataUrl(filePath: string): Promise<string | null> {
  const mime = mimeForPath(filePath)
  if (!mime) return null
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size <= 0 || info.size > PROJECT_ICON_MAX_BYTES) return null
    const bytes = await readFile(filePath)
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
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

async function resolveFromCandidates(
  workspaceRoot: string,
  baseRelative: string | null,
): Promise<string | null> {
  for (const candidate of PROJECT_ICON_CANDIDATES) {
    const relativePath = baseRelative ? join(baseRelative, candidate) : candidate
    const absolutePath = await resolveRelativeWithinRoot(workspaceRoot, relativePath)
    if (!absolutePath) continue
    const dataUrl = await toDataUrl(absolutePath)
    if (dataUrl) return dataUrl
  }
  return null
}

/** Resolve a representative project icon as a data URL, or null when none is found. */
export async function resolveWorkspaceIconDataUrl(workspacePath: string): Promise<string | null> {
  const workspaceRoot = resolve(workspacePath)
  try {
    const rootInfo = await stat(workspaceRoot)
    if (!rootInfo.isDirectory()) return null
  } catch {
    return null
  }

  const configuredIconPath = await readIconPathFromConfig(workspaceRoot)
  if (configuredIconPath) {
    const configuredAbsolute = await resolveRelativeWithinRoot(workspaceRoot, configuredIconPath)
    if (configuredAbsolute) {
      const dataUrl = await toDataUrl(configuredAbsolute)
      if (dataUrl) return dataUrl
    }
  }

  const fromRoot = await resolveFromCandidates(workspaceRoot, null)
  if (fromRoot) return fromRoot

  for (const nestedRoot of PROJECT_ICON_NESTED_ROOTS) {
    const nestedAbsolute = resolve(workspaceRoot, nestedRoot)
    if (!isPathInsideRoot(workspaceRoot, nestedAbsolute)) continue
    if (!(await directoryExists(nestedAbsolute))) continue
    const fromNested = await resolveFromCandidates(workspaceRoot, nestedRoot)
    if (fromNested) return fromNested
  }

  return null
}
