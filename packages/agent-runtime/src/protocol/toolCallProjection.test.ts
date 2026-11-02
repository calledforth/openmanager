import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentpack/contract'
import type { ToolCallState, ToolCallUpdate } from '@openmanager/protocol'
import { applyToolUpdate } from '@openmanager/protocol'
import { projectAgentEvent, ToolCallTracker } from './projectAgentEvent.js'

const base = {
  version: 1,
  provider: 'p',
  agentId: 'a',
  sessionId: 's',
  timestamp: '2026-11-01T00:00:00.000Z',
}

function harness() {
  const tracker = new ToolCallTracker()
  const updates: ToolCallUpdate[] = []
  let state: ToolCallState | undefined
  const feed = (event: 'tool_call' | 'tool_call_update', data: Record<string, unknown>) => {
    const projected = projectAgentEvent(
      {
        ...base,
        category: 'tool',
        event,
        data: { toolCallId: 'p-1', ...data },
      } as unknown as AgentEvent,
      {
        eventId: `event-${updates.length}`,
        environmentId: 'e',
        workspaceId: 'w',
        sessionId: 's',
        threadId: 't',
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        toolCalls: tracker,
      },
    )
    if (projected?.name !== 'tool.updated') throw new Error('expected a tool event')
    updates.push(projected.payload)
    state = applyToolUpdate(state, projected.payload)
    return projected.payload
  }
  return { feed, updates, tracker, state: () => state! }
}

const wire = (updates: unknown) => JSON.stringify(updates)

describe('what a settled call sends', () => {
  it('keeps a Bash result off the wire and states its size', () => {
    const { feed, tracker } = harness()
    feed('tool_call', { title: 'Bash', toolName: 'Bash', kind: 'execute', status: 'pending' })
    feed('tool_call_update', { status: 'in_progress', rawInput: { command: 'ls' } })
    const settled = feed('tool_call_update', { status: 'completed', rawOutput: 'héllo\n' })
    expect(settled).toMatchObject({ status: 'completed', outputBytes: 7 })
    expect(settled.output).toBeUndefined()
    expect(tracker.takeBody('tool-1')).toBe('héllo\n')
    expect(tracker.takeBody('tool-1')).toBeUndefined()
  })

  it('has no limit on what it stores', () => {
    const { feed, tracker } = harness()
    feed('tool_call', { title: 'Bash', toolName: 'Bash', kind: 'execute' })
    const text = 'x'.repeat(3_000_000)
    feed('tool_call_update', { status: 'completed', rawOutput: text })
    expect(tracker.takeBody('tool-1')).toHaveLength(3_000_000)
  })
})

