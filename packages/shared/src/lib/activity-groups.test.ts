import { describe, expect, it } from 'vitest'
import { groupActivityParts, type ActivityNode } from './activity-groups'

interface TestPart {
  type: string
  id: string
  tool?: string
  kind?: string
  callID?: string
  state?: { status?: string; input?: unknown; output?: unknown }
  text?: string
}

const tool = (id: string, name: string, extra: Partial<TestPart> = {}): TestPart => ({
  type: 'tool',
  id,
  tool: name,
  state: { status: 'completed', input: {}, ...extra.state },
  ...extra,
})

const groups = (nodes: ActivityNode<TestPart>[]) => nodes.filter((node) => node.kind === 'group')

const summaries = (nodes: ActivityNode<TestPart>[]) =>
  groups(nodes).map((node) => (node.kind === 'group' ? node.summary.text : ''))

describe('groupActivityParts', () => {
  it('folds a run of tools into one group with per-category counts', () => {
    const nodes = groupActivityParts([
      tool('1', 'Edit', { state: { status: 'completed', input: { path: 'a.ts' } } }),
      tool('2', 'Edit', { state: { status: 'completed', input: { path: 'b.ts' } } }),
      tool('3', 'Read'),
      tool('4', 'Grep'),
      tool('5', 'Bash'),
    ])

    expect(nodes).toHaveLength(1)
    expect(summaries(nodes)).toEqual(['Edited 2 files, explored 1 file, 1 search, ran 1 command'])
  })

  it('keeps thinking on its own row and splits the surrounding tools', () => {
    const nodes = groupActivityParts([
      tool('1', 'Edit'),
      tool('2', 'Write'),
      { type: 'reasoning', id: 'r1', text: 'considering' },
      tool('3', 'Read'),
      tool('4', 'Read'),
    ])

    expect(nodes.map((node) => node.kind)).toEqual(['group', 'part', 'group'])
    expect(summaries(nodes)).toEqual(['Edited 2 files', 'Explored 2 files'])
  })

  it('leaves assistant text as a barrier', () => {
    const nodes = groupActivityParts([
      tool('1', 'Bash'),
      tool('2', 'Bash'),
      { type: 'text', id: 't1', text: 'done' },
    ])

    expect(nodes.map((node) => node.kind)).toEqual(['group', 'part'])
  })

  it('summarises from the very first tool so a live turn starts grouped', () => {
    const nodes = groupActivityParts([tool('1', 'Read')])

    expect(nodes.map((node) => node.kind)).toEqual(['group'])
    expect(summaries(nodes)).toEqual(['Explored 1 file'])
  })

  it('rewrites the one summary line as the run grows', () => {
    const run = [tool('1', 'Edit'), tool('2', 'Edit'), tool('3', 'Bash')]

    expect(summaries(groupActivityParts(run.slice(0, 1)))).toEqual(['Edited 1 file'])
    expect(summaries(groupActivityParts(run.slice(0, 2)))).toEqual(['Edited 2 files'])
    expect(summaries(groupActivityParts(run))).toEqual(['Edited 2 files, ran 1 command'])
  })

  it('honours a custom minimum group size', () => {
    const parts = [tool('1', 'Read'), tool('2', 'Read')]

    expect(groupActivityParts(parts, { minGroupSize: 3 }).map((node) => node.kind)).toEqual([
      'part',
      'part',
    ])
  })

  it('breaks a failed tool out of the group so the error stays visible', () => {
    const nodes = groupActivityParts([
      tool('1', 'Read'),
      tool('2', 'Bash', { state: { status: 'error' } }),
      tool('3', 'Read'),
      tool('4', 'Read'),
    ])

    expect(nodes.map((node) => node.kind)).toEqual(['group', 'part', 'group'])
    expect(summaries(nodes)).toEqual(['Explored 1 file', 'Explored 2 files'])
  })

  it('breaks out the tool call awaiting permission', () => {
    const nodes = groupActivityParts(
      [
        tool('1', 'Bash', { callID: 'call-1' }),
        tool('2', 'Bash', { callID: 'call-2' }),
        tool('3', 'Bash', { callID: 'call-3' }),
      ],
      { pendingPermissionCallId: 'call-2' },
    )

    expect(nodes.map((node) => node.kind)).toEqual(['group', 'part', 'group'])
  })

  it('keeps tools with standalone meaning ungrouped', () => {
    const nodes = groupActivityParts([
      tool('1', 'Read'),
      tool('2', 'TodoWrite'),
      tool('3', 'Task'),
      tool('4', 'Read'),
    ])

    expect(nodes.map((node) => node.kind)).toEqual(['group', 'part', 'part', 'group'])
  })

  it('categorises by ACP kind when the tool carries a provider title', () => {
    const nodes = groupActivityParts([
      tool('1', 'Read File', { kind: 'read' }),
      tool('2', 'Read File', { kind: 'read' }),
      tool('3', 'Edit File', { kind: 'edit' }),
      tool('4', 'Delete File', { kind: 'delete' }),
      tool('5', 'Searched files', { kind: 'search' }),
      tool('6', 'Run Terminal Command', { kind: 'execute' }),
    ])

    expect(summaries(nodes)).toEqual(['Edited 2 files, explored 2 files, 1 search, ran 1 command'])
  })

  it('falls back to the generic bucket for an unknown tool with no kind', () => {
    const nodes = groupActivityParts([tool('1', 'Mystery'), tool('2', 'Mystery')])

    expect(summaries(nodes)).toEqual(['Used 2 tools'])
  })

  it('sums diff stats across edits in the group', () => {
    const nodes = groupActivityParts([
      tool('1', 'Edit File', {
        kind: 'edit',
        state: { status: 'completed', input: { path: 'a.ts' }, output: '+ one\n- two\n' },
      }),
      tool('2', 'Edit', {
        state: { status: 'completed', input: { path: 'b.ts' }, output: '+ three\n+ four\n' },
      }),
    ])

    const [group] = groups(nodes)
    expect(group?.kind === 'group' && group.summary.diffAdded).toBe(3)
    expect(group?.kind === 'group' && group.summary.diffRemoved).toBe(1)
  })

  it('marks the group running and uses present tense while a member is in flight', () => {
    const nodes = groupActivityParts([
      tool('1', 'Edit'),
      tool('2', 'Edit', { state: { status: 'running' } }),
    ])

    const [group] = groups(nodes)
    expect(group?.kind === 'group' && group.summary.isRunning).toBe(true)
    expect(group?.kind === 'group' && group.summary.runningText).toBe('Editing 2 files')
  })

  it('keeps the group id anchored to the first member as the run grows', () => {
    const first = groupActivityParts([tool('1', 'Read'), tool('2', 'Read')])
    const grown = groupActivityParts([tool('1', 'Read'), tool('2', 'Read'), tool('3', 'Read')])

    expect(first[0]?.kind === 'group' && first[0].id).toBe('activity:1')
    expect(grown[0]?.kind === 'group' && grown[0].id).toBe('activity:1')
  })
})
