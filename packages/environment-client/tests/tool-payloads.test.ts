import { describe, expect, it } from 'vitest'
import {
  ProofEventSchema,
  TOOL_OUTPUT_MAX_BYTES,
  boundToolOutput,
  toolOutputBytes,
  type ProofEvent,
  type ToolCallState,
  type ToolCallUpdate,
} from '@openmanager/protocol'
import {
  applyEvent,
  applySessionHistory,
  applySnapshot,
  createInitialState,
  selectActiveThread,
} from '../src/state'
import type { EnvironmentState } from '../src/types'
import {
  SESSION,
  THREAD,
  WORKSPACE,
  completed,
  environmentScope,
  event,
  sessionScope,
  threadScope,
  turnStarted,
} from './fixtures'

const seeded = (): EnvironmentState => {
  let state = createInitialState()
  for (const next of [
    event({
      name: 'workspace.updated',
      scope: environmentScope,
      payload: { workspace: WORKSPACE },
    }),
    event({ name: 'session.created', scope: environmentScope, payload: { session: SESSION } }),
    event({ name: 'thread.created', scope: sessionScope, payload: { thread: THREAD } }),
  ]) {
    state = applyEvent(state, next)
  }
  return { ...state, activeSessionId: SESSION.sessionId, activeThreadId: THREAD.threadId }
}

/** A `tool.updated` as it arrives: validated against the wire schema first. */
const tool = (patch: Partial<ToolCallUpdate>): ProofEvent =>
  ProofEventSchema.parse(
    event({
      name: 'tool.updated',
      scope: threadScope,
      payload: { toolCallId: 'tool-1', turnId: 'turn-1', ...patch },
    }),
  )

const toolsOf = (state: EnvironmentState) => selectActiveThread(state)!.tools

describe('tool payloads in the client store', () => {
  it('holds the name, input and output, appends streamed output and keeps the newest past the cap', () => {
    let state = applyEvent(seeded(), turnStarted())
    state = applyEvent(
      state,
      tool({
        toolName: 'Bash',
        title: 'Bash',
        kind: 'execute',
        status: 'in_progress',
        input: { command: 'pnpm build' },
        locations: [{ path: '/repo/package.json' }],
        startedAt: '2026-10-09T10:00:00.000Z',
      }),
    )
    const lines = Array.from(
      { length: 300 },
      (_, index) => `compiled module ${index} ${'.'.repeat(60)}\n`,
    )
    for (const line of lines) state = applyEvent(state, tool({ outputDelta: line }))
    state = applyEvent(
      state,
      tool({
        status: 'completed',
        lineChanges: { added: 1, removed: 0 },
        finishedAt: '2026-10-09T10:00:09.000Z',
      }),
    )

    const [held] = toolsOf(state)
    expect(held).toEqual({
      toolCallId: 'tool-1',
      turnId: 'turn-1',
      toolName: 'Bash',
      title: 'Bash',
      kind: 'execute',
      status: 'completed',
      input: { command: 'pnpm build' },
      locations: [{ path: '/repo/package.json' }],
      lineChanges: { added: 1, removed: 0 },
      output: boundToolOutput(lines.join('')),
      startedAt: '2026-10-09T10:00:00.000Z',
      finishedAt: '2026-10-09T10:00:09.000Z',
    })
    expect(held!.output!.tail!.endsWith(lines.at(-1)!)).toBe(true)
    expect(toolOutputBytes(held!.output!)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
    // The delta is applied to the held output, never kept beside it.
    expect(held).not.toHaveProperty('outputDelta')
  })

  it('keeps declined and cancelled as outcomes of their own, past later updates', () => {
    let state = applyEvent(seeded(), turnStarted())
    state = applyEvent(state, tool({ toolCallId: 'refused', status: 'pending' }))
    state = applyEvent(state, tool({ toolCallId: 'refused', status: 'declined' }))
    state = applyEvent(state, tool({ toolCallId: 'stopped', status: 'in_progress' }))
    state = applyEvent(state, tool({ toolCallId: 'stopped', status: 'cancelled' }))
    // A straggling progress update does not reopen either.
    state = applyEvent(state, tool({ toolCallId: 'refused', status: 'in_progress' }))
    state = applyEvent(state, completed())
    expect(toolsOf(state).map((item) => [item.toolCallId, item.status])).toEqual([
      ['refused', 'declined'],
      ['stopped', 'cancelled'],
    ])
  })

  it('hydrates payloads from a history page, then streams onto them', () => {
    const running: ToolCallState = {
      toolCallId: 'tool-1',
      turnId: 'turn-1',
      toolName: 'Bash',
      status: 'in_progress',
      input: { command: 'make' },
      output: { text: 'step 1\n' },
      startedAt: '2026-10-09T10:00:00.000Z',
    }
    const elided: ToolCallState = {
      toolCallId: 'tool-0',
      turnId: 'turn-1',
      toolName: 'Read',
      status: 'completed',
      output: { text: '', omittedBytes: 20_000 },
    }
    let state = applySessionHistory(seeded(), THREAD, {
      messages: [],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'running' }],
      interactions: [],
      nextCursor: null,
      reasoning: [],
      tools: [elided, running],
      order: [
        { kind: 'tool', id: 'tool-0', turnId: 'turn-1' },
        { kind: 'tool', id: 'tool-1', turnId: 'turn-1' },
      ],
    })
    expect(toolsOf(state)).toEqual([elided, running])
    state = applyEvent(state, tool({ outputDelta: 'step 2\n' }))
    expect(toolsOf(state)[1]!.output).toEqual({ text: 'step 1\nstep 2\n' })
    expect(toolsOf(state)[0]).toEqual(elided)
  })

  it('a late joiner reads payloads from the snapshot and keeps folding live events', () => {
    const turn = { turnId: 'turn-1', threadId: THREAD.threadId, state: 'running' as const }
    const truncated = boundToolOutput(`head\n${'x'.repeat(40_000)}`)
    let state = applySnapshot(seeded(), {
      cursor: { scope: threadScope, epoch: 'epoch', sequence: 40 },
      state: {
        thread: THREAD,
        turns: [turn],
        messages: [
          {
            messageId: 'reply-1',
            threadId: THREAD.threadId,
            turnId: 'turn-1',
            role: 'assistant',
            content: [
              {
                type: 'artifact',
                artifactId: 'image-1',
                mimeType: 'image/png',
                name: 'chart.png',
                sizeBytes: 10,
                toolCallId: 'tool-1',
              },
            ],
          },
        ],
        reasoning: [],
        tools: [
          {
            toolCallId: 'tool-1',
            turnId: 'turn-1',
            toolName: 'Bash',
            status: 'in_progress',
            output: truncated,
          },
        ],
        order: [{ kind: 'tool', id: 'tool-1', turnId: 'turn-1' }],
        interactions: [],
      },
    })
    state = applyEvent(state, tool({ outputDelta: '\nnewest' }))
    const output = toolsOf(state)[0]!.output!
    expect(output.text.startsWith('head\n')).toBe(true)
    expect(output.tail!.endsWith('\nnewest')).toBe(true)
    expect(output.omittedBytes).toBeGreaterThan(truncated.omittedBytes!)
    // A tool-made image keeps naming the call it came from.
    expect(selectActiveThread(state)!.messages[0]!.content[0]).toMatchObject({
      type: 'artifact',
      toolCallId: 'tool-1',
    })
  })
})
