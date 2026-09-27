import { lstat, open, readdir } from 'node:fs/promises'
import { extname, join, posix } from 'node:path'
import { canonicalizeRoot, resolveWorkspacePath } from './workspace-paths.ts'

/**
 * Resolves a representative icon for a workspace from the folder itself, so
 * a sidebar can show the project's own mark. Started as the server port of
 * `apps/desktop/src/main/project-icon.ts`; the desktop copy is frozen until
 * desktop moves onto this lookup, so it does not need to follow changes here.
 *
 * The lookup runs in three steps, first answer wins:
 * 1. `openmanager.json` `iconPath`.
 * 2. Well-known icon files at the root, then under the common nested app roots.
 * 3. Icons the project declares: `<link rel="icon">` in an `index.html`,
 *    `{ rel: 'icon', href }` or Next `icons` metadata in a root route or
 *    layout, and `icons` in a web app or browser-extension manifest. These
 *    are read at the root, then the nested app roots, then each other
 *    top-level folder.
 *
 * Every file read goes through `resolveWorkspacePath`, so the file actually
 * read is the canonical target and must sit inside the canonical root: a
 * symlink or junction inside the workspace that points elsewhere is skipped,
 * not followed, and so is a declared href that climbs out. The bytes are read
 * through one open handle whose own size is checked, so a file swapped or
 * grown between check and read cannot exceed the cap. A missing icon is the
 * ordinary outcome and answers `null`; nothing here throws.
 */

export const WORKSPACE_ICON_CONFIG_FILE = 'openmanager.json'
export const WORKSPACE_ICON_MAX_BYTES = 256 * 1024
/** Upper bound on an `openmanager.json` we are willing to parse for `iconPath`. */
const WORKSPACE_ICON_CONFIG_MAX_BYTES = 64 * 1024
/** Upper bound on an HTML, route, or layout file we scan for icon declarations. */
export const WORKSPACE_ICON_SOURCE_MAX_BYTES = 256 * 1024
/** Upper bound on a manifest we are willing to parse for `icons`. */
export const WORKSPACE_ICON_MANIFEST_MAX_BYTES = 64 * 1024
/** Top-level folders scanned for declared icons, beyond the nested app roots. */
const WORKSPACE_ICON_MAX_TOP_LEVEL_DIRS = 64

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

/** HTML and root route files that may carry `<link rel="icon">` or `{ rel: 'icon', href }`. */
export const WORKSPACE_ICON_LINK_SOURCES = [
  'index.html',
  'public/index.html',
  'src/index.html',
  'app/routes/__root.tsx',
  'src/routes/__root.tsx',
  'app/root.tsx',
  'src/root.tsx',
] as const

/** Next.js root layouts, which declare icons through `metadata.icons`. */
export const WORKSPACE_ICON_LAYOUT_SOURCES = [
  'app/layout.tsx',
  'app/layout.ts',
  'app/layout.jsx',
  'app/layout.js',
  'src/app/layout.tsx',
  'src/app/layout.ts',
  'src/app/layout.jsx',
  'src/app/layout.js',
] as const

/** Web app and browser-extension manifests whose `icons` name the project's mark. */
export const WORKSPACE_ICON_MANIFESTS = [
  'manifest.json',
  'site.webmanifest',
  'manifest.webmanifest',
  'public/manifest.json',
  'public/site.webmanifest',
  'public/manifest.webmanifest',
] as const

/**
 * Top-level folders never scanned for declared icons: dependencies, build
 * output, and caches carry other projects' icons, not this one's.
 */
