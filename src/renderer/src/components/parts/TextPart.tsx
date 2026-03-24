import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { cn } from '../../lib/utils'

const mdComponents: Components = {
  code({ className, children, ...props }) {
    const isInline = !className
    if (isInline) {
      return (
        <code
          className="bg-foreground/[0.06] dark:bg-foreground/[0.1] font-mono text-[85%] rounded px-[0.4em] py-[0.15em]"
          {...props}
        >
          {children}
        </code>
      )
    }
    const lang = className?.replace('language-', '') ?? ''
    return (
      <div className="my-2 rounded-lg overflow-hidden border border-border bg-card">
        {lang && (
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <span className="text-[11px] text-muted-foreground font-mono">{lang}</span>
          </div>
        )}
        <pre className="m-0 overflow-x-auto px-3 py-2.5 text-[12px] leading-relaxed">
          <code className="font-mono text-foreground/80" {...props}>
            {children}
          </code>
        </pre>
      </div>
    )
  },
  p({ children }) {
    return <p className="text-foreground my-px leading-relaxed py-[3px]">{children}</p>
  },
  ul({ children }) {
    return <ul className="my-1 pl-5 text-foreground leading-relaxed">{children}</ul>
  },
  ol({ children }) {
    return <ol className="my-1 pl-5 text-foreground leading-relaxed">{children}</ol>
  },
  li({ children }) {
    return <li className="my-0.5">{children}</li>
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 pl-3 border-l-[3px] border-border text-muted-foreground">
        {children}
      </blockquote>
    )
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto my-2">
        <table className="border-collapse w-full text-[12px]">{children}</table>
      </div>
    )
  },
  th({ children }) {
    return (
      <th className="border border-border px-2.5 py-1.5 bg-card text-left text-foreground/90 font-semibold text-[11px]">
        {children}
      </th>
    )
  },
  td({ children }) {
    return <td className="border border-border px-2.5 py-1.5 text-[12px]">{children}</td>
  },
  hr() {
    return <hr className="border-none border-t border-border my-3" />
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        className="text-primary no-underline hover:underline"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    )
  },
  h1({ children }) {
    return <h1 className="text-base font-semibold text-foreground mt-[1.4em] mb-1">{children}</h1>
  },
  h2({ children }) {
    return <h2 className="text-[15px] font-semibold text-foreground mt-[1.2em] mb-1">{children}</h2>
  },
  h3({ children }) {
    return <h3 className="text-[13px] font-semibold text-foreground mt-[1em] mb-1">{children}</h3>
  },
}

interface TextPartProps {
  text: string
  dimmed?: boolean
}

export function TextPart({ text, dimmed }: TextPartProps) {
  if (!text) return null
  return (
    <div className={cn('leading-relaxed', dimmed ? 'text-muted-foreground' : 'text-foreground')}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