describe('paths only', () => {
  it('carries no Read output, keeps the path and says nothing of the file', () => {
    const { feed, tracker, updates, state } = harness()
    feed('tool_call', { title: 'Read', toolName: 'Read', kind: 'read' })
    feed('tool_call_update', {
      status: 'in_progress',
      rawInput: { file_path: '/repo/a.ts' },
      locations: [{ path: '/repo/a.ts' }],
    })
    feed('tool_call_update', { status: 'completed', rawOutput: 'SECRET FILE' })
    expect(wire(updates)).not.toContain('SECRET FILE')
    expect(tracker.takeBody('tool-1')).toBeUndefined()
    expect(state().locations).toEqual([{ path: '/repo/a.ts' }])
    expect(state().outputBytes).toBeUndefined()
  })

  it('keeps the error of a failed Read, one line of it', () => {
    const { feed, tracker } = harness()
    feed('tool_call', { title: 'Read', toolName: 'Read', kind: 'read' })
    feed('tool_call_update', {
      status: 'failed',
      rawOutput: '<tool_use_error>File does not exist.\nSECOND LINE</tool_use_error>',
    })
    expect(tracker.takeBody('tool-1')).toBe('File does not exist.')
  })

  it('strips edit bodies from input and results, and keeps paths and counts (A11)', () => {
    const { feed, tracker, updates, state } = harness()
    feed('tool_call', { title: 'Edit', toolName: 'Edit', kind: 'edit' })
    feed('tool_call_update', {
      status: 'in_progress',
      rawInput: { file_path: '/repo/a.ts', old_string: 'OLD BODY', new_string: 'NEW BODY' },
    })
    feed('tool_call_update', {
      status: 'completed',
      rawOutput: 'The file was updated.\n1\tNEW BODY',
      lineChanges: { added: 2, removed: 1 },
    })
    expect(wire(updates)).not.toMatch(/OLD BODY|NEW BODY/)
    expect(tracker.takeBody('tool-1')).toBeUndefined()
    expect(state()).toMatchObject({
      input: { file_path: '/repo/a.ts' },
      lineChanges: { added: 2, removed: 1 },
    })
  })

  it('never lets a failed edit quote what it tried to write (A11)', () => {
    const { feed, tracker } = harness()
    feed('tool_call', { title: 'Edit', toolName: 'Edit', kind: 'edit' })
    feed('tool_call_update', {
      status: 'failed',
      rawOutput:
        '<tool_use_error>String to replace not found in file.\nString: OLD BODY</tool_use_error>',
    })
    expect(tracker.takeBody('tool-1')).toBe('String to replace not found in file.')
  })

  it('never carries a notebook cell quoted in a failure (A11)', () => {
    const { feed, tracker } = harness()
    feed('tool_call', { title: 'NotebookEdit', toolName: 'NotebookEdit', kind: 'edit' })
    feed('tool_call_update', { status: 'failed', rawOutput: 'Updated cell c1 with SECRET SOURCE' })
    expect(tracker.takeBody('tool-1')).toBe('Updated cell c1')
  })

  it('recognises an edit on an update that names no kind (A17)', () => {
    const { feed, updates } = harness()
    feed('tool_call', { title: 'Write', toolName: 'Write' })
    feed('tool_call_update', { status: 'in_progress', rawInput: { path: 'a', content: 'BODY' } })
    expect(wire(updates)).not.toContain('BODY')
  })

  it('keeps a listing, which names files rather than holding one', () => {
    const { feed, tracker } = harness()
    feed('tool_call', { title: 'list', kind: 'read' })
    feed('tool_call_update', { status: 'completed', rawOutput: { output: 'a.ts\nb.ts' } })
    expect(tracker.takeBody('tool-1')).toBe('a.ts\nb.ts')
  })
})

describe('OpenCode', () => {
  it('strips apply_patch patchText from any tool (A1)', () => {
    const { feed, updates } = harness()
    feed('tool_call', { title: 'apply_patch', kind: 'edit' })
    feed('tool_call_update', { status: 'in_progress', rawInput: { patchText: 'PATCH BODY' } })
    expect(wire(updates)).not.toContain('PATCH BODY')
  })

  it('reads output and error from a report, never its metadata (A2)', () => {
    const { feed, tracker } = harness()
    feed('tool_call', { title: 'bash', kind: 'execute' })
    feed('tool_call_update', {
      status: 'completed',
      rawOutput: { output: 'done', metadata: { diff: 'DIFF BODY' } },
    })
    expect(tracker.takeBody('tool-1')).toBe('done')
    const failed = harness()
    failed.feed('tool_call', { title: 'bash', kind: 'execute' })
    failed.feed('tool_call_update', { status: 'failed', rawOutput: { error: 'boom' } })
    expect(failed.tracker.takeBody('tool-1')).toBe('boom')
  })

  it('takes the first title as the name and keeps it when prose replaces the title', () => {
    const { feed, state } = harness()
    feed('tool_call', { title: 'task', kind: 'think', status: 'pending', rawInput: {} })
    feed('tool_call_update', { title: 'Summarize folder structure', status: 'in_progress' })
    expect(state()).toMatchObject({ toolName: 'task', title: 'Summarize folder structure' })
  })
})

