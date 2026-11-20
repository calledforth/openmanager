import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentpack/contract'
import type { v2 } from '@openmanager/codex-app-server-protocol'
import { applyToolUpdate, type ToolCallState, type ToolCallUpdate } from '@openmanager/protocol'
import { presentToolPart, type ToolPartData } from '@openmanager/shared/lib/tool-presenter'
import { projectAgentEvent, ToolCallTracker } from '../../protocol/projectAgentEvent.js'
import { BACKGROUND_NOTE, CodexTools, diffLines, unwrapShell, type CodexToolOutput } from './codex-tools.js'
import { commandExecutionItem, fileChangeItem } from './testing/builders.js'

type Item = v2.ThreadItem

/** A `CodexTools` whose every output is projected the way the environment
 * projects it, and folded into what a client holds of each call. */
function harness(options: { interruptRequested?: boolean } = {}) {
  const outputs: CodexToolOutput[] = []
  const updates: ToolCallUpdate[] = []
  const states = new Map<string, ToolCallState>()
  const tracker = new ToolCallTracker()
  let seq = 0
  const tools = new CodexTools((output) => {
    outputs.push(output)
    if (output.event === 'plan_update') return
    const toolCallId = output.data.toolCallId
    const projected = projectAgentEvent(
      {
        id: `e-${seq}`,
        threadId: 't',
        providerId: 'codex',
        seq: seq++,
        timestamp: `2026-11-20T00:00:${String(seq).padStart(2, '0')}.000Z`,
        sessionId: 's',
        category: 'tool',
        event: output.event,
        data: output.data,
      } as AgentEvent,
      {
        eventId: `event-${seq}`,
        environmentId: 'env',
        workspaceId: 'w',
        sessionId: 's',
        threadId: 't',
        turnId: 'turn-1',
        toolCallId,
        toolCalls: tracker,
        ...(options.interruptRequested ? { interruptRequested: true } : {}),
      },
    )
    if (!projected) return
    if (projected.name !== 'tool.updated') throw new Error(`unexpected ${projected.name}`)
    updates.push(projected.payload)
    states.set(toolCallId, applyToolUpdate(states.get(toolCallId), projected.payload))
  })
  /** What a client holds of a call, as a row part (environment-thread's `toolPart`). */
  const part = (id: string): ToolPartData => {
    const tool = states.get(id)!
    return {
      tool: tool.toolName ?? tool.title ?? tool.kind ?? 'tool',
      ...(tool.toolName ? { toolName: tool.toolName } : {}),
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.kind ? { kind: tool.kind } : {}),
      ...(tool.locations ? { locations: tool.locations } : {}),
      ...(tool.lineChanges ? { lineChanges: tool.lineChanges } : {}),
      state: {
        status: tool.status === 'in_progress' ? 'running' : tool.status === 'failed' ? 'error' : tool.status,
        ...(tool.input !== undefined ? { input: tool.input } : {}),
        ...(tool.output !== undefined ? { output: tool.output } : {}),
      },
    }
  }
  const row = (id: string) => {
    const model = presentToolPart(part(id))
    return `${model.verb} ${model.detail}`.trim()
  }
  return {
    tools,
    outputs,
    updates,
    tracker,
    state: (id: string) => states.get(id)!,
    row,
    wire: () => JSON.stringify(updates),
  }
}

function notify(tools: CodexTools, method: string, params: Record<string, unknown>) {
  return tools.notification(method, { threadId: 'thread', turnId: 'codex-turn', ...params })
}

/** A command started and completed, with output deltas in between. */
function runCommand(
  tools: CodexTools,
  item: Extract<Item, { type: 'commandExecution' }>,
  result: { output?: string; status?: v2.CommandExecutionStatus; exitCode?: number | null } = {},
) {
  tools.itemStarted(item)
  if (result.output) notify(tools, 'item/commandExecution/outputDelta', { itemId: item.id, delta: result.output })
  tools.itemCompleted({
    ...item,
    status: result.status ?? 'completed',
    aggregatedOutput: result.output ?? null,
    exitCode: result.exitCode === undefined ? 0 : result.exitCode,
    durationMs: 120,
  })
}

const command = (command: string, actions: v2.CommandAction[], id = 'exec-1') =>
  commandExecutionItem('', { id, command, cwd: '/work', commandActions: actions })

