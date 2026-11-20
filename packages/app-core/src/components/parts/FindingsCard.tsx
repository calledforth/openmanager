import { ListChecksIcon } from '@phosphor-icons/react'
import { Markdown } from '../markdown/Markdown'

/**
 * What a code review found (`/review`): the review turn's answer, on a card of
 * its own under the review's "finished" marker, so it reads as the review's
 * result rather than as the agent talking.
 */
export function FindingsCard({ text }: { text: string }) {
  if (!text) return null
  return (
    <section
      data-review-findings
      aria-label="Review findings"
      className="my-1.5 overflow-hidden rounded-[10px] bg-[var(--basis-surface)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--basis-text)_4%,transparent)]"
    >
      <header className="flex items-center gap-1.5 border-b border-[var(--basis-border)] px-3 py-1.5 text-ui-sm text-[var(--basis-text-muted)]">
        <ListChecksIcon size={13} aria-hidden className="shrink-0" />
        <span>Findings</span>
      </header>
      <div className="px-3.5 py-2.5">
        <Markdown>{text}</Markdown>
      </div>
    </section>
  )
}
