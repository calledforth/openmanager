import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import {
  createMarkdownScanner,
  keyByPlace,
  MIN_BLOCK_CHARS,
} from '../src/components/parts/markdown-blocks'

// The parser the phone draws with, which is the library's own dependency.
const require = createRequire(import.meta.url)
const fromLibrary = createRequire(require.resolve('react-native-markdown-display/package.json'))
const MarkdownIt = fromLibrary('markdown-it') as new () => {
  parse(
    markdown: string,
    env: object,
  ): { type: string; tag: string; level: number; content: string }[]
}

const blocksOf = (text: string) => {
  const { closed, tail } = createMarkdownScanner(0).read(text)
  return [...closed, tail]
}

/** What a text parses to, without source positions, so split and whole compare. */
const shape = (markdown: string) =>
  new MarkdownIt()
    .parse(markdown, {})
    .filter((token) => token.level === 0 || token.type === 'inline')
    .map((token) => `${token.type}:${token.type === 'inline' ? token.content : token.tag}`)

const samples: Record<string, string> = {
  prose: '# Title\n\nFirst paragraph.\nSame paragraph.\n\nSecond paragraph.\n',
  fence: 'Before.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nAfter.\n',
  tildes: '~~~\n```\n\nstill code\n~~~\n\nAfter.\n',
  longFence: '````\n```\n\nnot closed by three\n````\n\nAfter.\n',
  looseList: '- one\n\n- two\n\n- three\n\nAfter.\n',
  ordered: '1. one\n\n2. two\n\n3. three\n',
  nested: '- one\n\n  still one\n\n      code in one\n\n- two\n\nAfter.\n',
  quote: '> a\n> b\n\nAfter.\n',
  table: 'Before.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.\n',
  indented: 'Before.\n\n    code\n\n    more code\n\nAfter.\n',
  rule: 'Before.\n\n---\n\nAfter.\n',
}

describe('markdown node keys', () => {
  it('names each node by its place, the same on every parse', () => {
    const parsed = () => [
      { key: `rnmr_${Math.random()}`, children: [{ key: 'b', children: [] }] },
      { key: 'c', children: [] },
    ]
    const keys = (nodes: ReturnType<typeof parsed>) =>
      nodes.flatMap((node) => [node.key, ...node.children.map((child) => child.key)])
    expect(keys(keyByPlace(parsed()))).toEqual(['0', '0.0', '1'])
    expect(keys(keyByPlace(parsed()))).toEqual(['0', '0.0', '1'])
  })
})

describe('markdown blocks', () => {
  it('parses to what the whole text parses to', () => {
    for (const [name, text] of Object.entries(samples)) {
      expect(blocksOf(text).flatMap(shape), name).toEqual(shape(text))
    }
  })

  it('loses no text', () => {
    for (const [name, text] of Object.entries(samples)) {
      const squeezed = (value: string) => value.replace(/\s+/g, '')
      expect(squeezed(blocksOf(text).join('')), name).toBe(squeezed(text))
    }
  })

  it('keeps short blocks together, and parses the same at any size', () => {
    const paragraph = `${'word '.repeat(Math.ceil(MIN_BLOCK_CHARS / 5))}\n\n`
    const { closed } = createMarkdownScanner().read(
      `Short.\n\nAlso short.\n\n${paragraph}Next.\n\nEnd.\n`,
    )
    expect(closed).toHaveLength(1)
    for (const [name, text] of Object.entries(samples)) {
      const { closed: blocks, tail } = createMarkdownScanner(20).read(text)
      expect([...blocks, tail].flatMap(shape), name).toEqual(shape(text))
    }
  })

  it('does not split a list on an item after a paragraph that led into it', () => {
    expect(blocksOf('Lead in:\n- one\n\n- two\n')).toEqual(['Lead in:\n- one\n\n- two\n'])
  })

  it('cuts a reply at its blocks', () => {
    expect(blocksOf('One.\n\nTwo.\n\nThree.\n')).toEqual(['One.', 'Two.', 'Three.\n'])
  })

  it('never cuts inside a fence, closed or not', () => {
    expect(blocksOf('```\na\n\nb')).toEqual(['```\na\n\nb'])
    expect(blocksOf('```\na\n\nb\n```\n\nNext.\n')).toEqual(['```\na\n\nb\n```', 'Next.\n'])
  })

  it('leaves a text that defines a reference link whole', () => {
    const text = 'See [the docs][1].\n\nMore.\n\n[1]: https://example.test\n'
    expect(blocksOf(text)).toEqual([text])
  })

  it('reads a growing text to the same blocks as the finished one', () => {
    for (const [name, text] of Object.entries(samples)) {
      const scanner = createMarkdownScanner(0)
      let last = scanner.read('')
      for (let end = 1; end <= text.length; end += 3) last = scanner.read(text.slice(0, end))
      last = scanner.read(text)
      expect([...last.closed, last.tail], name).toEqual(blocksOf(text))
    }
  })

  it('sees a reference on a last line with no newline', () => {
    const text = 'See [the docs][1].\n\nMore.\n\n[1]: https://example.test'
    expect(blocksOf(text)).toEqual([text])
  })

  it('is not fooled by a reference-like last line inside a fence', () => {
    expect(blocksOf('Before.\n\n```\n[1]: https://example.test')).toEqual([
      'Before.',
      '```\n[1]: https://example.test',
    ])
  })

  it('reads a fence in a text with CRLF line ends', () => {
    expect(blocksOf('```ts\r\na\r\n\r\nb\r\n```\r\n\r\nNext.\r\n')).toEqual([
      '```ts\r\na\r\n\r\nb\r\n```',
      'Next.\r\n',
    ])
  })

  it('hands back the same finished blocks until one more finishes', () => {
    const scanner = createMarkdownScanner(0)
    const first = scanner.read('One.\n\nTwo\n')
    const second = scanner.read('One.\n\nTwo\nmore')
    expect(second.closed).toBe(first.closed)
    expect(second.tail).toBe('Two\nmore')
    expect(scanner.read('One.\n\nTwo\nmore.\n\nThree\n').closed).toHaveLength(2)
  })

  it('starts over when a text is replaced rather than extended', () => {
    const scanner = createMarkdownScanner(0)
    scanner.read('One.\n\nTwo.\n\nThree\n')
    const replaced = scanner.read('Other.\n\nText\n')
    expect([...replaced.closed, replaced.tail]).toEqual(['Other.', 'Text\n'])
  })
})