describe('commandExecution', () => {
  it('is a command row: what the model ran, where, from where, and Codex’s reading of it', () => {
    const { tools, outputs, state, row } = harness()
    const item = command("/bin/bash -lc 'npm test'", [{ type: 'unknown', command: 'npm test' }])
    tools.itemStarted(item)
    expect(outputs[0]).toEqual({
      event: 'tool_call',
      data: expect.objectContaining({
        toolCallId: 'exec-1',
        toolName: 'commandExecution',
        kind: 'execute',
        status: 'in_progress',
        rawInput: {
          command: 'npm test',
          cwd: '/work',
          source: 'agent',
          commandActions: [{ type: 'unknown', command: 'npm test' }],
        },
      }),
    })
    expect(state('exec-1')).toMatchObject({ status: 'in_progress', startedAt: expect.any(String) })
    expect(row('exec-1')).toBe('Running npm test')
  })

  it('streams output as deltas, then settles with the whole output off the wire', () => {
    const { tools, updates, tracker, state, row } = harness()
    const item = command("/bin/bash -lc 'npm test'", [{ type: 'unknown', command: 'npm test' }])
    tools.itemStarted(item)
    notify(tools, 'item/commandExecution/outputDelta', { itemId: item.id, delta: 'ok 1\n' })
    notify(tools, 'item/commandExecution/outputDelta', { itemId: item.id, delta: 'ok 2\n' })
    expect(updates.slice(1)).toEqual([
      { toolCallId: 'exec-1', turnId: 'turn-1', outputDelta: 'ok 1\n' },
      { toolCallId: 'exec-1', turnId: 'turn-1', outputDelta: 'ok 2\n' },
    ])
    expect(state('exec-1').output).toBe('ok 1\nok 2\n')
    tools.itemCompleted({ ...item, status: 'completed', aggregatedOutput: 'ok 1\nok 2\n', exitCode: 0, durationMs: 9 })
    const settled = updates.at(-1)!
    expect(settled).toMatchObject({ status: 'completed', outputBytes: 10, finishedAt: expect.any(String) })
    expect(settled.output).toBeUndefined()
    expect(tracker.takeBody('exec-1')).toBe('ok 1\nok 2\n')
    // The exit code joins the input, where the row reads it.
    expect(state('exec-1').input).toMatchObject({ command: 'npm test', exitCode: 0 })
    expect(state('exec-1').finishedAt).toBeDefined()
    expect(row('exec-1')).toBe('Ran npm test')
  })

  it('fails with a non-zero exit, and keeps the exit code', () => {
    const { tools, state } = harness()
    runCommand(tools, command('/bin/bash -lc false', [{ type: 'unknown', command: 'false' }]), {
      status: 'failed',
      exitCode: 1,
    })
    expect(state('exec-1')).toMatchObject({ status: 'failed', input: { command: 'false', exitCode: 1 } })
  })

  it('reads as declined when Codex says the user refused it', () => {
    const { tools, state, row } = harness()
    const item = command("/bin/bash -lc 'rm -rf build'", [{ type: 'unknown', command: 'rm -rf build' }])
    runCommand(tools, item, { status: 'declined', exitCode: null })
    expect(state('exec-1').status).toBe('declined')
    expect(row('exec-1')).toBe('Run rm -rf build')
  })

  it('reads as cancelled when it fails while the turn is being stopped', () => {
    const { tools, state } = harness({ interruptRequested: true })
    runCommand(tools, command('/bin/bash -lc sleep', [{ type: 'unknown', command: 'sleep' }]), {
      status: 'failed',
      exitCode: null,
    })
    expect(state('exec-1').status).toBe('cancelled')
  })

  it('a read is a read: its paths, never the file it printed', () => {
    const { tools, updates, tracker, state, row } = harness()
    const item = command("/bin/bash -lc 'cat notes.txt'", [
      { type: 'read', command: 'cat notes.txt', name: 'notes.txt', path: '/work/notes.txt' },
    ])
    runCommand(tools, item, { output: 'secret contents\n' })
    expect(JSON.stringify(updates)).not.toContain('secret contents')
    expect(tracker.takeBody('exec-1')).toBeUndefined()
    expect(state('exec-1')).toMatchObject({ kind: 'read', locations: [{ path: '/work/notes.txt' }] })
    expect(row('exec-1')).toBe('Read notes.txt')
  })

  it('a search and a listing get their own labels, and keep their output', () => {
    const { tools, tracker, row } = harness()
    runCommand(
      tools,
      command("/bin/bash -lc 'rg -n hello src'", [
        { type: 'search', command: 'rg -n hello src', query: 'hello', path: 'src' },
      ]),
      { output: 'src/a.ts:1:hello\n' },
    )
    expect(row('exec-1')).toBe('Searched for "hello" in src')
    expect(tracker.takeBody('exec-1')).toBe('src/a.ts:1:hello\n')

    runCommand(tools, command('/bin/bash -lc ls', [{ type: 'listFiles', command: 'ls', path: null }], 'exec-2'), {
      output: 'a.ts\n',
    })
    expect(row('exec-2')).toBe('Listed files')
    runCommand(
      tools,
      command("/bin/bash -lc 'ls nope'", [{ type: 'listFiles', command: 'ls nope', path: 'nope' }], 'exec-3'),
      { status: 'failed', exitCode: 2 },
    )
    expect(row('exec-3')).toBe('List nope')
  })

  it('a search that found nothing completed', () => {
    const { tools, state } = harness()
    const search = (id: string) =>
      command("/bin/bash -lc 'rg nope'", [{ type: 'search', command: 'rg nope', query: 'nope', path: null }], id)
    runCommand(tools, search('exec-1'), { status: 'failed', exitCode: 1 })
    expect(state('exec-1')).toMatchObject({ status: 'completed', input: { exitCode: 1 } })
    // An error is still one: it says why.
    runCommand(tools, search('exec-2'), { status: 'failed', exitCode: 2, output: 'rg: bad regex\n' })
    expect(state('exec-2').status).toBe('failed')
  })

  it('a command still running in the background when the turn ends settles as completed', () => {
    const { tools, state, tracker } = harness()
    const item = { ...command("/bin/bash -lc 'npm run dev'", [{ type: 'unknown', command: 'npm run dev' }]), processId: '42' }
    tools.itemStarted(item)
    notify(tools, 'item/commandExecution/outputDelta', { itemId: item.id, delta: 'listening\n' })
    // Another, with no process of its own, is the server's to close.
    tools.itemStarted(command('/bin/bash -lc x', [{ type: 'unknown', command: 'x' }], 'exec-2'))
    tools.finish(false)
    expect(state('exec-1')).toMatchObject({ status: 'completed', outputBytes: 'listening\n'.length + BACKGROUND_NOTE.length })
    expect(state('exec-1').input).not.toHaveProperty('exitCode')
    expect(tracker.takeBody('exec-1')).toBeUndefined()
    expect(state('exec-2').status).toBe('in_progress')
    // Its late completion changes nothing.
    tools.itemCompleted({ ...item, status: 'completed', aggregatedOutput: 'x', exitCode: 0, durationMs: 1 })
    expect(state('exec-1').input).not.toHaveProperty('exitCode')
  })

  it('leaves a running command open when the turn was stopped', () => {
    const { tools, state } = harness()
    tools.itemStarted({ ...command('/bin/bash -lc x', [{ type: 'unknown', command: 'x' }]), processId: '42' })
    tools.finish(true)
    expect(state('exec-1').status).toBe('in_progress')
  })

  it('a command doing more than one thing stays a command', () => {
    const { tools, state, row } = harness()
    runCommand(
      tools,
      command("/bin/bash -lc 'cat a | rg x'", [
        { type: 'read', command: 'cat a', name: 'a', path: '/work/a' },
        { type: 'search', command: 'rg x', query: 'x', path: null },
      ]),
    )
    expect(state('exec-1').kind).toBe('execute')
    expect(row('exec-1')).toBe('Ran cat a | rg x')
  })

  it('shows what was written to its terminal on the command', () => {
    const { tools, state } = harness()
    const item = command("/bin/bash -lc 'read n'", [{ type: 'unknown', command: 'read n' }])
    tools.itemStarted(item)
    notify(tools, 'item/commandExecution/terminalInteraction', { itemId: item.id, processId: '9', stdin: 'ada\n' })
    expect(state('exec-1').input).toMatchObject({ command: 'read n', stdin: ['ada\n'] })
    tools.itemCompleted({ ...item, status: 'completed', aggregatedOutput: 'hi ada\n', exitCode: 0, durationMs: 5 })
    expect(state('exec-1').input).toMatchObject({ stdin: ['ada\n'], exitCode: 0 })
  })

  it('ignores output and interactions for a command it never saw start', () => {
    const { tools, outputs } = harness()
    expect(notify(tools, 'item/commandExecution/outputDelta', { itemId: 'nope', delta: 'x' })).toBe(true)
    notify(tools, 'item/commandExecution/terminalInteraction', { itemId: 'nope', processId: '1', stdin: 'x' })
    expect(outputs).toEqual([])
  })

  it('opens and settles at once a command seen only completed', () => {
    const { tools, outputs, state } = harness()
    const item = command("/bin/bash -lc 'echo hi'", [{ type: 'unknown', command: 'echo hi' }])
    tools.itemCompleted({ ...item, status: 'completed', aggregatedOutput: 'hi\n', exitCode: 0, durationMs: 1 })
    expect(outputs.map((output) => output.event)).toEqual(['tool_call'])
    expect(state('exec-1')).toMatchObject({ status: 'completed', startedAt: expect.any(String) })
  })
})

