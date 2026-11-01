import { describe, expect, it } from 'vitest'
import {
  ProofEventSchemas,
  ToolCallUpdateSchema,
  applyToolUpdate,
  toolOutputPath,
  type ToolCallState,
} from '../src/index.js'

const base = { toolCallId: 'tool-1', turnId: 'turn-1' }

describe('applyToolUpdate', () => {
  it('fills in and revises fields, and keeps what an update leaves out', () => {
    const first = applyToolUpdate(undefined, {
      ...base,
      toolName: 'Bash',
      title: 'Bash',
      status: 'pending',
      startedAt: '2026-11-01T00:00:00.000Z',
    })
    const next = applyToolUpdate(first, {
      ...base,
      status: 'in_progress',
      input: { command: 'ls' },
      startedAt: '2026-11-01T00:00:09.000Z',
    })
    expect(next).toEqual({
      ...base,
      toolName: 'Bash',
      title: 'Bash',
      status: 'in_progress',
      input: { command: 'ls' },
      startedAt: '2026-11-01T00:00:00.000Z',
    })
  })

  it('appends deltas and replaces on a whole output', () => {
    let tool = applyToolUpdate(undefined, { ...base, status: 'in_progress', outputDelta: 'a' })
    tool = applyToolUpdate(tool, { ...base, outputDelta: 'b' })
    expect(tool.output).toBe('ab')
    expect(applyToolUpdate(tool, { ...base, output: 'c' }).output).toBe('c')
  })

  it('drops the running text when the call settles, and says how much there is', () => {
    const running: ToolCallState = { ...base, status: 'in_progress', output: 'partial' }
    expect(
      applyToolUpdate(running, {
        ...base,
        status: 'completed',
        outputBytes: 7,
        finishedAt: '2026-11-01T00:00:01.000Z',
      }),
    ).toEqual({
      ...base,
      status: 'completed',
      outputBytes: 7,
      finishedAt: '2026-11-01T00:00:01.000Z',
    })
  })

  it('never reopens a settled call, whatever arrives late', () => {
    const declined: ToolCallState = {
      ...base,
      status: 'declined',
      finishedAt: '2026-11-01T00:00:01.000Z',
    }
    const late = applyToolUpdate(declined, {
      ...base,
      status: 'in_progress',
      outputDelta: 'late',
      finishedAt: '2026-11-01T00:00:09.000Z',
    })
    expect(late).toEqual(declined)
    expect(applyToolUpdate(declined, { ...base, status: 'failed', outputBytes: 3 })).toEqual({
      ...declined,
      outputBytes: 3,
    })
  })
})

describe('tool.updated', () => {
  it('refuses text on the update that settles a call', () => {
    expect(
      ToolCallUpdateSchema.safeParse({ ...base, status: 'completed', output: 'x' }).success,
    ).toBe(false)
    expect(
      ToolCallUpdateSchema.safeParse({ ...base, status: 'cancelled', outputDelta: 'x' }).success,
    ).toBe(false)
    expect(
      ToolCallUpdateSchema.safeParse({ ...base, status: 'in_progress', output: 'x' }).success,
    ).toBe(true)
  })

  it('refuses a replace and an append together', () => {
    expect(ToolCallUpdateSchema.safeParse({ ...base, output: 'x', outputDelta: 'y' }).success).toBe(
      false,
    )
  })

  it('has no size limit on running text', () => {
    const output = 'x'.repeat(2_000_000)
    expect(ToolCallUpdateSchema.parse({ ...base, output }).output).toHaveLength(2_000_000)
    expect(ProofEventSchemas['tool.updated']).toBeDefined()
  })

  it('addresses output by session and call', () => {
    expect(toolOutputPath('s/1', 'tool 1')).toBe('/tool-output/s%2F1/tool%201')
  })
})
