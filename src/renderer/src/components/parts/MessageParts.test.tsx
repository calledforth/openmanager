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
})