describe('unwrapShell', () => {
  it('takes the command out of Codex’s login-shell wrapper', () => {
    expect(unwrapShell("/bin/bash -lc 'cat notes.txt'")).toBe('cat notes.txt')
    expect(unwrapShell('/bin/bash -lc ls')).toBe('ls')
    expect(unwrapShell(`/bin/bash -lc 'echo '\\''hi'\\'''`)).toBe("echo 'hi'")
    expect(unwrapShell(`/bin/zsh -c 'read -p "name? " n'`)).toBe('read -p "name? " n')
  })

  it('leaves anything else as Codex sent it', () => {
    expect(unwrapShell('npm test')).toBe('npm test')
    expect(unwrapShell(`/bin/bash -lc "echo $HOME"`)).toBe(`/bin/bash -lc "echo $HOME"`)
    expect(unwrapShell(`/bin/bash -lc 'a' extra`)).toBe(`/bin/bash -lc 'a' extra`)
  })
})

describe('fileChange', () => {
  const add = { path: '/work/new.ts', kind: { type: 'add' as const }, diff: 'one\ntwo\n' }
  const del = { path: '/work/old.ts', kind: { type: 'delete' as const }, diff: 'gone\n' }
  const update = {
    path: '/work/a.ts',
    kind: { type: 'update' as const, move_path: null },
    diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n-old\n+new\n+more\n keep\n---dashes\n',
  }
  const move = { path: '/work/b.ts', kind: { type: 'update' as const, move_path: '/work/c.ts' }, diff: '' }

  it('counts lines off the diff Codex reported, per change', () => {
    expect(diffLines(add)).toEqual({ added: 2, removed: 0 })
    expect(diffLines(del)).toEqual({ added: 0, removed: 1 })
    expect(diffLines(update)).toEqual({ added: 2, removed: 2 })
    expect(diffLines(move)).toEqual({ added: 0, removed: 0 })
  })

  it('is every file touched, with line counts, and no diff on the wire', () => {
    const { tools, wire, state, row } = harness()
    const item = fileChangeItem([add, del, update, move], { id: 'patch-1' })
    tools.itemStarted(item)
    tools.itemCompleted({ ...item, status: 'completed' })
    expect(state('patch-1')).toMatchObject({
      toolName: 'fileChange',
      kind: 'edit',
      status: 'completed',
      input: {
        changes: [
          { path: '/work/new.ts', kind: 'add' },
          { path: '/work/old.ts', kind: 'delete' },
          { path: '/work/a.ts', kind: 'update' },
          { path: '/work/b.ts', kind: 'move', movePath: '/work/c.ts' },
        ],
      },
      locations: [
        { path: '/work/new.ts' },
        { path: '/work/old.ts' },
        { path: '/work/a.ts' },
        { path: '/work/b.ts' },
        { path: '/work/c.ts' },
      ],
      lineChanges: { added: 4, removed: 3 },
    })
    expect(wire()).not.toMatch(/one\\ntwo|gone|more/)
    expect(row('patch-1')).toBe('Edited new.ts')
  })

  it('labels a lone added or deleted file, and a lone move', () => {
    const { tools, state, row } = harness()
    tools.itemCompleted({ ...fileChangeItem([add], { id: 'p-add' }), status: 'completed' })
    tools.itemCompleted({ ...fileChangeItem([del], { id: 'p-del' }), status: 'completed' })
    tools.itemCompleted({ ...fileChangeItem([move], { id: 'p-move' }), status: 'completed' })
    expect(row('p-add')).toBe('Wrote new.ts')
    expect(row('p-del')).toBe('Deleted old.ts')
    expect(state('p-del').kind).toBe('delete')
    expect(state('p-move').kind).toBe('move')
  })

  it('stays live with patchUpdated', () => {
    const { tools, state } = harness()
    const item = fileChangeItem([add], { id: 'patch-1' })
    tools.itemStarted(item)
    notify(tools, 'item/fileChange/patchUpdated', { itemId: 'patch-1', changes: [add, update] })
    expect(state('patch-1')).toMatchObject({
      status: 'in_progress',
      lineChanges: { added: 4, removed: 2 },
      locations: [{ path: '/work/new.ts' }, { path: '/work/a.ts' }],
    })
  })

  it('opens on a patchUpdated that comes before its item/started', () => {
    const { tools, state, outputs } = harness()
    notify(tools, 'item/fileChange/patchUpdated', { itemId: 'patch-1', changes: [add] })
    expect(state('patch-1')).toMatchObject({ status: 'in_progress', toolName: 'fileChange', lineChanges: { added: 2, removed: 0 } })
    tools.itemStarted(fileChangeItem([add], { id: 'patch-1' }))
    tools.itemCompleted({ ...fileChangeItem([add, update], { id: 'patch-1' }), status: 'completed' })
    expect(outputs.map((output) => output.event)).toEqual(['tool_call', 'tool_call_update'])
    expect(state('patch-1')).toMatchObject({ status: 'completed', lineChanges: { added: 4, removed: 2 } })
  })

  it('reads as declined when the user refused it', () => {
    const { tools, state } = harness()
    tools.itemCompleted({ ...fileChangeItem([add], { id: 'patch-1' }), status: 'declined' })
    expect(state('patch-1').status).toBe('declined')
  })
})

