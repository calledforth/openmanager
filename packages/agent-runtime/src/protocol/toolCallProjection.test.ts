import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@agentpack/contract'
import {
  ProofEventSchema,
  TOOL_INPUT_MAX_BYTES,
  TOOL_OUTPUT_MAX_BYTES,
  applyToolUpdate,
  boundToolOutput,
  toolOutputBytes,
  type ToolCallState,
  type ToolCallUpdate,
} from '@openmanager/protocol'
import type { BackendEvent } from '../backends/Backend.js'
import { ClaudeMessageTranslator } from '../session/claude/ClaudeMessageTranslator.js'
import { projectAgentEvent, type ProtocolEventContext } from './projectAgentEvent.js'
import { ToolCallTracker } from './toolCallProjection.js'

const context: ProtocolEventContext = {
  eventId: 'host-event',
  environmentId: 'host-env',
  workspaceId: 'host-workspace',
  sessionId: 'host-session',
  threadId: 'host-thread',
  turnId: 'host-turn',
  toolCallId: 'host-tool',
}

let seq = 0
/** Stamp a backend event the way the runtime does before the host sees it. */
const stamp = (event: BackendEvent | Omit<BackendEvent, 'threadId'>): AgentEvent =>
  ({
    threadId: 'provider-thread',
    ...event,
    id: `event-${(seq += 1)}`,
    seq,
    timestamp: new Date(Date.UTC(2026, 9, 9, 10, 0, seq)).toISOString(),
    providerId: 'claude',
  }) as AgentEvent

/** Project every tool event to its payload, folded and validated like a client would. */
function projector(tracker = new ToolCallTracker(), extra: Partial<ProtocolEventContext> = {}) {
  const updates: ToolCallUpdate[] = []
  const states = new Map<string, ToolCallState>()
  const project = (event: AgentEvent) => {
    const toolCallId =
      'toolCallId' in (event.data as object)
        ? `host-${(event.data as { toolCallId: string }).toolCallId}`
        : undefined
    const projected = projectAgentEvent(event, {
      ...context,
      ...extra,
      toolCallId,
      toolCalls: tracker,
    })
    if (!projected) return
    const parsed = ProofEventSchema.parse(JSON.parse(JSON.stringify(projected)))
    if (parsed.name !== 'tool.updated') return
    updates.push(parsed.payload)
    states.set(
      parsed.payload.toolCallId,
      applyToolUpdate(states.get(parsed.payload.toolCallId), parsed.payload),
    )
  }
  return { updates, states, project, tracker }
}

function claude() {
  const translator = new ClaudeMessageTranslator({
    route: () => ({ threadId: 'provider-thread', workspaceId: 'provider-workspace' }),
    log: vi.fn(),
  })
  const sink = projector()
  const feed = (message: unknown) => {
    for (const event of translator.translate(message as SDKMessage).events)
      sink.project(stamp(event))
  }
  return { ...sink, feed }
}

const stream = (event: Record<string, unknown>) => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: null,
  uuid: 'uuid-1',
  session_id: 'session-1',
})
const toolStart = (index: number, id: string, name: string) =>
  stream({
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  })
const toolInput = (index: number, input: unknown) =>
  stream({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
  })
const toolResult = (
  id: string,
  content: unknown,
  extra: { is_error?: boolean; tool_use_result?: unknown } = {},
) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content,
        ...(extra.is_error ? { is_error: true } : {}),
      },
    ],
  },
  ...(extra.tool_use_result !== undefined ? { tool_use_result: extra.tool_use_result } : {}),
  parent_tool_use_id: null,
  session_id: 'session-1',
})

