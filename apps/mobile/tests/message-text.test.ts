import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MessagePart } from '@openmanager/app-core/logic'

import {
  messageRuns,
  messageTargetOf,
  runsText,
  type MarkdownNode,
} from '../src/session/message-text'

const require = createRequire(import.meta.url)
const library = dirname(require.resolve('react-native-markdown-display/package.json'))
const MarkdownIt = createRequire(`${library}/package.json`)('markdown-it') as (
  options: object,
) => unknown
const markdownIt = MarkdownIt({ typographer: true })

type Parse = (
  source: string,
  render: (nodes: MarkdownNode[]) => MarkdownNode[],
  it: unknown,
) => MarkdownNode[]
// The library's own parser, as TextPart runs it on the phone (its index pulls in React Native).
const PARSER = 'react-native-markdown-display/src/lib/parser'
const parser = ((await import(PARSER)) as { default: Parse }).default
const parse = (text: string) => parser(text, (nodes) => nodes, markdownIt)
const read = (text: string) => runsText(messageRuns(parse(text)))

describe('messageRuns', () => {
  it('reads a reply as one text, paragraphs apart, with no markdown marks', () => {
    expect(read('First **bold** and *soft* words.\n\nSecond with `code`.')).toBe(
      'First bold and soft words.\n\nSecond with code.',
    )
  })

  it('marks what the transcript styles', () => {
    const runs = messageRuns(parse('# Title\n\nSome **bold** and `x`.'))
    expect(runs).toEqual([
      { text: 'Title', marks: { heading: 1 } },
      { text: '\n\nSome ', marks: {} },
      { text: 'bold', marks: { strong: true } },
      { text: ' and ', marks: {} },
      { text: 'x', marks: { code: true } },
      { text: '.', marks: {} },
    ])
  })

  it('lists items one to a line, with their markers and nested lists indented', () => {
    expect(read('Steps:\n\n1. one\n2. two\n   - deeper\n3. three')).toBe(
      'Steps:\n\n1.  one\n2.  two\n    •  deeper\n3.  three',
    )
    expect(read('5. five\n6. six')).toBe('5.  five\n6.  six')
  })

  it('keeps code as written', () => {
    const runs = messageRuns(parse('Run:\n\n```ts\nconst a = 1\n  return a\n```\n\nDone.'))
    expect(runsText(runs)).toBe('Run:\n\nconst a = 1\n  return a\n\nDone.')
    expect(runs.find((run) => run.marks.codeBlock)?.text).toBe('const a = 1\n  return a')
  })

  it('reads a table a row to a line', () => {
    expect(read('| a | b |\n| - | - |\n| 1 | 2 |')).toBe('a  |  b\n1  |  2')
  })

  it('keeps quotes, links and line breaks', () => {
    expect(read('> quoted\n\nSee [the docs](https://x.test).\nNext line.')).toBe(
      'quoted\n\nSee the docs.\nNext line.',
    )
  })
})

describe('messageTargetOf', () => {
  const text = (value: string): MessagePart =>
    ({ id: value, type: 'text', text: value }) as unknown as MessagePart

  it('copies a prompt as typed', () => {
    expect(messageTargetOf({ role: 'user', content: '  hello\n', isFinal: true })).toEqual({
      kind: 'user',
      text: 'hello',
    })
  })

  it('copies a settled reply as web does, and nothing while it streams', () => {
    const parts = [text('First.'), text('Second.')]
    expect(messageTargetOf({ role: 'assistant', content: '', isFinal: true, parts })).toEqual({
      kind: 'assistant',
      text: 'First.\n\nSecond.',
    })
    expect(messageTargetOf({ role: 'assistant', content: 'Part', isFinal: false })).toBeNull()
    expect(messageTargetOf({ role: 'user', content: '  ', isFinal: true })).toBeNull()
  })
})