function mcpItem(overrides: Partial<Extract<Item, { type: 'mcpToolCall' }>> = {}): Extract<Item, { type: 'mcpToolCall' }> {
  return {
    type: 'mcpToolCall',
    id: 'mcp-1',
    server: 'github',
    tool: 'search_issues',
    status: 'inProgress',
    arguments: { query: 'bug' },
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
    result: null,
    error: null,
    durationMs: null,
    ...overrides,
  }
}

describe('mcpToolCall', () => {
  it('is server and tool, with its arguments; progress streams', () => {
    const { tools, state, row, updates } = harness()
    tools.itemStarted(mcpItem())
    notify(tools, 'item/mcpToolCall/progress', { itemId: 'mcp-1', message: 'Searching' })
    expect(state('mcp-1')).toMatchObject({
      toolName: 'mcp__github__search_issues',
      input: { query: 'bug' },
      status: 'in_progress',
      output: 'Searching\n',
    })
    expect(updates.at(-1)).toMatchObject({ outputDelta: 'Searching\n' })
    expect(row('mcp-1')).toBe('github search issues')
  })

  it('settles with the structured content when there is one, and moves images out', () => {
    const { tools, outputs, tracker } = harness()
    tools.itemStarted(mcpItem())
    tools.itemCompleted(
      mcpItem({
        status: 'completed',
        result: {
          content: [
            { type: 'text', text: '{"count":1}' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          ],
          structuredContent: { count: 1 },
          _meta: null,
        },
      }),
    )
    expect(tracker.takeBody('mcp-1')).toBe('{\n  "count": 1\n}')
    expect(outputs.at(-1)).toMatchObject({
      event: 'tool_call_update',
      data: {
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: '{\n  "count": 1\n}' } },
          { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } },
        ],
      },
    })
  })

  it('settles with its text content when there is no structured content', () => {
    const { tools, tracker } = harness()
    tools.itemCompleted(
      mcpItem({
        status: 'completed',
        result: {
          content: [{ type: 'text', text: 'one' }, { type: 'resource', resource: { uri: 'x', text: 'two' } }],
          structuredContent: null,
          _meta: null,
        },
      }),
    )
    expect(tracker.takeBody('mcp-1')).toBe('one\ntwo')
  })

  it('fails with the error Codex reported', () => {
    const { tools, state, tracker } = harness()
    tools.itemCompleted(mcpItem({ status: 'failed', error: { message: 'tool not found' } }))
    expect(state('mcp-1').status).toBe('failed')
    expect(tracker.takeBody('mcp-1')).toBe('tool not found')
  })
})

