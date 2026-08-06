import { memo, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeExternalLinks from 'rehype-external-links'
import rehypeShikiFromHighlighter from '@shikijs/rehype/core'
import type { PluggableList } from 'unified'
import type { Nodes } from 'hast'
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
