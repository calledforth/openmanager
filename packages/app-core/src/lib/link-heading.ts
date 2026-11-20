/**
 * How a link in a reply reads: an http(s) href's short heading
 * (`github.com/org/repo` → `org/repo`, a Linear issue's id and title, else
 * host and path), and whether its host may go to the public favicon service.
 * Pure, shared by web's markdown and the phone's.
 */

/** Parses an http(s) href; anything else (mailto:, relative, anchors) stays a plain link. */
export function webUrl(href: unknown): URL | null {
  if (typeof href !== 'string') return null
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

export function isGitHub(url: URL): boolean {
  return url.hostname === 'github.com' || url.hostname === 'www.github.com'
}

/** Top-level github.com pages that aren't an owner. */
const GITHUB_RESERVED = new Set([
  'about',
  'enterprise',
  'explore',
  'features',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'pricing',
  'pulls',
  'issues',
  'search',
  'settings',
  'sponsors',
  'topics',
  'trending',
])

/**
 * Short GitHub headings: `owner/repo`, `owner/repo/pull/123` (and issues,
 * discussions), `owner/repo/commit/abc1234`, `owner/repo/path` for files.
 * Null when the URL isn't a repo-shaped page.
 */
function gitHubHeading(url: URL): string | null {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponentSafe)
  const [owner, name, kind, id, ...rest] = parts
  if (!owner || GITHUB_RESERVED.has(owner)) return null
  if (!name) return owner
  const repo = `${owner}/${name.replace(/\.git$/, '')}`
  if ((kind === 'pull' || kind === 'issues' || kind === 'discussions') && id && /^\d+$/.test(id)) {
    return `${repo}/${kind}/${id}`
  }
  if (kind === 'commit' && id) return `${repo}/commit/${id.slice(0, 7)}`
  if ((kind === 'blob' || kind === 'tree') && rest.length > 0) return `${repo}/${rest.join('/')}`
  return repo
}

export function isLinear(url: URL): boolean {
  return url.hostname === 'linear.app' || url.hostname === 'www.linear.app'
}

/** `fix-the-login-bug` -> `Fix the login bug`. */
function unslug(slug: string): string {
  const text = slug.replace(/[-_]+/g, ' ').trim()
  return text ? text[0]!.toUpperCase() + text.slice(1) : ''
}

/**
 * Short Linear headings: `CAL-123 Issue title` for issues (title from the URL
 * slug), the name for projects/documents/initiatives (their trailing hex id
 * dropped), `Team CAL` for team pages. Null when nothing readable is in the URL.
 */
function linearHeading(url: URL): string | null {
  const [, kind, id, slug] = url.pathname.split('/').filter(Boolean).map(decodeURIComponentSafe)
  if (!kind || !id) return null
  if (kind === 'issue') {
    const title = slug ? unslug(slug) : ''
    return title ? `${id.toUpperCase()} ${title}` : id.toUpperCase()
  }
  if (kind === 'project' || kind === 'document' || kind === 'initiative' || kind === 'view') {
    return unslug(id.replace(/-?[0-9a-f]{8,}$/i, '')) || null
  }
  if (kind === 'team') return `Team ${id.toUpperCase()}`
  return null
}

/** Readable heading for a bare URL: `github.com/org/repo` instead of the raw href. */
export function urlHeading(url: URL): string {
  const heading = isGitHub(url) ? gitHubHeading(url) : isLinear(url) ? linearHeading(url) : null
  if (heading) return heading
  const host = url.hostname.replace(/^www\./, '')
  const path = decodeURIComponentSafe(url.pathname).replace(/\/+$/, '')
  return path ? `${host}${path}` : host
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Suffixes that only resolve on a private network, plus the reserved test ones. */
const PRIVATE_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.private',
  '.test',
  '.example',
  '.invalid',
]

/** Whether a link's host may go to the public favicon service. Rendering a
 * reply must not tell a third party about an intranet host, a bare machine
 * name or an IP address the agent happened to mention; those get the globe. */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host.includes('.')) return false
  if (host.startsWith('[') || /^[\d.]+$/.test(host)) return false
  return !PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
}
