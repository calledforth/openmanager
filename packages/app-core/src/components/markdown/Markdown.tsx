import { memo, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeExternalLinks from 'rehype-external-links'
import rehypeShikiFromHighlighter from '@shikijs/rehype/core'
import type { PluggableList } from 'unified'
import type { Element, ElementContent, Nodes, Root } from 'hast'
import { CheckIcon, CopyIcon } from '@phosphor-icons/react'
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
