import { Markdown } from '../markdown/Markdown'

interface TextPartProps {
  text: string
  dimmed?: boolean
}

/**
 * Assistant/plan prose. All rendering and styling lives in <Markdown>; this
 * stays only as the timeline's part-level entry point.
 *
 * Markdown itself is memoized — parsing plus highlighting is the most expensive
 * render work in the timeline, and during streaming only the growing part's
 * text changes, so every other part must skip the re-parse.
 */
export function TextPart({ text, dimmed }: TextPartProps) {
  if (!text) return null
  return <Markdown dimmed={dimmed}>{text}</Markdown>
}