describe('Cursor', () => {
  it('reads a shell result from stdout and stderr', () => {
    const { feed, tracker } = harness()
    feed('tool_call', { title: '`ls`', kind: 'execute', rawInput: { command: 'ls' } })
    feed('tool_call_update', {
      status: 'completed',
      rawOutput: { exitCode: 1, stdout: 'out\n', stderr: 'err\n' },
    })
    expect(tracker.takeBody('tool-1')).toBe('out\n\nerr\n')
  })

  it('reports a search as its count', () => {
    const { feed, tracker } = harness()
    feed('tool_call', { title: 'grep', kind: 'search', rawInput: {} })
    feed('tool_call_update', {
      status: 'completed',
      rawOutput: { totalMatches: 11, truncated: false },
    })
    expect(tracker.takeBody('tool-1')).toBe('11 matches')
  })

  it('takes a failure from the report, which says completed', () => {
    const { feed, tracker, state } = harness()
    feed('tool_call', { title: 'Find', kind: 'search', rawInput: {} })
    feed('tool_call_update', { status: 'completed', rawOutput: { error: 'no such directory' } })
    expect(state().status).toBe('failed')
    expect(tracker.takeBody('tool-1')).toBe('no such directory')
  })

  it('takes a refusal from the report', () => {
    const { feed, state } = harness()
    feed('tool_call', { title: 'Web Fetch: https://a.example', kind: 'fetch' })
    feed('tool_call_update', { status: 'completed', rawOutput: { rejected: true, reason: 'no' } })
    expect(state().status).toBe('declined')
  })

  it('gets an edit path from the diff, and never the diff', () => {
    const { feed, updates, state } = harness()
    feed('tool_call', { title: 'Edit File', kind: 'edit', rawInput: {} })
    feed('tool_call_update', {
      status: 'completed',
      content: [{ type: 'diff', path: 'C:/repo/a.md', oldText: 'OLD BODY', newText: 'NEW BODY' }],
    })
    expect(state().locations).toEqual([{ path: 'C:/repo/a.md' }])
    expect(wire(updates)).not.toMatch(/OLD BODY|NEW BODY/)
  })

  it('takes the name from its marker and leaves the marker out of the input', () => {
    const { feed, state } = harness()
    feed('tool_call', {
      title: 'Update TODOs',
      kind: 'other',
      rawInput: { _toolName: 'updateTodos', todos: [] },
    })
    expect(state()).toMatchObject({ toolName: 'updateTodos', input: { todos: [] } })
  })

  it('carries no Read content from a report', () => {
    const { feed, tracker } = harness()
    feed('tool_call', { title: 'Read File', kind: 'read', rawInput: {} })
    feed('tool_call_update', { status: 'completed', rawOutput: { content: 'FILE BODY' } })
    expect(tracker.takeBody('tool-1')).toBeUndefined()
  })
})

describe('running text', () => {
  it('turns a resend that extends into a delta', () => {
    const { feed, tracker } = harness()
    feed('tool_call', { title: 'bash', kind: 'execute' })
    const text = (value: string) => [{ type: 'content', content: { type: 'text', text: value } }]
    expect(feed('tool_call_update', { status: 'in_progress', content: text('one') }).output).toBe(
      'one',
    )
    const next = feed('tool_call_update', { status: 'in_progress', content: text('one two') })
    expect(next.outputDelta).toBe(' two')
    expect(next.output).toBeUndefined()
    expect(tracker.outputBytes('tool-1')).toBe(7)
  })

  it('replaces when the provider rewrites what it sent', () => {
    const { feed } = harness()
    feed('tool_call', { title: 'bash', kind: 'execute' })
    const text = (value: string) => [{ type: 'content', content: { type: 'text', text: value } }]
    feed('tool_call_update', { status: 'in_progress', content: text('long progress text') })
    expect(feed('tool_call_update', { status: 'in_progress', content: text('short') }).output).toBe(
      'short',
    )
  })

  it('keeps counting what ran when the call settles with no text of its own', () => {
    const { feed, tracker } = harness()
    feed('tool_call', { title: 'bash', kind: 'execute' })
    const text = [{ type: 'content', content: { type: 'text', text: 'ran' } }]
    feed('tool_call_update', { status: 'in_progress', content: text })
    const settled = feed('tool_call_update', { status: 'completed', content: [] })
    expect(settled.outputBytes).toBe(3)
    expect(tracker.takeBody('tool-1')).toBeUndefined()
  })
})

