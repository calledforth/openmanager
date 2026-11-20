import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { presentToolPart } from '@openmanager/shared/lib/tool-presenter'
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

  it.each([
    ['cancelled', 'Image generation cancelled'],
    ['declined', 'Image generation declined'],
    ['error', 'Failed'],
  ])('never claims an image when the call ended %s', (status, line) => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          {
            type: 'tool',
            id: 'image-tool',
            tool: 'Generate Image',
            state: { status },
            time: { start: 1_000, end: 8_400 },
          },
        ]}
      />,
    )
    expect(html).toContain(line)
    expect(html).not.toContain('Generated image')
  })

  it('shows a failed generation as a row that opens on its error', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          {
            type: 'tool',
            id: 'image-tool',
            tool: 'imageGeneration',
            toolName: 'imageGeneration',
            state: { status: 'error', output: 'The image generation limit was reached.' },
          },
        ]}
      />,
    )
    expect(html).toContain('Generate')
    expect(html).toContain('Failed')
    expect(html).not.toContain('Generated image')
  })

  it('keeps a waiting question on the plain row, never as skipped', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          {
            type: 'tool',
            id: 'question',
            tool: 'AskUserQuestion',
            state: { status: 'running', input: { questions: [{ question: 'Which?' }] } },
          },
        ]}
      />,
    )
    expect(html).toContain('Asking')
    expect(html).not.toContain('Skipped')
  })

  it('reads Cursor structured tool output as text, never as an object', () => {
    const model = presentToolPart({
      tool: 'Shell',
      state: {
        status: 'completed',
        input: { command: 'git status --short' },
        output: { output: 'working tree clean', metadata: { exitCode: 0 } },
      },
    })

    expect(model.expandedText).toBe('working tree clean')
  })

  it('keeps a visible label for a Bash call without command input', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          { type: 'tool', id: 'tool-empty-bash', tool: 'Bash', state: { status: 'running' } },
        ]}
        isStreaming
      />,
    )

    expect(html).toContain('Running')
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

  it('folds a thought into the tool run it sits in, in its place', () => {
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

    // One group: the thought neither splits the run nor joins its summary.
    expect(html).toContain('Explored 2 files, ran 2 commands')
    expect(html.match(/data-activity-group=/g)).toHaveLength(1)
    // Opened, it reads in order: the reads, the thought, the commands.
    const body = html.slice(html.indexOf('data-activity-group-body'))
    expect(body.indexOf('Thought')).toBeGreaterThan(body.indexOf('Read'))
    expect(body.indexOf('Thought')).toBeLessThan(body.indexOf('Ran'))
  })

  it('hangs a thought in progress under its group, and only it shimmers', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          { type: 'tool', id: 'tool-1', tool: 'Bash', state: { status: 'completed', input: {} } },
          { type: 'reasoning', id: 'r1', text: 'weighing the options' },
        ]}
        isStreaming
      />,
    )

    expect(html).toContain('Ran 1 command')
    const branch = html.slice(html.indexOf('data-tree-branch'))
    expect(branch).toContain('Thinking')
    expect(branch).toContain('weighing the options')
    // The header does not shimmer; the thought does.
    const header = html.slice(0, html.indexOf('data-activity-group-body'))
    expect(header).not.toContain('basis-tool-shimmer')
    expect(branch).toContain('basis-tool-shimmer')
  })

  it('reads a thought the work has moved past as had', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          { type: 'reasoning', id: 'r1', text: 'first' },
          { type: 'tool', id: 'tool-1', tool: 'Bash', state: { status: 'completed', input: {} } },
        ]}
        isStreaming
      />,
    )

    expect(html).not.toContain('data-tree-branch')
    expect(html).not.toContain('Thinking')
    expect(html).toContain('Thought')
  })

  it('shows a thought with no calls around it as its own row', () => {
    const html = renderToStaticMarkup(
      <MessageParts
        parts={[
          { type: 'reasoning', id: 'r1', text: 'just thinking', time: { start: 1, end: 2 } },
          { type: 'text', id: 'answer', text: 'Answer.' },
        ]}
        isStreaming={false}
      />,
    )

    expect(html).not.toContain('data-activity-group=')
    expect(html).toContain('Thought')
    expect(html).toContain('Answer.')
  })

  it('renders non-envelope structured OpenCode output as readable JSON', () => {
    const model = presentToolPart({
      tool: 'custom-tool',
      state: { status: 'completed', output: { files: ['one.ts', 'two.ts'], count: 2 } },
    })

    expect(model.expandedText).toContain('"files"')
    expect(model.expandedText).toContain('one.ts')
  })
})