describe('other items', () => {
  it('dynamicToolCall: its name, arguments and output', () => {
    const { tools, state, tracker, outputs } = harness()
    const item: Item = {
      type: 'dynamicToolCall',
      id: 'dyn-1',
      namespace: 'host',
      tool: 'lookup',
      arguments: { id: 7 },
      status: 'completed',
      contentItems: [
        { type: 'inputText', text: 'found' },
        { type: 'inputImage', imageUrl: 'data:image/png;base64,QUJD' },
        { type: 'inputImage', imageUrl: 'https://example.org/a.png' },
      ],
      success: true,
      durationMs: 3,
    }
    tools.itemCompleted(item)
    expect(state('dyn-1')).toMatchObject({ toolName: 'host.lookup', input: { id: 7 }, status: 'completed' })
    expect(tracker.takeBody('dyn-1')).toBe('found')
    expect(outputs[0]).toMatchObject({
      data: { content: [{}, { content: { type: 'image', mimeType: 'image/png', data: 'QUJD' } }] },
    })
    tools.itemCompleted({ ...item, id: 'dyn-2', success: false, contentItems: null })
    expect(state('dyn-2').status).toBe('failed')
  })

  it('webSearch: a search, a page opened, a pattern found in a page', () => {
    const { tools, state, row } = harness()
    const search = (id: string, action: v2.WebSearchAction | null, query = ''): Item => ({
      type: 'webSearch',
      id,
      query,
      action,
      results: null,
    })
    tools.itemStarted(search('ws-1', null, 'codex'))
    expect(row('ws-1')).toBe('Searching the web for "codex"')
    tools.itemCompleted(search('ws-1', { type: 'search', query: 'codex', queries: null }, 'codex'))
    expect(state('ws-1')).toMatchObject({ toolName: 'webSearch', kind: 'fetch', status: 'completed' })
    expect(row('ws-1')).toBe('Searched the web for "codex"')
    tools.itemCompleted(search('ws-2', { type: 'openPage', url: 'https://example.org' }))
    expect(row('ws-2')).toBe('Fetched https://example.org')
    tools.itemCompleted(search('ws-3', { type: 'findInPage', url: 'https://example.org', pattern: 'install' }))
    expect(row('ws-3')).toBe('Searched for "install" in https://example.org')
  })

  it('sleep: how long it waited', () => {
    const { tools, row } = harness()
    const item: Item = { type: 'sleep', id: 'sleep-1', durationMs: 5000 }
    tools.itemStarted(item)
    expect(row('sleep-1')).toBe('Waiting 5s')
    tools.itemCompleted(item)
    expect(row('sleep-1')).toBe('Waited 5s')
  })

  it('imageView: a read of the image it looked at', () => {
    const { tools, state, row } = harness()
    tools.itemCompleted({ type: 'imageView', id: 'img-1', path: '/work/shot.png' })
    expect(state('img-1')).toMatchObject({ kind: 'read', locations: [{ path: '/work/shot.png' }] })
    expect(row('img-1')).toBe('Read shot.png')
  })

  it('functionCallOutput is skipped: it echoes a tool output a client handed in', () => {
    const { tools, outputs } = harness()
    const item: Item = { type: 'functionCallOutput', id: 'fco-1', name: 'x', namespace: null, output: 'y' }
    expect(tools.itemStarted(item)).toBe(true)
    expect(tools.itemCompleted(item)).toBe(true)
    expect(outputs).toEqual([])
  })

  it('leaves items that are not tools to the turn', () => {
    const { tools, outputs } = harness()
    expect(tools.itemStarted({ type: 'contextCompaction', id: 'c' })).toBe(false)
    expect(tools.itemCompleted({ type: 'plan', id: 'p', text: 'x' })).toBe(false)
    expect(notify(tools, 'item/agentMessage/delta', { itemId: 'm', delta: 'x' })).toBe(false)
    expect(outputs).toEqual([])
  })
})

