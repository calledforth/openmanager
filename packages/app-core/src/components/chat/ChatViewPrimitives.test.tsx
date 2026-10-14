import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AssistantMessage,
  assistantCopyText,
  ChatLoadingSkeleton,
  UserMessage,
} from './ChatViewPrimitives'

describe('chat loading skeletons', () => {
  it('announces the conversation loading state once', () => {
    const html = renderToStaticMarkup(<ChatLoadingSkeleton />)

    expect(html).toContain('aria-label="Loading conversation"')
    expect(html.match(/role="status"/g)).toHaveLength(1)
    expect(html).not.toContain('Send a message to start')
  })

  it('centers the session busy loader while hydrating', () => {
    const html = renderToStaticMarkup(<ChatLoadingSkeleton />)

    expect(html).toContain('aria-label="Session in progress"')
    expect(html).toContain('session-busy-ring')
    expect(html).not.toContain('chat-skeleton')
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

  it('renders a user message as markdown, like assistant prose', () => {
    const html = renderToStaticMarkup(
      <UserMessage content={'Fix **this** in `app.ts`:\n\n- first\n- second'} />,
    )

    expect(html).toContain('class="md"')
    expect(html).toContain('<strong>this</strong>')
    expect(html).toContain('<code>app.ts</code>')
    expect(html).toContain('<li>first</li>')
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

describe('assistant copy button', () => {
  it('offers a copy button once the reply has settled', () => {
    const html = renderToStaticMarkup(<AssistantMessage content="All done." isFinal />)

    expect(html).toContain('aria-label="Copy message"')
    expect(html).toContain('group/assistant')
  })

  it('hides the copy button while the reply is streaming', () => {
    const html = renderToStaticMarkup(<AssistantMessage content="All do" isFinal={false} />)

    expect(html).not.toContain('aria-label="Copy message"')
  })

  it('hides the copy button when a settled turn has no answer text', () => {
    const html = renderToStaticMarkup(
      <AssistantMessage
        content=""
        isFinal
        parts={[
          {
            type: 'tool',
            id: 'tool-1',
            tool: 'Read',
            state: { status: 'completed', input: { path: 'a.ts' } },
          },
        ]}
      />,
    )

    expect(html).not.toContain('aria-label="Copy message"')
  })

  it('keeps the user copy button', () => {
    const html = renderToStaticMarkup(<UserMessage content="hello" />)

    expect(html).toContain('aria-label="Copy message"')
    expect(html).toContain('group-hover/user:opacity-100')
  })
})

describe('assistant copy text', () => {
  const read = {
    type: 'tool',
    id: 'tool-1',
    tool: 'Read',
    state: { status: 'completed', input: { path: 'a.ts' } },
  }

  it('copies only the answer below collapsed work', () => {
    const parts = [
      { type: 'text', id: 'note', text: 'Let me look at the file.' },
      read,
      { type: 'text', id: 'final', text: 'Everything checks out.' },
    ]

    expect(assistantCopyText('', true, parts)).toBe('Everything checks out.')
  })

  it('skips reasoning and hidden text, which fold into the work above the answer', () => {
    const parts = [
      { type: 'reasoning', id: 'r', text: 'thinking about it' },
      { type: 'text', id: 'b', text: 'injected', synthetic: true },
      { type: 'text', id: 'c', text: 'ignored', ignored: true },
      { type: 'text', id: 'd', text: 'The answer.\n' },
    ]

    expect(assistantCopyText('', true, parts)).toBe('The answer.')
  })

  it('joins every paragraph of the answer', () => {
    const parts = [
      { type: 'text', id: 'a', text: 'First paragraph.' },
      { type: 'text', id: 'b', text: 'Second paragraph.\n' },
    ]

    expect(assistantCopyText('', true, parts)).toBe('First paragraph.\n\nSecond paragraph.')
  })

  it('falls back to content when the reply has no parts', () => {
    expect(assistantCopyText('  Plain reply.\n', true, undefined)).toBe('Plain reply.')
  })

  it('copies nothing while the reply streams', () => {
    expect(assistantCopyText('Partial', false, undefined)).toBe('')
  })
})
