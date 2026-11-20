/**
 * How the transcript's links read, as web's do: a bare URL (its text the
 * href itself) by its short heading (`github.com/org/repo` → `org/repo`),
 * a written link by its own words. Pure, so the tests read it.
 */
import { urlHeading, webUrl } from '@openmanager/app-core/lib/link-heading'

/** Bare URLs become links only with a scheme (`https://…`, an email): `README.md` stays text. */
export const LINKIFY_OPTIONS = { fuzzyLink: false } as const

/** What markdown-it's own URL finder offers; its type declarations leave it out. */
export interface LinkifyIt {
  set(options: { fuzzyLink?: boolean }): void
  match(text: string): { index: number; lastIndex: number; url: string; raw: string }[] | null
}

/** The shape of a parsed markdown node this reads. */
interface LinkNode {
  type: string
  content?: string
  children: LinkNode[]
}

/** What a link's text says: its one run of plain text, if that is all it is. */
export function plainTextOf(node: LinkNode): string | null {
  const [only, ...rest] = node.children
  if (!only || rest.length > 0) return null
  if (only.type === 'text') return only.content ?? null
  return only.type === 'textgroup' ? plainTextOf(only) : null
}

const withoutSlash = (url: string) => url.replace(/\/+$/, '')

/** A bare web URL's heading; null for a link with words of its own (or not http(s)). */
export function bareLinkHeading(href: string, text: string | null): string | null {
  const url = webUrl(href)
  if (!url || text === null || withoutSlash(text) !== withoutSlash(href)) return null
  return urlHeading(url)
}

/** Plain text's runs: its words, and the links in them. */
export function linkRuns(text: string, linkify: LinkifyIt): { text: string; url?: string }[] {
  const matches = linkify.match(text)
  if (!matches) return [{ text }]
  const runs: { text: string; url?: string }[] = []
  let last = 0
  for (const match of matches) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index) })
    runs.push({ text: match.raw, url: match.url })
    last = match.lastIndex
  }
  if (last < text.length) runs.push({ text: text.slice(last) })
  return runs
}