describe('Claude Code tool calls on the wire', () => {
  it('carries the provider name, input, output, times and status of a Bash call', () => {
    const { feed, states, updates } = claude()
    feed(toolStart(0, 'toolu_bash', 'Bash'))
    feed(toolInput(0, { command: 'pnpm test', description: 'Run the tests' }))
    feed(
      toolResult('toolu_bash', 'all 12 passed\n', {
        tool_use_result: { stdout: 'all 12 passed\n', stderr: '', interrupted: false },
      }),
    )

    expect(updates[0]).toMatchObject({
      toolName: 'Bash',
      title: 'Bash',
      kind: 'execute',
      status: 'pending',
    })
    expect(updates[0]!.startedAt).toBeDefined()
    expect(states.get('host-toolu_bash')).toEqual({
      toolCallId: 'host-toolu_bash',
      turnId: 'host-turn',
      toolName: 'Bash',
      title: 'Bash',
      kind: 'execute',
      status: 'completed',
      input: { command: 'pnpm test', description: 'Run the tests' },
      output: { text: 'all 12 passed\n' },
      startedAt: updates[0]!.startedAt,
      finishedAt: updates.at(-1)!.finishedAt,
    })
    expect(Date.parse(updates.at(-1)!.finishedAt!)).toBeGreaterThan(
      Date.parse(updates[0]!.startedAt!),
    )
  })

  it('keeps MCP tool names as the provider spells them', () => {
    const { feed, states } = claude()
    feed(toolStart(0, 'toolu_mcp', 'mcp__github__search_issues'))
    feed(toolInput(0, { query: 'is:open' }))
    feed(toolResult('toolu_mcp', [{ type: 'text', text: '3 issues' }]))
    expect(states.get('host-toolu_mcp')).toMatchObject({
      toolName: 'mcp__github__search_issues',
      kind: 'other',
      input: { query: 'is:open' },
      output: { text: '3 issues' },
      status: 'completed',
    })
  })

  it('strips edit bodies, keeps the path, and takes line counts only from the reported patch', () => {
    const { feed, states, updates } = claude()
    feed(toolStart(0, 'toolu_edit', 'Edit'))
    feed(
      toolInput(0, {
        file_path: '/repo/a.ts',
        old_string: 'const a = 1',
        new_string: 'const a = 2',
        replace_all: false,
      }),
    )
    feed(
      toolResult('toolu_edit', 'The file /repo/a.ts has been updated.', {
        tool_use_result: {
          filePath: '/repo/a.ts',
          oldString: 'const a = 1',
          newString: 'const a = 2',
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 2,
              lines: ['-const a = 1', '+const a = 2', '+const b = 3', ' x'],
            },
          ],
        },
      }),
    )

    const json = JSON.stringify(updates)
    expect(json).not.toContain('const a = 1')
    expect(json).not.toContain('const a = 2')
    expect(states.get('host-toolu_edit')).toMatchObject({
      toolName: 'Edit',
      kind: 'edit',
      status: 'completed',
      input: { file_path: '/repo/a.ts', replace_all: false },
      locations: [{ path: '/repo/a.ts' }],
      lineChanges: { added: 2, removed: 1 },
      output: { text: 'The file /repo/a.ts has been updated.' },
    })
  })

  it('prefers git diff counts and never carries a Write body or MultiEdit bodies', () => {
    const { feed, states, updates } = claude()
    feed(toolStart(0, 'toolu_write', 'Write'))
    feed(toolInput(0, { file_path: '/repo/new.ts', content: 'SECRET BODY' }))
    feed(
      toolResult('toolu_write', 'File created successfully at: /repo/new.ts', {
        tool_use_result: {
          type: 'create',
          filePath: '/repo/new.ts',
          content: 'SECRET BODY',
          structuredPatch: [],
          gitDiff: {
            filename: 'new.ts',
            status: 'added',
            additions: 7,
            deletions: 0,
            changes: 7,
            patch: 'SECRET BODY',
          },
        },
      }),
    )
    feed(toolStart(1, 'toolu_multi', 'MultiEdit'))
    feed(
      toolInput(1, {
        file_path: '/repo/b.ts',
        edits: [{ old_string: 'SECRET OLD', new_string: 'SECRET NEW', replace_all: true }],
      }),
    )

    expect(JSON.stringify(updates)).not.toContain('SECRET')
    expect(states.get('host-toolu_write')).toMatchObject({
      input: { file_path: '/repo/new.ts' },
      lineChanges: { added: 7, removed: 0 },
    })
    expect(states.get('host-toolu_multi')).toMatchObject({
      input: { file_path: '/repo/b.ts', edits: [{ replace_all: true }] },
    })
  })

  it('reads an auto-denied call as declined and an interrupted command as cancelled', () => {
    const { feed, states } = claude()
    feed({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_denied',
      session_id: 'session-1',
    })
    feed(toolStart(0, 'toolu_stop', 'Bash'))
    feed(toolInput(0, { command: 'sleep 100' }))
    feed(
      toolResult('toolu_stop', 'Command was interrupted', {
        is_error: true,
        tool_use_result: { stdout: '', stderr: '', interrupted: true },
      }),
    )
    expect(states.get('host-toolu_denied')).toMatchObject({ toolName: 'Bash', status: 'declined' })
    expect(states.get('host-toolu_denied')!.finishedAt).toBeDefined()
    expect(states.get('host-toolu_stop')).toMatchObject({ status: 'cancelled' })
  })

  it('leaves an image result out of the tool output', () => {
    const { feed, states, updates } = claude()
    feed(toolStart(0, 'toolu_read', 'Read'))
    feed(toolInput(0, { file_path: '/repo/shot.png' }))
    feed(
      toolResult('toolu_read', [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ]),
    )
    expect(JSON.stringify(updates)).not.toContain('AAAA')
    expect(states.get('host-toolu_read')).toMatchObject({
      status: 'completed',
      locations: [{ path: '/repo/shot.png' }],
    })
    expect(states.get('host-toolu_read')!.output).toBeUndefined()
  })

  it('bounds a huge result and a huge input', () => {
    const { feed, states, updates } = claude()
    feed(toolStart(0, 'toolu_big', 'Bash'))
    feed(toolInput(0, { command: `echo ${'x'.repeat(50_000)}` }))
    feed(toolResult('toolu_big', `first line\n${'y'.repeat(200_000)}\nlast line`))
    const state = states.get('host-toolu_big')!
    expect(toolOutputBytes(state.output!)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
    expect(state.output!.text.startsWith('first line\n')).toBe(true)
    expect(state.output!.tail!.endsWith('\nlast line')).toBe(true)
    expect(state.output!.omittedBytes).toBeGreaterThan(180_000)
    expect(Buffer.byteLength(JSON.stringify(state.input))).toBeLessThanOrEqual(TOOL_INPUT_MAX_BYTES)
    for (const update of updates)
      expect(Buffer.byteLength(JSON.stringify(update))).toBeLessThan(32 * 1024)
  })
})