describe('a resend that only extends text', () => {
  const text = (value: string) => [{ type: 'content', content: { type: 'text', text: value } }]

  it('is a bare delta, whatever ACP repeats on it', () => {
    const { feed } = harness()
    feed('tool_call', {
      title: 'bash',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'ls' },
    })
    const repeated = {
      title: 'bash',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'ls' },
    }
    feed('tool_call_update', { ...repeated, content: text('one') })
    expect(feed('tool_call_update', { ...repeated, content: text('one two') })).toEqual({
      toolCallId: 'tool-1',
      turnId: 'turn-1',
      outputDelta: ' two',
    })
  })

  it('keeps a field that changed', () => {
    const { feed } = harness()
    feed('tool_call', { title: 'bash', kind: 'execute', status: 'in_progress' })
    feed('tool_call_update', { status: 'in_progress', content: text('one') })
    expect(
      feed('tool_call_update', {
        status: 'in_progress',
        title: 'Runs it',
        content: text('one two'),
      }),
    ).toEqual({ toolCallId: 'tool-1', turnId: 'turn-1', title: 'Runs it', outputDelta: ' two' })
  })
})

describe('text after a call settled', () => {
  const text = (value: string) => [{ type: 'content', content: { type: 'text', text: value } }]

  it('sends none, on a resend or an append', () => {
    const { feed, tracker, updates } = harness()
    feed('tool_call', { title: 'bash', kind: 'execute' })
    feed('tool_call_update', { status: 'completed', rawOutput: 'final' })
    expect(tracker.takeBody('tool-1')).toBe('final')
    const late = feed('tool_call_update', {
      status: 'in_progress',
      content: text('final and more'),
    })
    expect(late.output).toBeUndefined()
    expect(late.outputDelta).toBeUndefined()
    expect(tracker.append('tool-1', ' more')).toEqual({})
    expect(tracker.outputBytes('tool-1')).toBe(5)
    expect(wire(updates)).not.toContain('and more')
  })

  it('sends none after a refusal either', () => {
    const { feed, tracker } = harness()
    feed('tool_call', { title: 'Bash', toolName: 'Bash', kind: 'execute' })
    tracker.decline('tool-1')
    const late = feed('tool_call_update', { status: 'in_progress', content: text('late') })
    expect(late.output).toBeUndefined()
    expect(tracker.outputBytes('tool-1')).toBe(0)
  })
})

describe('outcomes', () => {
  it('reads a failure after a refusal as declined', () => {
    const { feed, tracker, state } = harness()
    feed('tool_call', { title: 'Bash', toolName: 'Bash', kind: 'execute' })
    expect(tracker.decline('tool-1')).toBe(true)
    feed('tool_call_update', { status: 'failed' })
    expect(state().status).toBe('declined')
  })

  it('has nothing to say for a refusal of a call with no row', () => {
    expect(new ToolCallTracker().decline('web_search_0')).toBe(false)
  })

  it('uses what the provider says went wrong, only when a call did not complete', () => {
    const { feed, state } = harness()
    feed('tool_call', { title: 'Bash', toolName: 'Bash', kind: 'execute' })
    feed('tool_call_update', { status: 'failed', outcome: 'cancelled' })
    expect(state().status).toBe('cancelled')
  })
})
