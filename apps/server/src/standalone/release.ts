/**
 * Server releases on GitHub. A `server-v<version>` tag carries one archive per
 * platform plus `SHA256SUMS`; see docs/RELEASING.md. Desktop releases share the
 * repository under `v*` tags and are ignored here.
 */

export const REPOSITORY = 'calledforth/openmanager'
export const TAG_PREFIX = 'server-v'
export const CHECKSUMS_FILE = 'SHA256SUMS'

export type ReleaseTarget = `${'win32' | 'linux'}-${'x64' | 'arm64'}`

/** The archive target for this machine, or `undefined` when there is no build for it. */
export function releaseTarget(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): ReleaseTarget | undefined {
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) return `linux-${arch}`
  return undefined
}

export function archiveName(version: string, target: ReleaseTarget): string {
  return `openmanager-${version}-${target}.${target.startsWith('win32') ? 'zip' : 'tar.gz'}`
}

export function releaseTag(version: string): string {
  return `${TAG_PREFIX}${version}`
}

/** Where release files are downloaded from: `<base>/<tag>/<file>`. */
export function releaseBaseUrl(env: NodeJS.ProcessEnv): string {
  return (
    env.OPENMANAGER_RELEASE_BASE_URL?.replace(/\/+$/, '') ??
    `https://github.com/${REPOSITORY}/releases/download`
  )
}

function parts(version: string): { numbers: number[]; pre: string | undefined } {
  // Only the first '-' separates: `1.2.3-rc-2` has prerelease `rc-2`.
  const dash = version.indexOf('-')
  const core = dash === -1 ? version : version.slice(0, dash)
  const pre = dash === -1 ? undefined : version.slice(dash + 1)
  return { numbers: core.split('.').map(Number), pre }
}

/** Semver-style comparison of `x.y.z[-pre]` versions: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < 3; index++) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (left.pre === right.pre) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return left.pre.localeCompare(right.pre, 'en', { numeric: true })
}

/**
 * The newest published server version in a GitHub `releases` listing:
 * `server-v*` tags only, never drafts, prereleases only when asked for.
 */
export function newestRelease(listing: unknown, includePrereleases = false): string | undefined {
  if (!Array.isArray(listing)) return undefined
  let newest: string | undefined
  for (const entry of listing) {
    if (!entry || typeof entry !== 'object') continue
    const release = entry as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
    if (typeof release.tag_name !== 'string' || !release.tag_name.startsWith(TAG_PREFIX)) continue
    if (release.draft === true || (release.prerelease === true && !includePrereleases)) continue
    const version = release.tag_name.slice(TAG_PREFIX.length)
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) continue
    if (newest === undefined || compareVersions(version, newest) > 0) newest = version
  }
  return newest
}

/** `SHA256SUMS` lines (`<hex>  <file>` or `<hex> *<file>`) as file → lowercase hex. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match) sums.set(match[2]!, match[1]!.toLowerCase())
  }
  return sums
}

/** Pages of 100 releases read before giving up; desktop releases share the list. */
export const RELEASE_PAGES = 5

/**
 * Ask GitHub for the newest server release. Releases are listed newest first,
 * so the first page holding any server release holds the newest one.
 */
export async function fetchNewestRelease(
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const base =
    env.OPENMANAGER_RELEASES_API ??
    `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`
  for (let page = 1; page <= RELEASE_PAGES; page++) {
    const url = new URL(base)
    url.searchParams.set('page', String(page))
    const response = await fetchImpl(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'openmanager-update' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(`GitHub answered ${response.status} when asked for the newest release.`)
    }
    const listing: unknown = await response.json()
    const version = newestRelease(listing)
    if (version) return version
    if (!Array.isArray(listing) || listing.length < 100) break
  }
  throw new Error('GitHub lists no published OpenManager server release yet.')
}
