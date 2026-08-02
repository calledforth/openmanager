import { describe, expect, it } from 'vitest'
import { canonicalizeToolName, getToolLabels } from '@openmanager/shared/lib/tool-meta'
import {
  claudeToolContentFromInput,
  claudeToolKind,
  claudeToolLocations,
  claudeToolTitle,
  planUpdateFromTodoWrite,
  subtaskFromClaudeTool,
} from './claude-tools.js'

describe('claudeToolKind', () => {
  it('classifies the built-ins the UI has affordances for', () => {
    expect(
      ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task'].map(
        claudeToolKind,
      ),
    ).toEqual([
      'read',
      'search',
      'search',
      'execute',
      'edit',
      'edit',
      'edit',
      'edit',
      'fetch',
      'fetch',
      'think',
      'other',
    ])
  })

  it('leaves anything it does not know as other', () => {
    // A wrong kind puts a shell command behind a read icon; a neutral one only
    // costs an icon.
    expect(claudeToolKind('mcp__github__create_issue')).toBe('other')
    expect(claudeToolKind('SomeFutureTool')).toBe('other')
  })
})

describe('claudeToolTitle', () => {
  it('produces the key the presenter actually looks tools up by', () => {
    // `convex-projector` and the renderer both set `part.tool = tool.title`, and
    // `presentToolPart` then canonicalizes that value and reads the label
    // registry with it. A pre-rendered sentence misses every entry.
    for (const name of ['Read', 'Bash', 'Edit', 'TodoWrite', 'Task']) {
      const title = claudeToolTitle(name)
      expect(canonicalizeToolName(title)).toBe(name)
    }
    // And the registry then builds the human title from the rawInput we ship.
    expect(getToolLabels(claudeToolTitle('Read')).getTitle({ file_path: 'C:/a/b.ts' })).toBe(
      'Read b.ts',
    )
  })
})

describe('claudeToolContentFromInput', () => {
  it('emits a diff for an Edit, whose input carries both halves', () => {
    expect(
      claudeToolContentFromInput('Edit', {
        file_path: 'C:/a.ts',
        old_string: 'const a = 1',
        new_string: 'const a = 2',
      }),
    ).toEqual([{ type: 'diff', path: 'C:/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }])
  })

  it('emits one diff per MultiEdit edit rather than one merged patch', () => {
    // Edit N's old_string refers to the text after edits 1..N-1, so each pair is
    // individually truthful and a concatenation would not be.
    expect(
      claudeToolContentFromInput('MultiEdit', {
        file_path: 'C:/a.ts',
        edits: [
          { old_string: 'one', new_string: 'two' },
          { old_string: 'two', new_string: 'three' },
        ],
      }),
    ).toEqual([
      { type: 'diff', path: 'C:/a.ts', oldText: 'one', newText: 'two' },
      { type: 'diff', path: 'C:/a.ts', oldText: 'two', newText: 'three' },
    ])
  })

  it('never claims to know what a Write overwrote', () => {
    const content = claudeToolContentFromInput('Write', {
      file_path: 'C:/a.ts',
      content: 'whole file',
    })
    // `oldText: null` asserts "this file did not exist", which is a lie whenever
    // it did — and Write overwrites as readily as it creates.
    expect(content).toEqual([{ type: 'content', content: { type: 'text', text: 'whole file' } }])
  })

  it('presents a notebook cell as content, having no before-image', () => {
    expect(
      claudeToolContentFromInput('NotebookEdit', {
        notebook_path: 'C:/a.ipynb',
        new_source: 'print(1)',
      }),
    ).toEqual([{ type: 'content', content: { type: 'text', text: 'print(1)' } }])
  })

  it('produces nothing for a tool with no renderable input', () => {
    expect(claudeToolContentFromInput('Bash', { command: 'ls' })).toBeUndefined()
    expect(claudeToolContentFromInput('Edit', { file_path: 'C:/a.ts' })).toBeUndefined()
  })
})

describe('claudeToolLocations', () => {
  it('reports the file a tool names, under any of its keys', () => {
    expect(claudeToolLocations({ file_path: 'C:/a.ts' })).toEqual([{ path: 'C:/a.ts' }])
    expect(claudeToolLocations({ notebook_path: 'C:/a.ipynb' })).toEqual([{ path: 'C:/a.ipynb' }])
    expect(claudeToolLocations({ command: 'ls' })).toBeUndefined()
  })
})

describe('planUpdateFromTodoWrite', () => {
  it('maps a todo list to plan entries', () => {
    expect(
      planUpdateFromTodoWrite({
        todos: [
          { content: 'A', status: 'pending', activeForm: 'Doing A' },
          { content: 'B', status: 'weird', activeForm: 'Doing B' },
        ],
      }),
    ).toEqual({
      entries: [
        { content: 'A', priority: 'medium', status: 'pending' },
        // An unknown status is pending, never invented as done.
        { content: 'B', priority: 'medium', status: 'pending' },
      ],
    })
  })

  it('refuses to publish an empty plan over a real one', () => {
    // A partial input must not blank the user's visible checklist.
    expect(planUpdateFromTodoWrite({})).toBeUndefined()
    expect(planUpdateFromTodoWrite({ todos: 'not an array' })).toBeUndefined()
  })
})

describe('subtaskFromClaudeTool', () => {
  it('claims a Task call and pulls its metadata out of the input', () => {
    expect(
      subtaskFromClaudeTool(
        {
          toolCallId: 'toolu_1',
          title: 'Task',
          status: 'pending',
          rawInput: { description: 'Find it', prompt: 'go', subagent_type: 'Explore' },
        },
        { phase: 'call', tracked: false },
      ),
    ).toEqual({
      taskId: 'toolu_1',
      title: 'Task',
      description: 'Find it',
      prompt: 'go',
      subagentType: 'Explore',
      status: 'pending',
      statusSource: 'task_event',
    })
  })

  it('keeps claiming an id it has already claimed, whatever the title says', () => {
    // A tool_result update carries no title; identification has to come from
    // the id, or a claimed Task's completion resurrects a raw tool row.
    expect(
      subtaskFromClaudeTool(
        { toolCallId: 'toolu_1', status: 'completed' },
        { phase: 'update', tracked: true },
      ),
    ).toMatchObject({ taskId: 'toolu_1', status: 'completed' })
  })

  it('passes on anything that is not a Task', () => {
    expect(
      subtaskFromClaudeTool(
        { toolCallId: 'toolu_2', title: 'Bash', status: 'pending' },
        { phase: 'call', tracked: false },
      ),
    ).toBeUndefined()
  })
})