function hookRun(overrides: Partial<v2.HookRunSummary> = {}): v2.HookRunSummary {
  return {
    id: 'run-1',
    eventName: 'preToolUse',
    handlerType: 'command',
    executionMode: 'sync',
    scope: 'turn',
    sourcePath: '/work/.codex/hooks.json',
    source: 'project',
    displayOrder: 0n,
    status: 'running',
    statusMessage: null,
    startedAt: 0n,
    completedAt: null,
    durationMs: null,
    entries: [],
    ...overrides,
  }
}

describe('hooks', () => {
  it('a hook run is a row, from hook/started to hook/completed', () => {
    const { tools, state, tracker, row } = harness()
    expect(notify(tools, 'hook/started', { run: hookRun() })).toBe(true)
    expect(state('hook-run-1-1')).toMatchObject({
      toolName: 'hook',
      status: 'in_progress',
      input: { eventName: 'preToolUse', handlerType: 'command', source: 'project' },
    })
    expect(row('hook-run-1-1')).toBe('Running hook preToolUse')
    notify(tools, 'hook/completed', {
      run: hookRun({
        status: 'blocked',
        statusMessage: 'rm is not allowed',
        entries: [{ kind: 'feedback', text: 'use trash instead' }],
      }),
    })
    expect(state('hook-run-1-1').status).toBe('completed')
    expect(tracker.takeBody('hook-run-1-1')).toBe('Blocked\nrm is not allowed\nfeedback: use trash instead')
    expect(row('hook-run-1-1')).toBe('Ran hook preToolUse')
  })

  it('each firing of a hook is its own row, settled by its own completion', () => {
    const { tools, state, tracker } = harness()
    notify(tools, 'hook/started', { run: hookRun() })
    notify(tools, 'hook/completed', { run: hookRun({ status: 'completed' }) })
    notify(tools, 'hook/started', { run: hookRun() })
    notify(tools, 'hook/completed', { run: hookRun({ status: 'blocked', statusMessage: 'no' }) })
    expect(state('hook-run-1-1').status).toBe('completed')
    expect(tracker.takeBody('hook-run-1-1')).toBeUndefined()
    expect(state('hook-run-1-2').status).toBe('completed')
    expect(tracker.takeBody('hook-run-1-2')).toBe('Blocked\nno')
  })

  it('a failed hook fails, and one seen only completed opens and settles', () => {
    const { tools, state } = harness()
    notify(tools, 'hook/completed', { turnId: null, run: hookRun({ id: 'run-2', status: 'failed' }) })
    expect(state('hook-run-2-1')).toMatchObject({ status: 'failed', startedAt: expect.any(String) })
  })

  it('the hookPrompt item is the text a hook added, once', () => {
    const { tools, outputs, tracker, row } = harness()
    const item: Item = {
      type: 'hookPrompt',
      id: 'hp-1',
      fragments: [
        { text: 'Run the tests first.', hookRunId: 'run-1' },
        { text: 'Then lint.', hookRunId: 'run-1' },
      ],
    }
    tools.itemStarted(item)
    tools.itemCompleted(item)
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({
      event: 'tool_call',
      data: { toolName: 'hookPrompt', status: 'completed', rawInput: { hookRunIds: ['run-1'] } },
    })
    expect(tracker.takeBody('hp-1')).toBe('Run the tests first.\n\nThen lint.')
    expect(row('hp-1')).toBe('Hook added a prompt')
  })
})

