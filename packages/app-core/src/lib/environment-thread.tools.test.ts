import { describe, expect, it } from 'vitest'
import { createThreadState } from '@openmanager/environment-client'
import { boundToolOutput } from '@openmanager/protocol'
import { presentToolPart } from '@openmanager/shared/lib/tool-presenter'
import { projectThread } from './environment-thread'

const THREAD = { threadId: 'thread-1', sessionId: 'session-1' }

function thread(patch: Partial<ReturnType<typeof createThreadState>> = {}) {
  return { ...createThreadState(THREAD, 'ready'), ...patch }
}

const turn = { turnId: 't1', threadId: THREAD.threadId, state: 'completed' as const }

describe('tool parts', () => {
  it('passes the payload through: name, input, output with its marker, files, lines and timing', () => {
    const output = boundToolOutput(`first\n${'x'.repeat(30_000)}\nlast`)
    const projection = projectThread(
      thread({
        turns: [turn],
        tools: [
          {
            toolCallId: 'tool-1',
            turnId: 't1',
            toolName: 'Edit',
            title: 'Edit',
            kind: 'edit',
            status: 'completed',
            input: { file_path: '/repo/a.ts' },
            output,
            locations: [{ path: '/repo/a.ts' }],
            lineChanges: { added: 4, removed: 2 },
            startedAt: '2026-10-09T10:00:00.000Z',
            finishedAt: '2026-10-09T10:00:02.500Z',
          },
        ],
      }),
    )
    const part = projection.byId.get('turn:t1:assistant')!.streaming.parts[0]!
    expect(part).toMatchObject({
      type: 'tool',
      id: 'tool-1',
      tool: 'Edit',
      toolName: 'Edit',
      kind: 'edit',
      state: { status: 'completed', input: { file_path: '/repo/a.ts' } },
      toolOutput: output,
      locations: [{ path: '/repo/a.ts' }],
      lineChanges: { added: 4, removed: 2 },
      time: {
        start: Date.parse('2026-10-09T10:00:00.000Z'),
        end: Date.parse('2026-10-09T10:00:02.500Z'),
      },
    })
    const rendered = (part.state as { output: string }).output
    expect(rendered.startsWith('first\n')).toBe(true)
    expect(rendered).toMatch(/\[\d+\.\d KB of output not shown\]/)
    expect(rendered.endsWith('\nlast')).toBe(true)
  })

  it('leads with the provider tool name and falls back to the title', () => {
    const projection = projectThread(
      thread({
        turns: [turn],
        tools: [
          {
            toolCallId: 'a',
            turnId: 't1',
            toolName: 'mcp__github__search',
            title: 'Search issues',
          },
          { toolCallId: 'b', turnId: 't1', title: 'Read file' },
        ],
      }),
    )
    const parts = projection.byId.get('turn:t1:assistant')!.streaming.parts
    expect(parts.map((part) => part.tool)).toEqual(['mcp__github__search', 'Read file'])
  })

  it('shows declined and cancelled calls as settled, not as errors', () => {
    const projection = projectThread(
      thread({
        turns: [turn],
        tools: [
          { toolCallId: 'a', turnId: 't1', toolName: 'Bash', status: 'declined' },
          { toolCallId: 'b', turnId: 't1', toolName: 'Bash', status: 'cancelled' },
          { toolCallId: 'c', turnId: 't1', toolName: 'Bash', status: 'failed' },
        ],
      }),
    )
    const parts = projection.byId.get('turn:t1:assistant')!.streaming.parts
    const statuses = parts.map((part) => (part.state as { status: string }).status)
    expect(statuses).toEqual(['declined', 'cancelled', 'error'])
    const models = parts.map((part) =>
      presentToolPart(part as Parameters<typeof presentToolPart>[0]),
    )
    expect(models.map((model) => [model.isRunning, model.isError])).toEqual([
      [false, false],
      [false, false],
      [false, true],
    ])
  })
})
