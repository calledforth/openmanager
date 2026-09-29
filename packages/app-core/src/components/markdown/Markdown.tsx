import { memo, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeExternalLinks from 'rehype-external-links'
import rehypeShikiFromHighlighter from '@shikijs/rehype/core'
import type { PluggableList } from 'unified'
import type { Element, ElementContent, Nodes, Root } from 'hast'
import { CheckIcon, CopyIcon, GithubLogoIcon, GlobeSimpleIcon } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { SHIKI_THEMES, useShikiHighlighter } from '../../lib/shiki'

/** Flattens a hast subtree back to source text — used for copy-to-clipboard. */
function hastText(node: unknown): string {
  const n = node as Nodes | undefined
  if (!n) return ''
  if (n.type === 'text') return n.value
  if ('children' in n && Array.isArray(n.children)) {
    return n.children.map(hastText).join('')
  }
  return ''
}

/**
 * Fence language for the header chip. `addLanguageClass` puts `language-x` on
 * the inner <code>; the plain-markdown path (highlighter still loading) puts it
 * there too, so one lookup covers both.
 */
function languageOf(node: unknown): string {
  const n = node as Nodes | undefined
  if (!n || !('children' in n) || !Array.isArray(n.children)) return ''
  for (const child of n.children) {
    if (child.type !== 'element') continue
    const raw: unknown = child.properties?.className
    const classes = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(' ') : []
    for (const entry of classes) {
      const value = String(entry)
      if (value.startsWith('language-')) {
        const lang = value.slice('language-'.length)
        return lang === 'plaintext' ? '' : lang
      }
    }
  }
  return ''
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : 'Copy code'}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        })
      }}
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded transition-colors',
        'text-[var(--basis-text-faint)] opacity-0 focus-visible:opacity-100 group-hover/code:opacity-100',
        'hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
      )}
    >
      {copied ? <CheckIcon size={11} weight="bold" /> : <CopyIcon size={11} />}
    </button>
  )
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, or an `rgb[a]()` / `hsl[a]()` call. */
const COLOR_VALUE = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?)\([^()]*\))$/i

/**
 * Colour values in running prose. Stricter than COLOR_VALUE because bare text
 * is noisy: 3/4-digit hex must contain a letter so `#123` (an issue ref) stays
 * plain, and the value can't be glued to a word, a URL fragment, or a hyphen.
 */
const PROSE_COLOR =
  /(?<![\w#&/-])(#(?:[0-9a-f]{6}(?:[0-9a-f]{2})?|(?=[0-9a-f]{0,3}[a-f])[0-9a-f]{3,4})|(?:rgba?|hsla?)\([^()\n]*\))(?![\w-])/gi

function swatchNode(color: string): ElementContent {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['md-swatch'], style: `background-color: ${color}`, ariaHidden: 'true' },
    children: [],
  }
}

/** Rehype plugin: puts a swatch before colour values in prose (code is handled by the `code` component). */
function rehypeColorSwatches() {
  const walk = (parent: Root | Element) => {
    const next: ElementContent[] = []
    let changed = false
    for (const child of parent.children as ElementContent[]) {
      if (child.type === 'element') {
        if (child.tagName !== 'code' && child.tagName !== 'pre') walk(child)
        next.push(child)
        continue
      }
      if (child.type !== 'text') {
        next.push(child)
        continue
      }
      let last = 0
      for (const match of child.value.matchAll(PROSE_COLOR)) {
        const start = match.index
        if (start > last) next.push({ type: 'text', value: child.value.slice(last, start) })
        next.push(swatchNode(match[0]), { type: 'text', value: match[0] })
        last = start + match[0].length
        changed = true
      }
      if (last === 0) next.push(child)
      else if (last < child.value.length) next.push({ type: 'text', value: child.value.slice(last) })
    }
    if (changed) parent.children = next
  }
  return (tree: Root) => walk(tree)
}

