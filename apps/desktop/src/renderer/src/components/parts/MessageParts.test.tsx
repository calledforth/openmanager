import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageParts } from './MessageParts'

describe('MessageParts', () => {
  it('keeps reasoning visible in collapsed steps when final text exists', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          {
            type: 'reasoning',
            id: 'r1',
            text: 'thinking',
            time: { start: 1, end: 2 },
          },
          {
            type: 'text',
            id: 't1',
            text: 'done',
          },
        ]}
        isStreaming={false}
      />,
    )

    expect(html).toContain('1 step')
  })

  it('renders Cursor structured tool output without passing objects to React', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          {
            type: 'tool',
            id: 'tool-1',
            tool: 'Shell',
            state: {
              status: 'completed',
              input: { command: 'git status --short' },
              output: {
                output: 'working tree clean',
                metadata: { exitCode: 0 },
              },
            },
          },
        ]}
      />,
    )

    expect(html).toContain('working tree clean')
    expect(html).not.toContain('exitCode')
  })

  it('renders non-envelope structured OpenCode output as readable JSON', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          {
            type: 'tool',
            id: 'tool-2',
            tool: 'custom-tool',
            state: {
              status: 'completed',
              output: { files: ['one.ts', 'two.ts'], count: 2 },
            },
          },
        ]}
      />,
    )

    expect(html).toContain('&quot;files&quot;')
    expect(html).toContain('one.ts')
  })
})