describe('turn/plan/updated', () => {
  it('is the todo checklist, and a row where the model updated it', () => {
    const { tools, outputs, state, row } = harness()
    notify(tools, 'turn/plan/updated', {
      turnId: 'codex-turn',
      explanation: 'Two steps',
      plan: [
        { step: 'Look around', status: 'inProgress' },
        { step: 'Edit notes', status: 'pending' },
      ],
    })
    notify(tools, 'turn/plan/updated', {
      turnId: 'codex-turn',
      explanation: null,
      plan: [
        { step: 'Look around', status: 'completed' },
        { step: 'Edit notes', status: 'completed' },
      ],
    })
    const plans = outputs.filter((output) => output.event === 'plan_update')
    expect(plans.map((plan) => plan.data)).toEqual([
      {
        entries: [
          { content: 'Look around', priority: 'medium', status: 'in_progress' },
          { content: 'Edit notes', priority: 'medium', status: 'pending' },
        ],
        explanation: 'Two steps',
      },
      {
        entries: [
          { content: 'Look around', priority: 'medium', status: 'completed' },
          { content: 'Edit notes', priority: 'medium', status: 'completed' },
        ],
      },
    ])
    expect(state('plan-codex-turn-1')).toMatchObject({ toolName: 'update_plan', status: 'completed' })
    expect(state('plan-codex-turn-2').input).toMatchObject({ plan: [{ step: 'Look around', status: 'completed' }, {}] })
    expect(row('plan-codex-turn-2')).toBe('Updated tasks')
  })
})