const SKIPPED_TOP_LEVEL_DIRS = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'out',
  'build',
  'target',
  'coverage',
  'storybook-static',
  // Samples, fixtures, and docs sites often ship their own (or a framework's
  // default) favicon.
  'docs',
  'example',
  'examples',
  'fixtures',
  'playground',
  'samples',
  'templates',
  'test',
  'tests',
  '__tests__',
  'tmp',
  'temp',
])

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
  } catch {
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

async function readContainedText(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<string | null> {
  const filePath = containedPath(root, relativePath)
  if (!filePath) return null
  const raw = await readBounded(filePath, maxBytes)
  return raw ? raw.toString('utf8') : null
}

async function readIconPathFromConfig(root: string): Promise<string | null> {
  const raw = await readContainedText(
    root,
    WORKSPACE_ICON_CONFIG_FILE,
    WORKSPACE_ICON_CONFIG_MAX_BYTES,
  )
  if (!raw) return null
  try {
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

async function toDataUrl(root: string, relativePath: string): Promise<string | null> {
  const filePath = containedPath(root, relativePath)
  if (!filePath) return null
  const mime = mimeForPath(filePath)
  if (!mime) return null
  const bytes = await readBounded(filePath, WORKSPACE_ICON_MAX_BYTES)
  return bytes ? `data:${mime};base64,${bytes.toString('base64')}` : null
}

/** A found icon: the root-relative path it was read from, and its bytes as a data URL. */
interface FoundIcon {
  relativePath: string
  dataUrl: string
}

/** The first of `relativePaths` that reads as an icon. */
async function firstIcon(root: string, relativePaths: Iterable<string>): Promise<FoundIcon | null> {
  const tried = new Set<string>()
  for (const relativePath of relativePaths) {
    if (tried.has(relativePath)) continue
    tried.add(relativePath)
    const dataUrl = await toDataUrl(root, relativePath)
    if (dataUrl) return { relativePath, dataUrl }
  }
  return null
}

const inDir = (dir: string, relativePath: string) =>
  dir ? posix.join(dir, relativePath) : relativePath

// ---------------------------------------------------------------------------
// Declared icons
// ---------------------------------------------------------------------------

// A `<link>` tag whose rel names an icon and that carries an href, attributes
// in any order. Anchored on `<link` and stopped by the next `<` as well as
// `>`, so an unclosed tag cannot make each later `<link` rescan to the end of
// the file.
const LINK_TAG_RE = /<link\b[^<>]*>/gi
const LINK_REL_RE = /\brel\s*=\s*["']([^"']*)["']/i
const LINK_HREF_RE = /\bhref\s*=\s*["']([^"']+)["']/i
// Object metadata (`{ rel: 'icon', href: '/favicon.svg' }`) counts when rel
// and href share one brace-free run. Scanning runs, rather than one combined
// unanchored pattern, keeps large sources linear.
const OBJECT_REL_RE = /\brel\s*:\s*["']([^"']*)["']/i
const OBJECT_HREF_RE = /\bhref\s*:\s*["']([^"']+)["']/i
// Next `metadata.icons`: the first quoted image path shortly after `icons:`,
// which covers `icons: '/x.png'`, `{ icon: '/x.png' }`, and `{ icon: [{ url }] }`.
const NEXT_METADATA_RE =
  /\bexport\s+(?:const\s+metadata\b|(?:async\s+)?function\s+generateMetadata\b)/
const NEXT_ICONS_KEY_RE = /\bicons\s*:/g
const NEXT_ICON_URL_RE = /["']([^"'\s]+\.(?:svg|png|ico|jpe?g|webp|gif))(?:[?#][^"']*)?["']/i
const NEXT_ICONS_WINDOW = 400

/** 0 for a favicon rel, 1 for apple-touch-icon, null for anything else. */
function iconRelRank(rel: string): number | null {
  const tokens = rel.toLowerCase().split(/\s+/)
  if (tokens.includes('icon')) return 0
  if (tokens.includes('apple-touch-icon') || tokens.includes('apple-touch-icon-precomposed')) {
    return 1
  }
  return null
}

/**
 * Icon hrefs declared in an HTML document or a route module, favicons
 * before touch icons, each group in source order.
 */
export function extractDeclaredIconHrefs(source: string): string[] {
  const ranked: Array<{ rank: number; href: string }> = []
  for (const [tag] of source.matchAll(LINK_TAG_RE)) {
    const rel = tag.match(LINK_REL_RE)?.[1]
    const href = tag.match(LINK_HREF_RE)?.[1]
    const rank = rel === undefined ? null : iconRelRank(rel)
    if (rank !== null && href) ranked.push({ rank, href })
  }
  for (const run of source.split('}')) {
    const rel = run.match(OBJECT_REL_RE)?.[1]
    if (rel === undefined) continue
    const rank = iconRelRank(rel)
    const href = run.match(OBJECT_HREF_RE)?.[1]
    if (rank !== null && href) ranked.push({ rank, href })
  }
  return ranked.sort((a, b) => a.rank - b.rank).map(({ href }) => href)
}

/**
 * Icon paths a Next.js layout declares through `metadata.icons`. Only `icons`
 * keys after the `metadata` export (or `generateMetadata`) count, so an
 * unrelated `icons:` setting earlier in the layout cannot stand in for it.
 */
export function extractNextMetadataIconHrefs(source: string): string[] {
  const hrefs: string[] = []
  const metadataAt = source.search(NEXT_METADATA_RE)
  if (metadataAt === -1) return hrefs
  const declaration = source.slice(metadataAt)
  for (const match of declaration.matchAll(NEXT_ICONS_KEY_RE)) {
    const start = match.index + match[0].length
    const url = declaration.slice(start, start + NEXT_ICONS_WINDOW).match(NEXT_ICON_URL_RE)?.[1]
    if (url) hrefs.push(url)
  }
  return hrefs
}

/** Largest edge a manifest `sizes` value declares; `any` (scalable) outranks every raster. */
function manifestIconSize(sizes: unknown): number {
  if (typeof sizes !== 'string') return 0
  let best = 0
  for (const token of sizes.trim().toLowerCase().split(/\s+/)) {
    if (token === 'any') return Number.MAX_SAFE_INTEGER
    const edge = Number.parseInt(token.split('x')[0] ?? '', 10)
    if (Number.isFinite(edge) && edge > best) best = edge
  }
  return best
}

/**
 * Icon paths a web app manifest (`icons: [{ src, sizes, purpose }]`) or a
 * browser-extension manifest (`icons: { "128": path }`) declares, largest
 * first. Monochrome icons are dropped: they are silhouettes for the OS to tint.
 */
export function extractManifestIconHrefs(source: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const icons = (parsed as { icons?: unknown }).icons
  const sized: Array<{ href: string; size: number }> = []
  if (Array.isArray(icons)) {
    for (const icon of icons) {
      if (typeof icon !== 'object' || icon === null) continue
      const { src, sizes, purpose } = icon as { src?: unknown; sizes?: unknown; purpose?: unknown }
      if (typeof src !== 'string' || !src.trim()) continue
      if (typeof purpose === 'string' && !/\b(?:any|maskable)\b/i.test(purpose)) continue
      sized.push({ href: src, size: manifestIconSize(sizes) })
    }
  } else if (typeof icons === 'object' && icons !== null) {
    for (const [size, src] of Object.entries(icons)) {
      if (typeof src !== 'string' || !src.trim()) continue
      const edge = Number.parseInt(size, 10)
      sized.push({ href: src, size: Number.isFinite(edge) ? edge : 0 })
    }
  }
  return sized.sort((a, b) => b.size - a.size).map(({ href }) => href)
}

/**
 * Workspace-relative paths a declared href may name, most specific first, or
 * none for anything that is not a same-project path (a URL with a scheme, a
 * protocol-relative URL, a data URL). Root-absolute hrefs are served from the
 * app's `public/` folder in the bundlers we see, so they are tried there and
 * then at the app root; relative hrefs are tried beside the declaring file,
 * then under `public/`, then at the app root. Containment is checked later, by
 * the read.
 */
export function declaredHrefCandidates(appDir: string, sourceDir: string, href: string): string[] {
  let path = href.trim()
  if (!path || path.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(path)) return []
  path = path.split(/[?#]/, 1)[0] ?? ''
  try {
    path = decodeURIComponent(path)
  } catch {
    return []
  }
  if (!path || path.includes('\0')) return []
  if (path.startsWith('/')) {
    const clean = path.replace(/^\/+/, '')
    if (!clean) return []
    return [inDir(appDir, posix.join('public', clean)), inDir(appDir, clean)]
  }
  return [
    posix.normalize(inDir(sourceDir, path)),
    posix.normalize(inDir(appDir, posix.join('public', path))),
    posix.normalize(inDir(appDir, path)),
  ]
}

/** An icon one app folder declares in its HTML, route, layout, or manifest files. */
async function resolveDeclaredIn(root: string, appDir: string): Promise<FoundIcon | null> {
  const sources: Array<{
    file: string
    maxBytes: number
    extract: (source: string) => string[]
  }> = [
    ...WORKSPACE_ICON_LINK_SOURCES.map((file) => ({
      file,
      maxBytes: WORKSPACE_ICON_SOURCE_MAX_BYTES,
      extract: extractDeclaredIconHrefs,
    })),
    ...WORKSPACE_ICON_LAYOUT_SOURCES.map((file) => ({
      file,
      maxBytes: WORKSPACE_ICON_SOURCE_MAX_BYTES,
      extract: extractNextMetadataIconHrefs,
    })),
    ...WORKSPACE_ICON_MANIFESTS.map((file) => ({
      file,
      maxBytes: WORKSPACE_ICON_MANIFEST_MAX_BYTES,
      extract: extractManifestIconHrefs,
    })),
  ]
  for (const { file, maxBytes, extract } of sources) {
    const sourcePath = inDir(appDir, file)
    const source = await readContainedText(root, sourcePath, maxBytes)
    if (!source) continue
    const sourceDir = posix.dirname(sourcePath) === '.' ? '' : posix.dirname(sourcePath)
    const candidates = extract(source).flatMap((href) =>
      declaredHrefCandidates(appDir, sourceDir, href),
    )
    const found = await firstIcon(root, candidates)
    if (found) return found
  }
  return null
}

/**
 * Top-level folder names the root `.gitignore` ignores outright (`name`,
 * `name/`, `/name/`). Patterns with globs or deeper paths are left alone:
 * this only needs to catch generated output and local clones sitting at the
 * top, not reimplement git.
 */
async function gitignoredTopLevelNames(root: string): Promise<Set<string>> {
  const names = new Set<string>()
  const source = await readContainedText(root, '.gitignore', WORKSPACE_ICON_MANIFEST_MAX_BYTES)
  if (!source) return names
  for (const line of source.split(/\r?\n/)) {
    const pattern = line.trim()
    if (!pattern || pattern.startsWith('#') || pattern.startsWith('!')) continue
    const name = pattern.replace(/^\//, '').replace(/\/$/, '')
    if (!name || /[/*?[\\]/.test(name)) continue
    names.add(name.toLowerCase())
  }
  return names
}

/**
 * Whether a folder carries its own `.git` (a clone or submodule, so a
 * different project). Nothing is read here, so the entry is checked where it
 * sits with `lstat`: a `.git` that is itself a link out of the root still
 * counts, where a containment check would have refused it and let the
 * folder through.
 */
async function isOwnRepository(root: string, dir: string): Promise<boolean> {
  try {
    await lstat(join(root, dir, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * Real top-level folders that might hold an app of their own, in name order.
 * Links are skipped (a `Dirent` for a symlink or junction is not a directory),
 * as are dot-folders, dependency and build-output folders, folders the root
 * `.gitignore` ignores, nested repositories, and the folders the nested
 * roots already cover. Everything skipped here holds some other project's
 * icon, never this one's.
 */
async function topLevelAppDirs(root: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const nested = new Set<string>(WORKSPACE_ICON_NESTED_ROOTS)
  const ignored = await gitignoredTopLevelNames(root)
  const names = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !SKIPPED_TOP_LEVEL_DIRS.has(entry.name.toLowerCase()) &&
        !ignored.has(entry.name.toLowerCase()) &&
        !nested.has(entry.name),
    )
    .map((entry) => entry.name)
    .sort()
  // Clones are dropped before the cap, so they cannot use up the scan slots.
  const ownRepository = await Promise.all(names.map((name) => isOwnRepository(root, name)))
  return names
    .filter((_, index) => !ownRepository[index])
    .slice(0, WORKSPACE_ICON_MAX_TOP_LEVEL_DIRS)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

async function findWorkspaceIcon(root: string): Promise<FoundIcon | null> {
  const configuredIconPath = await readIconPathFromConfig(root)
  if (configuredIconPath) {
    const found = await firstIcon(root, [configuredIconPath])
    if (found) return found
  }

  // A nested root that is itself a link out of the workspace is skipped;
  // paths under a real one are checked the same way at read time.
  const nestedRoots = WORKSPACE_ICON_NESTED_ROOTS.filter((dir) => containedPath(root, dir))

  const fromWellKnown = await firstIcon(
    root,
    ['', ...nestedRoots].flatMap((dir) =>
      WORKSPACE_ICON_CANDIDATES.map((candidate) => inDir(dir, candidate)),
    ),
  )
  if (fromWellKnown) return fromWellKnown

  for (const appDir of ['', ...nestedRoots, ...(await topLevelAppDirs(root))]) {
    const declared = await resolveDeclaredIn(root, appDir)
    if (declared) return declared
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
  try {
    return (await findWorkspaceIcon(root))?.dataUrl ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export interface WorkspaceIconCacheOptions {
  now?: () => number
  capacity?: number
  hitTtlMs?: number
  missTtlMs?: number
}

export interface WorkspaceIconCache {
  /** Same answer as `resolveWorkspaceIconDataUrl`, reusing a recent lookup. */
  resolve(workspaceRoot: string): Promise<string | null>
  /** Forget a workspace's answer, e.g. when it is unregistered. */
  invalidate(workspaceRoot: string): void
}

/**
 * A small LRU in front of the resolver. A miss walks up to a few hundred
 * paths, so answers are kept: a found icon for ten minutes, a miss for one.
 * A kept hit stores where the icon was found, not its bytes, and re-reads it
 * through the same containment check on every call, so an edited icon shows
 * at once and a deleted or relinked one falls through to a fresh lookup
 * instead of waiting out the TTL.
 */
export function createWorkspaceIconCache(
  options: WorkspaceIconCacheOptions = {},
): WorkspaceIconCache {
  const now = options.now ?? Date.now
  const capacity = options.capacity ?? 512
  const hitTtlMs = options.hitTtlMs ?? 10 * 60_000
  const missTtlMs = options.missTtlMs ?? 60_000
  const entries = new Map<
    string,
    { root: string; relativePath: string | null; expiresAt: number }
  >()
  const pending = new Map<string, Promise<FoundIcon | null>>()

  const remember = (key: string, root: string, found: FoundIcon | null) => {
    entries.delete(key)
    entries.set(key, {
      root,
      relativePath: found?.relativePath ?? null,
      expiresAt: now() + (found ? hitTtlMs : missTtlMs),
    })
    while (entries.size > capacity) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  return {
    async resolve(workspaceRoot) {
      const cached = entries.get(workspaceRoot)
      if (cached && cached.expiresAt > now()) {
        // Refresh recency.
        entries.delete(workspaceRoot)
        entries.set(workspaceRoot, cached)
        if (cached.relativePath === null) return null
        const dataUrl = await toDataUrl(cached.root, cached.relativePath)
        if (dataUrl) return dataUrl
      }
      entries.delete(workspaceRoot)

      // Several clients asking at once share one walk.
      const inFlight = pending.get(workspaceRoot)
      if (inFlight) return (await inFlight)?.dataUrl ?? null

      let root: string
      try {
        root = canonicalizeRoot(workspaceRoot)
      } catch {
        // A folder that is gone is not cached: it may come back any moment.
        return null
      }
      const lookup = findWorkspaceIcon(root).catch(() => null)
      pending.set(workspaceRoot, lookup)
      try {
        const found = await lookup
        // An invalidate while the walk ran drops its answer rather than keeping it.
        if (pending.get(workspaceRoot) === lookup) remember(workspaceRoot, root, found)
        return found?.dataUrl ?? null
      } finally {
        if (pending.get(workspaceRoot) === lookup) pending.delete(workspaceRoot)
      }
    },
    invalidate(workspaceRoot) {
      entries.delete(workspaceRoot)
      pending.delete(workspaceRoot)
    },
  }
}