describe('ACP edit calls', () => {
  // As OpenCode reports them over ACP: no tool name, `kind: 'edit'`, the
  // output as `{ output | error, metadata }` and the diff as content.
  const acp = (
    data: Record<string, unknown>,
    event: 'tool_call' | 'tool_call_update' = 'tool_call_update',
  ) =>
    stamp({
      workspaceId: 'w',
      sessionId: 's',
      category: 'tool',
      event,
      data: { toolCallId: 'patch', ...data },
    } as BackendEvent)
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '-SECRET OLD LINE',
    '+SECRET NEW LINE',
    '*** End Patch',
  ].join('\n')
  const diff = {
    type: 'diff',
    path: '/repo/src/a.ts',
    oldText: 'SECRET OLD',
    newText: 'SECRET NEW',
  }

  it('never carries an apply_patch body, and shows what the provider said it did', () => {
    const { project, updates, states } = projector()
    project(
      acp(
        {
          title: 'apply_patch',
          kind: 'edit',
          status: 'pending',
          rawInput: { patchText: patch },
          locations: [{ path: '/repo/src/a.ts' }],
        },
        'tool_call',
      ),
    )
    project(
      acp({
        status: 'completed',
        content: [diff],
        rawOutput: {
          output: 'Success. Updated the following files:\nM src/a.ts',
          metadata: { diff: 'SECRET DIFF' },
        },
      }),
    )
    expect(JSON.stringify(updates)).not.toContain('SECRET')
    expect(states.get('host-patch')).toMatchObject({
      title: 'apply_patch',
      kind: 'edit',
      status: 'completed',
      input: {},
      locations: [{ path: '/repo/src/a.ts' }],
      output: { text: 'Success. Updated the following files:\nM src/a.ts' },
    })
  })

  it('shows why an edit failed', () => {
    const { project, states, updates } = projector()
    project(
      acp(
        {
          title: 'edit',
          kind: 'edit',
          status: 'in_progress',
          rawInput: { filePath: '/repo/a.ts', oldString: 'SECRET', newString: 'SECRET 2' },
        },
        'tool_call',
      ),
    )
    project(
      acp({
        status: 'failed',
        content: [],
        rawOutput: { error: 'oldString not found in content', metadata: {} },
      }),
    )
    expect(JSON.stringify(updates)).not.toContain('SECRET')
    expect(states.get('host-patch')).toMatchObject({
      status: 'failed',
      input: { filePath: '/repo/a.ts' },
      output: { text: 'oldString not found in content' },
    })
  })

  it('drops a patch body from any tool but keeps a diff flag', () => {
    const { project, states } = projector()
    project(
      acp(
        {
          title: 'git',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { patchText: patch, unified_diff: patch, diff: true, cwd: '/repo' },
        },
        'tool_call',
      ),
    )
    expect(states.get('host-patch')!.input).toEqual({ diff: true, cwd: '/repo' })
  })
})

