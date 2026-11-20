import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  bareLinkHeading,
  linkRuns,
  LINKIFY_OPTIONS,
  plainTextOf,
  type LinkifyIt,
} from '../src/components/parts/link-text'

const require = createRequire(import.meta.url)
const library = dirname(require.resolve('react-native-markdown-display/package.json'))
const MarkdownIt = createRequire(`${library}/package.json`)('markdown-it') as (
  options: object,
) => { linkify: LinkifyIt }
// As TextPart makes it.
const markdownIt = MarkdownIt({ typographer: true, linkify: true })
markdownIt.linkify.set(LINKIFY_OPTIONS)

interface Node {
  type: string
  content?: string
  attributes?: { href?: string }
  children: Node[]
}
// The library's own parser, as TextPart runs it on the phone (its index pulls in React Native).
const PARSER = 'react-native-markdown-display/src/lib/parser'
const parser = (
  (await import(PARSER)) as {
    default: (source: string, render: (nodes: Node[]) => Node[], it: unknown) => Node[]
  }
).default

/** Each link in the markdown as the transcript draws it: its heading, else its own words. */
function linksOf(markdown: string): { href: string; reads: string | null }[] {
  const found: { href: string; reads: string | null }[] = []
  const walk = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.type === 'link') {
        const href = node.attributes?.href ?? ''
        found.push({ href, reads: bareLinkHeading(href, plainTextOf(node)) ?? plainTextOf(node) })
      }
      walk(node.children)
    }
  }
  walk(parser(markdown, (nodes) => nodes, markdownIt))
  return found
}

describe('a reply’s links', () => {
  it('reads a bare URL by its short heading, as web does', () => {
    expect(linksOf('See https://github.com/acme/app/pull/12 for it.')).toEqual([
      { href: 'https://github.com/acme/app/pull/12', reads: 'acme/app/pull/12' },
    ])
    expect(linksOf('Docs: https://www.example.com/guide/')).toEqual([
      { href: 'https://www.example.com/guide/', reads: 'example.com/guide' },
    ])
  })

  it('keeps a written link’s own words', () => {
    expect(linksOf('The [release notes](https://example.com/notes) say so.')).toEqual([
      { href: 'https://example.com/notes', reads: 'release notes' },
    ])
  })

  it('leaves file names and code alone', () => {
    expect(linksOf('Edit README.md and notes.md, or `https://in.code`.')).toEqual([])
  })
})

describe('a prompt’s links', () => {
  it('finds links with a scheme, and only those', () => {
    expect(linkRuns('open https://a.dev/x, or README.md', markdownIt.linkify)).toEqual([
      { text: 'open ' },
      { text: 'https://a.dev/x', url: 'https://a.dev/x' },
      { text: ', or README.md' },
    ])
    expect(linkRuns('nothing here', markdownIt.linkify)).toEqual([{ text: 'nothing here' }])
  })
})
