import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatLoadingSkeleton, MessageLoadingSkeleton, UserMessage } from './ChatViewPrimitives'

describe('chat loading skeletons', () => {
  it('announces the conversation loading state once', () => {
    const html = renderToStaticMarkup(<ChatLoadingSkeleton />)

    expect(html).toContain('aria-label="Loading conversation"')
    expect(html.match(/role="status"/g)).toHaveLength(1)
    expect(html).not.toContain('Send a message to start')
  })

  it('renders a message placeholder without the user message shell', () => {
    const html = renderToStaticMarkup(<MessageLoadingSkeleton role="user" />)

    expect(html).toContain('aria-label="Loading message"')
    expect(html).toContain('chat-skeleton')
    expect(html).not.toContain('ReferenceComposerToolbar')
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
