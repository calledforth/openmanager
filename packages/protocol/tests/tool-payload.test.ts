import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  ProofEventSchema,
  TOOL_INPUT_MAX_BYTES,
  TOOL_OUTPUT_HEAD_BYTES,
  TOOL_OUTPUT_MAX_BYTES,
  ToolCallStateSchema,
  ToolCallUpdateSchema,
  appendToolOutput,
  applyToolUpdate,
  boundToolInput,
  boundToolOutput,
  isTerminalToolStatus,
  jsonStringBytes,
  renderToolOutput,
  shrinkToolOutput,
  toolOutputBytes,
  utf8Bytes,
  type ToolCallState,
} from '@openmanager/protocol'

const encoded = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** Text that exercises every cost class: ASCII, escapes, control characters, CJK, emoji. */
function mixed(length: number): string {
  const alphabet = ['a', 'b', '"', '\\', '\n', '\t', '\u0001', 'é', '中', '😀', ' ']
  let text = ''
  for (let index = 0; text.length < length; index += 1) {
    text += alphabet[(index * 7 + Math.floor(index / 3)) % alphabet.length]
  }
  return text
}

describe('tool output bound', () => {
  it('measures strings as JSON-encoded UTF-8 bytes', () => {
    for (const sample of [
      'plain',
      'quote " and \\ slash',
      'line\nbreak\u0001',
      '中文',
      '😀',
      mixed(500),
    ]) {
      expect(jsonStringBytes(sample)).toBe(encoded(sample) - 2)
      expect(utf8Bytes(sample)).toBe(Buffer.byteLength(sample, 'utf8'))
    }
  })

  it('keeps an output that fits whole', () => {
    expect(boundToolOutput('ok\n')).toEqual({ text: 'ok\n' })
  })

  it('keeps the start and the newest end of a long output, inside the cap', () => {
    for (const text of ['x'.repeat(100_000), mixed(60_000), '\n'.repeat(40_000)]) {
      const output = boundToolOutput(text)
      expect(toolOutputBytes(output)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
      expect(encoded(output)).toBe(toolOutputBytes(output))
      expect(jsonStringBytes(output.text)).toBeLessThanOrEqual(TOOL_OUTPUT_HEAD_BYTES)
      expect(text.startsWith(output.text)).toBe(true)
      expect(text.endsWith(output.tail!)).toBe(true)
      const omitted = text.slice(output.text.length, text.length - output.tail!.length)
      expect(output.omittedBytes).toBe(Buffer.byteLength(omitted, 'utf8'))
      expect(output.omittedBytes).toBeGreaterThan(0)
    }
  })

  it('never splits a surrogate pair', () => {
    const output = boundToolOutput('😀'.repeat(20_000))
    expect(output.text).not.toMatch(/[\ud800-\udbff]$/)
    expect(output.tail).not.toMatch(/^[\udc00-\udfff]/)
  })

  it('streams to the same result as bounding the whole output, however it is chunked', () => {
    const stream = (text: string, size: number) => {
      let output: ReturnType<typeof boundToolOutput> | undefined
      for (let index = 0; index < text.length; index += size) {
        output = appendToolOutput(output, text.slice(index, index + size))
      }
      return output
    }
    // One character at a time crosses the cap at every possible boundary.
    const short = mixed(14_000)
    expect(jsonStringBytes(short)).toBeGreaterThan(TOOL_OUTPUT_MAX_BYTES)
    expect(stream(short, 1)).toEqual(boundToolOutput(short))
    const text = mixed(70_000)
    for (const size of [97, 333, 4096, 20_000]) {
      expect(stream(text, size)).toEqual(boundToolOutput(text))
    }
  })

  it('keeps the newest output visible once past the cap', () => {
    let output = boundToolOutput('start\n' + 'x'.repeat(40_000))
    output = appendToolOutput(output, '\nnewest line')
    expect(output.text.startsWith('start\n')).toBe(true)
    expect(output.tail!.endsWith('\nnewest line')).toBe(true)
    expect(renderToolOutput(output)).toMatch(
      /^start\n[\s\S]*\[\d+\.\d KB of output not shown\]\n[\s\S]*newest line$/,
    )
    expect(toolOutputBytes(output)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
  })

  it('shrinks an output to a smaller budget and counts what it drops', () => {
    const text = mixed(30_000)
    for (const output of [boundToolOutput(text), boundToolOutput(text.slice(0, 5_000))]) {
      for (const budget of [8_000, 1_000, 100, 0]) {
        const shrunk = shrinkToolOutput(output, budget)
        expect(toolOutputBytes(shrunk)).toBeLessThanOrEqual(Math.max(budget, 64))
        const kept =
          utf8Bytes(shrunk.text) + utf8Bytes(shrunk.tail ?? '') + (shrunk.omittedBytes ?? 0)
        const before =
          utf8Bytes(output.text) + utf8Bytes(output.tail ?? '') + (output.omittedBytes ?? 0)
        expect(kept).toBe(before)
      }
    }
    expect(shrinkToolOutput({ text: 'small' }, 1_000)).toEqual({ text: 'small' })
  })
})

describe('tool input bound', () => {
  it('cuts long strings and keeps the whole input inside the cap', () => {
    const input = {
      command: 'echo ' + 'x'.repeat(10_000),
      description: 'Run it',
      args: Array.from({ length: 200 }, (_, index) => `arg-${index}-${'y'.repeat(50)}`),
      nested: { deep: { value: 1, flag: true, none: null, skipped: undefined } },
    }
    const bounded = boundToolInput(input) as Record<string, unknown>
    expect(encoded(bounded)).toBeLessThanOrEqual(TOOL_INPUT_MAX_BYTES)
    expect((bounded.command as string).endsWith('…')).toBe(true)
    expect(bounded.description).toBe('Run it')
    expect(bounded.nested).toEqual({ deep: { value: 1, flag: true, none: null } })
    expect(ToolCallStateSchema.parse({ toolCallId: 't', turnId: 'u', input: bounded })).toBeTruthy()
  })

  it('leaves a small input untouched and drops what is not JSON', () => {
    expect(boundToolInput({ file_path: '/a/b.ts', limit: 20 })).toEqual({
      file_path: '/a/b.ts',
      limit: 20,
    })
    expect(boundToolInput(undefined)).toBeUndefined()
    expect(boundToolInput(() => 1)).toBeUndefined()
    expect(boundToolInput(Number.NaN)).toBeUndefined()
  })
})

describe('tool call state', () => {
  const base: ToolCallState = { toolCallId: 'tool-1', turnId: 'turn-1' }

  it('fills fields in, replaces output, appends deltas and keeps the first times', () => {
    let state = applyToolUpdate(undefined, {
      ...base,
      toolName: 'Bash',
      kind: 'execute',
      status: 'pending',
      input: { command: 'ls' },
      startedAt: '2026-10-09T10:00:00.000Z',
    })
    state = applyToolUpdate(state, { ...base, status: 'in_progress', outputDelta: 'a\n' })
    state = applyToolUpdate(state, { ...base, outputDelta: 'b\n' })
    expect(state.output).toEqual({ text: 'a\nb\n' })
    state = applyToolUpdate(state, { ...base, output: { text: 'replaced' } })
    state = applyToolUpdate(state, {
      ...base,
      status: 'completed',
      finishedAt: '2026-10-09T10:00:05.000Z',
      startedAt: '2026-10-09T11:00:00.000Z',
    })
    expect(state).toEqual({
      ...base,
      toolName: 'Bash',
      kind: 'execute',
      status: 'completed',
      input: { command: 'ls' },
      output: { text: 'replaced' },
      startedAt: '2026-10-09T10:00:00.000Z',
      finishedAt: '2026-10-09T10:00:05.000Z',
    })
  })

  it('keeps a final status, declined and cancelled included', () => {
    for (const status of ['completed', 'failed', 'declined', 'cancelled'] as const) {
      expect(isTerminalToolStatus(status)).toBe(true)
      const settled = applyToolUpdate(undefined, { ...base, status })
      expect(applyToolUpdate(settled, { ...base, status: 'in_progress' }).status).toBe(status)
    }
    expect(isTerminalToolStatus('in_progress')).toBe(false)
  })

  it('accepts declined and cancelled on the wire, and refuses an output both replaced and appended', () => {
    const event = (payload: Record<string, unknown>) => ({
      type: 'event',
      name: 'tool.updated',
      eventId: 'event-1',
      timestamp: '2026-10-09T10:00:00.000Z',
      scope: { type: 'thread', environmentId: 'env', sessionId: 'session', threadId: 'thread' },
      payload: { ...base, ...payload },
    })
    expect(ProofEventSchema.safeParse(event({ status: 'declined' })).success).toBe(true)
    expect(ProofEventSchema.safeParse(event({ status: 'cancelled' })).success).toBe(true)
    expect(
      ToolCallUpdateSchema.safeParse({ ...base, output: { text: 'a' }, outputDelta: 'b' }).success,
    ).toBe(false)
    expect(
      ToolCallUpdateSchema.safeParse({ ...base, output: { text: 'a', tail: 'b' } }).success,
    ).toBe(false)
    expect(PROTOCOL_VERSION).toBe(17)
  })
})