describe('streamed tool output', () => {
  const update = (
    data: Record<string, unknown>,
    event: 'tool_call' | 'tool_call_update' = 'tool_call_update',
  ) =>
    stamp({
      workspaceId: 'w',
      sessionId: 's',
      category: 'tool',
      event,
      data: { toolCallId: 'run', ...data },
    } as BackendEvent)
  const appended = (text: string) =>
    stamp({
      workspaceId: 'w',
      sessionId: 's',
      category: 'tool',
      event: 'tool_call_content',
      data: { toolCallId: 'run', item: { type: 'content', content: { type: 'text', text } } },
    } as BackendEvent)
  const resend = (text: string) => ({
    content: [{ type: 'content', content: { type: 'text', text } }],
  })

  it('turns a provider that resends its whole output into append deltas', () => {
    const { project, updates, states } = projector()
    project(update({ title: 'Run tests', kind: 'execute', status: 'in_progress' }, 'tool_call'))
    project(update(resend('line 1\n')))
    project(update(resend('line 1\nline 2\n')))
    project(update(resend('line 1\nline 2\n')))
    project(update({ ...resend('line 1\nline 2\nline 3\n'), status: 'completed' }))

    expect(updates.map((item) => item.output ?? item.outputDelta ?? null)).toEqual([
      null,
      { text: 'line 1\n' },
      'line 2\n',
      null,
      'line 3\n',
    ])
    expect(states.get('host-run')!.output).toEqual({ text: 'line 1\nline 2\nline 3\n' })
  })

  it('replaces the output when a resend does not extend it', () => {
    const { project, updates } = projector()
    project(update(resend('progress 10%'), 'tool_call'))
    project(update(resend('progress 20%')))
    expect(updates.at(-1)).toMatchObject({ output: { text: 'progress 20%' } })
    expect(updates.at(-1)!.outputDelta).toBeUndefined()
  })

  it('streams appended content as deltas, and keeps the newest past the cap', () => {
    const { project, updates, states } = projector()
    project(update({ title: 'Build', status: 'in_progress' }, 'tool_call'))
    const chunks = Array.from({ length: 400 }, (_, index) => `step ${index}: ${'.'.repeat(100)}\n`)
    for (const chunk of chunks) project(appended(chunk))
    expect(updates.slice(1).every((item) => item.outputDelta !== undefined)).toBe(true)
    const output = states.get('host-run')!.output!
    expect(output).toEqual(boundToolOutput(chunks.join('')))
    expect(output.tail!.endsWith(chunks.at(-1)!)).toBe(true)
    expect(toolOutputBytes(output)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
  })

  it('sends a delta too large for one event as the whole bounded output', () => {
    const { project, updates, states } = projector()
    project(update({ title: 'Dump', status: 'in_progress' }, 'tool_call'))
    project(appended('head\n'))
    project(appended('z'.repeat(100_000)))
    expect(updates.at(-1)!.outputDelta).toBeUndefined()
    expect(updates.at(-1)!.output).toEqual(boundToolOutput(`head\n${'z'.repeat(100_000)}`))
    expect(states.get('host-run')!.output!.text.startsWith('head\n')).toBe(true)
  })

  it('without a tracker every update replaces and a huge delta keeps its end', () => {
    const plain = (event: AgentEvent) => {
      const projected = projectAgentEvent(event, { ...context, toolCallId: 'host-run' })
      return projected?.name === 'tool.updated' ? projected.payload : undefined
    }
    expect(plain(update(resend('a')))).toMatchObject({ output: { text: 'a' } })
    const huge = plain(appended(`${'q'.repeat(50_000)}END`))!
    expect(huge.outputDelta!.endsWith('END')).toBe(true)
    expect(Buffer.byteLength(huge.outputDelta!)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
    expect(plain(appended(''))).toBeUndefined()
  })
})

describe('tool outcomes the host decides', () => {
  const event = (status: string, data: Record<string, unknown> = {}) =>
    stamp({
      workspaceId: 'w',
      sessionId: 's',
      category: 'tool',
      event: status === 'pending' ? 'tool_call' : 'tool_call_update',
      data: { toolCallId: 'call', title: 'Run', status, ...data },
    } as BackendEvent)

  it('reads a failure after a declined permission as declined', () => {
    const { project, states, tracker } = projector()
    project(event('pending'))
    tracker.decline('host-call')
    project(event('failed'))
    expect(states.get('host-call')!.status).toBe('declined')
  })

  it('reads a failure after the user asked to stop as cancelled', () => {
    const { project, states } = projector(new ToolCallTracker(), { interruptRequested: true })
    project(event('pending'))
    project(event('failed'))
    expect(states.get('host-call')!.status).toBe('cancelled')
  })

  it('settles calls still open at the end of the turn, declined ones as declined', () => {
    const tracker = new ToolCallTracker()
    const { project } = projector(tracker)
    project(
      stamp({
        workspaceId: 'w',
        sessionId: 's',
        category: 'tool',
        event: 'tool_call',
        data: { toolCallId: 'a', title: 'A', status: 'in_progress' },
      } as BackendEvent),
    )
    project(
      stamp({
        workspaceId: 'w',
        sessionId: 's',
        category: 'tool',
        event: 'tool_call',
        data: { toolCallId: 'b', title: 'B', status: 'pending' },
      } as BackendEvent),
    )
    project(
      stamp({
        workspaceId: 'w',
        sessionId: 's',
        category: 'tool',
        event: 'tool_call',
        data: { toolCallId: 'c', title: 'C', status: 'completed' },
      } as BackendEvent),
    )
    tracker.decline('host-b')
    // Declined before any tool event: there is no row to settle.
    tracker.decline('host-never-shown')
    expect(tracker.settle()).toEqual([
      { toolCallId: 'host-a', status: 'cancelled' },
      { toolCallId: 'host-b', status: 'declined' },
    ])
    expect(tracker.settle()).toEqual([])
  })
})