/** Parses an http(s) href; anything else (mailto:, relative, anchors) stays a plain link. */
function webUrl(href: unknown): URL | null {
  if (typeof href !== 'string') return null
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function isGitHub(url: URL): boolean {
  return url.hostname === 'github.com' || url.hostname === 'www.github.com'
}

/** Top-level github.com pages that aren't an owner. */
const GITHUB_RESERVED = new Set([
  'about', 'enterprise', 'explore', 'features', 'login', 'marketplace', 'new',
  'notifications', 'orgs', 'pricing', 'pulls', 'issues', 'search', 'settings',
  'sponsors', 'topics', 'trending',
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

function isLinear(url: URL): boolean {
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
function urlHeading(url: URL): string {
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

/** Linear's mark as a glyph: its favicon is a dark tile that disappears on dark themes. */
function LinearLogo() {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="currentColor"
      className="md-link-icon md-link-icon-linear"
      aria-hidden="true"
    >
      <path d="M1.225 61.523c-.222-.949.908-1.546 1.597-.857l36.512 36.512c.689.689.092 1.819-.857 1.597C20.052 94.452 5.548 79.949 1.225 61.523ZM.002 46.889a.99.99 0 0 0 .29.761L52.35 99.709a.99.99 0 0 0 .761.29c2.369-.148 4.694-.46 6.962-.926.765-.157 1.03-1.096.478-1.648L2.576 39.449c-.552-.552-1.491-.286-1.648.478A51.5 51.5 0 0 0 .002 46.889ZM4.211 29.705a.99.99 0 0 0 .208 1.1l64.776 64.776a.99.99 0 0 0 1.1.208 50 50 0 0 0 5.185-2.684c.552-.328.638-1.087.184-1.541L8.436 24.337c-.454-.454-1.213-.369-1.541.183a50 50 0 0 0-2.684 5.185ZM12.659 18.074c-.37-.37-.393-.964-.044-1.354C21.78 6.459 35.111 0 49.952 0 77.593 0 100 22.407 100 50.048c0 14.841-6.459 28.172-16.72 37.338-.39.348-.984.326-1.354-.045L12.659 18.074Z" />
    </svg>
  )
}

/** Site favicon, falling back to a globe glyph when the icon can't load. */
function Favicon({ url }: { url: URL }) {
  const [failed, setFailed] = useState(false)
  // GitHub's favicon is black-on-transparent and vanishes on dark; the glyph
  // follows the text colour instead.
  if (isGitHub(url)) {
    return <GithubLogoIcon weight="fill" className="md-link-icon md-link-icon-github" aria-hidden="true" />
  }
  if (isLinear(url)) return <LinearLogo />
  if (failed) return <GlobeSimpleIcon className="md-link-icon" aria-hidden="true" />
  return (
    <img
      className="md-link-icon"
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=32`}
      alt=""
      aria-hidden="true"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

/**
 * Only elements that need React live here. Everything typographic — margins,
 * list markers, rules, table rhythm — is one CSS block on `.md` in globals.css.
 * Adding element styling here re-creates the two-layer split this replaced.
 */
const components: Components = {
  // rehype-shiki has already produced the highlighted <pre>; this wraps it in
  // chrome (language tag + copy) without touching the token markup inside.
  pre({ children, node, className, ...props }) {
    const code = hastText(node)
    const lang = languageOf(node)
    return (
      <div className="md-code group/code">
        <div className="md-code-bar">
          <span className="md-code-lang">{lang}</span>
          <CopyButton value={code} />
        </div>
        <pre className={className} {...props}>
          {children}
        </pre>
      </div>
    )
  },
  // GFM task lists: replace the raw browser checkbox with a themed one.
  input({ type, checked, ...props }) {
    if (type !== 'checkbox') return <input type={type} {...props} />
    return (
      <span className={cn('md-check', checked && 'md-check-on')} aria-hidden="true">
        {checked ? <CheckIcon size={9} weight="bold" /> : null}
      </span>
    )
  },
  // Scroll container, so the table itself can stay a real full-width table.
  table({ node: _node, ...props }) {
    return (
      <div className="md-table">
        <table {...props} />
      </div>
    )
  },
  // Inline code that is exactly a colour value gets a swatch (GitHub-style).
  // Block code never matches: shiki emits element children, and the plain
  // path's text carries a trailing newline the anchored pattern rejects.
  code({ node: _node, children, ...props }) {
    const color = typeof children === 'string' && COLOR_VALUE.test(children) ? children : null
    return (
      <code {...props}>
        {color ? (
          <span className="md-swatch" style={{ backgroundColor: color }} aria-hidden="true" />
        ) : null}
        {children}
      </code>
    )
  },
  // Web links render as a chip: favicon + heading. Bare URLs (autolinks,
  // where the text is the href itself) get a readable host/path heading.
  a({ node: _node, href, children, ...props }) {
    const url = webUrl(href)
    if (!url)
      return (
        <a href={href} {...props}>
          {children}
        </a>
      )
    const bare =
      typeof children === 'string' && children.replace(/\/+$/, '') === href?.replace(/\/+$/, '')
    return (
      <a href={href} title={href} {...props} className="md-link">
        <Favicon url={url} />
        <span className="md-link-text">{bare ? urlHeading(url) : children}</span>
      </a>
    )
  },
  img({ src, alt }) {
    return <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} loading="lazy" />
  },
}

export type MarkdownProps = {
  children: string
  className?: string
  /** Renders muted — used for superseded/streaming-dimmed turns. */
  dimmed?: boolean
}

/**
 * The single markdown renderer for the app. Everything that displays model or
 * plan output goes through this so chat, plan panel, and any future surface
 * stay identical.
 */
export const Markdown = memo(function Markdown({ children, className, dimmed }: MarkdownProps) {
  const highlighter = useShikiHighlighter()

  const rehypePlugins = useMemo<PluggableList>(() => {
    const plugins: PluggableList = [
      [rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }],
      rehypeColorSwatches,
    ]
    if (highlighter) {
      plugins.push([
        rehypeShikiFromHighlighter,
        highlighter,
        {
          themes: SHIKI_THEMES,
          // Emits --shiki-light / --shiki-dark custom properties instead of a
          // baked color, so one render serves both themes (see globals.css).
          defaultColor: false,
          addLanguageClass: true,
          fallbackLanguage: 'plaintext',
          onError: () => {},
        },
      ])
    }
    return plugins
  }, [highlighter])

  if (!children) return null

  return (
    <div className={cn('md', dimmed && 'md-dimmed', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
})
