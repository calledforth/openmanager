import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageParts } from './MessageParts'

describe('MessageParts', () => {
  it('shows generated-image timing and the resulting image', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          {
            type: 'tool',
            id: 'image-tool',
            tool: 'Generate Image',
            state: { status: 'completed' },
            time: { start: 1_000, end: 8_400 },
          },
          {
            type: 'image',
            id: 'generated-image',
            generated: true,
            name: 'concept.png',
            url: 'https://example.convex.cloud/api/storage/concept',
          },
        ]}
      />,
    )

    expect(html).toContain('Generated image')
    expect(html).toContain('in 7s')
    expect(html).toContain('src="https://example.convex.cloud/api/storage/concept"')
    expect(html).toContain('Preview concept.png')
  })

  it('keeps reasoning and the final answer visible side by side', () => {
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

    expect(html).toContain('Thought')
    expect(html).toContain('done')
  })

  it('leaves the summary rows visible once the turn ends', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          {
            type: 'tool',
            id: 'tool-1',
            tool: 'Read File',
            kind: 'read',
            state: { status: 'completed' },
          },
          {
            type: 'tool',
            id: 'tool-2',
            tool: 'Read File',
            kind: 'read',
            state: { status: 'completed' },
          },
          { type: 'text', id: 't1', text: 'Both files check out.' },
        ]}
        isStreaming={false}
      />,
    )

    expect(html).toContain('Explored 2 files')
    expect(html).toContain('Both files check out.')
    expect(html).not.toContain('step')
  })

  it('labels a settled thought with its duration once it passes a second', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          { type: 'reasoning', id: 'r1', text: 'considering', time: { start: 0, end: 2400 } },
        ]}
        isStreaming={false}
      />,
    )

    expect(html).toContain('Thought for 2s')
  })

  it('omits the duration for a sub-second thought', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[{ type: 'reasoning', id: 'r1', text: 'quick', time: { start: 0, end: 400 } }]}
        isStreaming={false}
      />,
    )

    expect(html).toContain('Thought')
    expect(html).not.toContain('Thought for')
  })

  it('renders a textless thought from its token estimate and duration', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[{ type: 'reasoning', id: 'r1', tokens: 1500, time: { start: 0, end: 2800 } }]}
        isStreaming={false}
      />,
    )

    expect(html).toContain('Thought for 3s')
    expect(html).toContain('~1.5k tokens')
    // Nothing to disclose, so no expandable transcript.
    expect(html).not.toContain('<details')
  })

  it('still renders reasoning parts persisted before tokens existed', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          { type: 'reasoning', id: 'r1', text: 'considering', time: { start: 0, end: 2400 } },
        ]}
        isStreaming={false}
      />,
    )

    expect(html).toContain('Thought for 2s')
    expect(html).toContain('considering')
    expect(html).not.toContain('tokens')
  })

  it('drops a reasoning part carrying neither text nor tokens', () => {
    const html = renderToStaticMarkup(
      <MessageParts parts={[{ type: 'reasoning', id: 'r1', time: { start: 0, end: 5 } }]} />,
    )

    expect(html).not.toContain('Thought')
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

  it('summarises a run of consecutive tool calls on one row', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          {
            type: 'tool',
            id: 'tool-1',
            tool: 'Edit',
            state: { status: 'completed', input: { path: 'a.ts' } },
          },
          {
            type: 'tool',
            id: 'tool-2',
            tool: 'Edit',
            state: { status: 'completed', input: { path: 'b.ts' } },
          },
          {
            type: 'tool',
            id: 'tool-3',
            tool: 'Bash',
            state: { status: 'completed', input: { command: 'pnpm test' } },
          },
        ]}
        isStreaming={false}
      />,
    )

    expect(html).toContain('Edited 2 files, ran 1 command')
  })

  it('splits a tool run around reasoning', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          { type: 'tool', id: 'tool-1', tool: 'Read', state: { status: 'completed', input: {} } },
          { type: 'tool', id: 'tool-2', tool: 'Read', state: { status: 'completed', input: {} } },
          { type: 'reasoning', id: 'r1', text: 'considering', time: { start: 1, end: 2 } },
          { type: 'tool', id: 'tool-3', tool: 'Bash', state: { status: 'completed', input: {} } },
          { type: 'tool', id: 'tool-4', tool: 'Bash', state: { status: 'completed', input: {} } },
        ]}
        isStreaming={false}
      />,
    )

    expect(html).toContain('Explored 2 files')
    expect(html).toContain('Ran 2 commands')
    expect(html).toContain('Thought')
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
