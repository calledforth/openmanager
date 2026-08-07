import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantMessage, ChatLoadingSkeleton, UserMessage } from './ChatViewPrimitives'

describe('chat loading skeletons', () => {
  it('announces the conversation loading state once', () => {
    const html = renderToStaticMarkup(<ChatLoadingSkeleton />)

    expect(html).toContain('aria-label="Loading conversation"')
    expect(html.match(/role="status"/g)).toHaveLength(1)
    expect(html).not.toContain('Send a message to start')
  })

  it('keeps all placeholder shapes inside the single session-loading status', () => {
    const html = renderToStaticMarkup(<ChatLoadingSkeleton />)

    expect(html.match(/role="status"/g)).toHaveLength(1)
    expect(html).not.toContain('Loading message')
  })

  it('renders persisted images as in-app preview buttons', () => {
    const html = renderToStaticMarkup(
      <UserMessage
        content="What is in this image?"
        parts={[
          {
            id: 'image-1',
            type: 'image',
            url: 'https://example.convex.cloud/api/storage/image-1',
            name: 'image.png',
          },
        ]}
      />,
    )

    expect(html).toContain('src="https://example.convex.cloud/api/storage/image-1"')
    expect(html).toContain('aria-label="Preview image.png"')
    expect(html).not.toContain('target="_blank"')
  })
})

describe('assistant turn work disclosure', () => {
  const mixedParts = [
    {
      type: 'tool',
      id: 'tool-1',
      tool: 'Read',
      state: { status: 'completed', input: { path: 'src/index.ts' } },
    },
    { type: 'text', id: 'final', text: 'Everything checks out.' },
  ]

  it('collapses settled work while leaving the final answer below it', () => {
    const html = renderToStaticMarkup(
      <AssistantMessage
        content="Everything checks out."
        isFinal
        parts={mixedParts}
        runtime={{ startedAt: 1_000, completedAt: 46_000, finishReason: 'end_turn' }}
      />,
    )

    expect(html).toContain('data-turn-work-group')
    expect(html).toContain('Worked for 45s')
    expect(html).toContain('Everything checks out.')
    expect(html.indexOf('Everything checks out.')).toBeGreaterThan(html.lastIndexOf('</details>'))
    expect(html).toContain('class="mt-0.5" data-turn-work-group-body="true"')
  })

  it('does not collapse a turn until it is final', () => {
    const html = renderToStaticMarkup(
      <AssistantMessage content="" isFinal={false} parts={mixedParts} />,
    )

    expect(html).not.toContain('data-turn-work-group')
    expect(html).toContain('Everything checks out.')
  })

  it('uses the stopped label for cancelled settled turns', () => {
    const html = renderToStaticMarkup(
      <AssistantMessage
        content=""
        isFinal
        parts={mixedParts}
        runtime={{ finishReason: 'cancelled' }}
      />,
    )

    expect(html).toContain('>Stopped</span>')
    expect(html).not.toContain('Worked')
  })
})
