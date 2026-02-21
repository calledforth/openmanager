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
          style={{
            background: '#2a2a2a',
            borderRadius: '3px',
            padding: '1px 4px',
            fontSize: '0.9em',
            fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
          }}
          {...props}
        >
          {children}
        </code>
      )
    }
    const lang = className?.replace('language-', '') ?? ''
    return (
      <div style={{ margin: '8px 0', borderRadius: '6px', overflow: 'hidden', border: '1px solid #2a2a2a' }}>
        {lang && (
          <div style={{ background: '#1a1a1a', padding: '4px 12px', fontSize: '11px', color: '#666', borderBottom: '1px solid #2a2a2a' }}>
            {lang}
          </div>
        )}
        <pre style={{ margin: 0, padding: '12px', background: '#111', overflowX: 'auto', fontSize: '13px', lineHeight: 1.5 }}>
          <code
            style={{ fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace', color: '#d4d4d4' }}
            className={className}
            {...props}
          >
            {children}
          </code>
        </pre>
      </div>
    )
  },
  p({ children }) {
    return <p style={{ margin: '4px 0', lineHeight: 1.6 }}>{children}</p>
  },
  ul({ children }) {
    return <ul style={{ margin: '4px 0', paddingLeft: '20px' }}>{children}</ul>
  },
  ol({ children }) {
    return <ol style={{ margin: '4px 0', paddingLeft: '20px' }}>{children}</ol>
  },
  li({ children }) {
    return <li style={{ margin: '2px 0' }}>{children}</li>
  },
  blockquote({ children }) {
    return (
      <blockquote style={{ margin: '8px 0', paddingLeft: '12px', borderLeft: '3px solid #333', color: '#999' }}>
        {children}
      </blockquote>
    )
  },
  table({ children }) {
    return (
      <div style={{ overflowX: 'auto', margin: '8px 0' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '13px' }}>{children}</table>
      </div>
    )
  },
  th({ children }) {
    return <th style={{ border: '1px solid #333', padding: '6px 10px', background: '#1a1a1a', textAlign: 'left' }}>{children}</th>
  },
  td({ children }) {
    return <td style={{ border: '1px solid #2a2a2a', padding: '6px 10px' }}>{children}</td>
  },
  hr() {
    return <hr style={{ border: 'none', borderTop: '1px solid #2a2a2a', margin: '12px 0' }} />
  },
  a({ href, children }) {
    return <a href={href} style={{ color: '#60a5fa', textDecoration: 'none' }} target="_blank" rel="noopener noreferrer">{children}</a>
  },
  h1({ children }) {
    return <h1 style={{ fontSize: '1.4em', fontWeight: 600, margin: '12px 0 4px', color: '#e0e0e0' }}>{children}</h1>
  },
  h2({ children }) {
    return <h2 style={{ fontSize: '1.2em', fontWeight: 600, margin: '10px 0 4px', color: '#e0e0e0' }}>{children}</h2>
  },
  h3({ children }) {
    return <h3 style={{ fontSize: '1.05em', fontWeight: 600, margin: '8px 0 4px', color: '#e0e0e0' }}>{children}</h3>
  },
}

interface TextPartProps {
  text: string
  dimmed?: boolean
}

export function TextPart({ text, dimmed }: TextPartProps) {
  if (!text) return null
  return (
    <div className={cn('text-sm leading-relaxed', dimmed ? 'text-muted-foreground' : 'text-foreground')}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
