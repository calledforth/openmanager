import { typographyMonoCaption, typographyMonoCaptionTiny } from '../../lib/typography'
import { cn } from '../../lib/utils'

export function TerminalPanel({
  command,
  output,
  isError,
}: {
  command: string
  output?: string
  isError?: boolean
}) {
  return (
    <div className="overflow-hidden rounded-md border border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)]">
      <div
        className={cn(
          'flex items-center gap-1.5 border-b border-[var(--basis-border-muted)] bg-[var(--basis-surface)] px-2 py-1',
          typographyMonoCaptionTiny,
          'text-[var(--basis-text-faint)]',
        )}
      >
        <span className="flex gap-1" aria-hidden>
          <span className="size-1.5 rounded-full bg-[var(--basis-border-strong)]" />
          <span className="size-1.5 rounded-full bg-[var(--basis-border-strong)]" />
          <span className="size-1.5 rounded-full bg-[var(--basis-border-strong)]" />
        </span>
        <span className="ml-0.5">bash</span>
      </div>
      <div className="custom-scrollbar max-h-[300px] overflow-y-auto px-2 py-1.5">
        {command && (
          <div className="flex items-start gap-1.5">
            <span className={cn('shrink-0', typographyMonoCaption, 'text-emerald-500/70')}>$</span>
            <code
              className={cn(
                'break-all whitespace-pre-wrap',
                typographyMonoCaption,
                'text-[var(--basis-text)]',
              )}
            >
              {command}
            </code>
          </div>
        )}
        {output && (
          <pre
            className={cn(
              'm-0 mt-1 whitespace-pre-wrap break-words',
              typographyMonoCaption,
              isError ? 'text-rose-400/90' : 'text-[var(--basis-text-muted)]',
            )}
          >
            {output}
          </pre>
        )}
      </div>
    </div>
  )
}
