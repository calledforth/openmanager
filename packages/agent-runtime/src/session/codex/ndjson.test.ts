import { describe, expect, it, vi } from 'vitest'
import { LineDecoder, OVERSIZE_HEAD_CHARS } from './ndjson.js'

function decoder(options?: ConstructorParameters<typeof LineDecoder>[1]) {
  const lines: string[] = []
  const lineDecoder = new LineDecoder((line) => lines.push(line), options)
  return { lines, decoder: lineDecoder }
}

describe('LineDecoder framing', () => {
  it('drops the \\r of a CRLF line ending', () => {
    const { lines, decoder: d } = decoder()
    d.push('{"a":1}\r\n{"b":2}\r\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('drops a \\r that arrived in the chunk before its \\n', () => {
    // A Windows build's CRLF can straddle a pipe read.
    const { lines, decoder: d } = decoder()
    d.push('{"a":1}\r')
    d.push('\n')
    expect(lines).toEqual(['{"a":1}'])
  })

  it('joins a line split across many chunks', () => {
    const { lines, decoder: d } = decoder()
    const line = '{"method":"item/agentMessage/delta","params":{"delta":"hello world"}}'
    for (const ch of line) d.push(ch)
    expect(lines).toEqual([])
    d.push('\n')
    expect(lines).toEqual([line])
  })

  it('emits every message of a chunk that holds several', () => {
    const { lines, decoder: d } = decoder()
    d.push('{"a":1}\n{"b":2}\n{"c":')
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    d.push('3}\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  it('skips blank and whitespace-only lines', () => {
    const { lines, decoder: d } = decoder()
    d.push('\n\r\n   \n{"a":1}\n\t\n')
    expect(lines).toEqual(['{"a":1}'])
  })

  it('flushes a final line without a trailing newline on end()', () => {
    // The process can exit mid-write; whatever made it out is still a message.
    const { lines, decoder: d } = decoder()
    d.push('{"a":1}\n{"b":2}')
    expect(lines).toEqual(['{"a":1}'])
    d.end()
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('emits nothing on end() when the stream ended on a newline', () => {
    const { lines, decoder: d } = decoder()
    d.push('{"a":1}\n')
    d.end()
    expect(lines).toEqual(['{"a":1}'])
  })
})

describe('LineDecoder UTF-8', () => {
  it('decodes a multi-byte character split across two Buffer chunks', () => {
    const { lines, decoder: d } = decoder()
    const bytes = Buffer.from('{"t":"€"}\n', 'utf8')
    const euro = bytes.indexOf(0xe2)
    // Cut after the first of the three bytes of €.
    d.push(bytes.subarray(0, euro + 1))
    d.push(bytes.subarray(euro + 1))
    expect(lines).toEqual(['{"t":"€"}'])
    expect(lines[0]).not.toContain('�')
  })

  it('decodes a four-byte character delivered one byte at a time', () => {
    const { lines, decoder: d } = decoder()
    const bytes = Buffer.from('{"t":"😀"}\n', 'utf8')
    for (let i = 0; i < bytes.length; i++) d.push(bytes.subarray(i, i + 1))
    expect(lines).toEqual(['{"t":"😀"}'])
  })

  it('decodes a split character held back until end()', () => {
    const { lines, decoder: d } = decoder()
    const bytes = Buffer.from('ü', 'utf8')
    d.push(bytes.subarray(0, 1))
    d.push(bytes.subarray(1))
    d.end()
    expect(lines).toEqual(['ü'])
  })
})

describe('LineDecoder large lines', () => {
  it('assembles a ~20 MB line from 64 KB chunks in linear time', () => {
    // A tool result carrying a whole file. Appending to one string and
    // rescanning it per chunk is quadratic and takes seconds at this size.
    const { lines, decoder: d } = decoder()
    const size = 20 * 1024 * 1024
    const payload = Buffer.alloc(size, 'x')
    const chunk = 64 * 1024
    const started = performance.now()
    for (let offset = 0; offset < size; offset += chunk) d.push(payload.subarray(offset, offset + chunk))
    d.push(Buffer.from('\n'))
    const elapsed = performance.now() - started
    expect(lines).toHaveLength(1)
    expect(lines[0]!.length).toBe(size)
    expect(elapsed).toBeLessThan(2_000)
  })

  it('discards a line over maxLineChars, reports its size and head, and parses the next', () => {
    const onOversize = vi.fn()
    const { lines, decoder: d } = decoder({ maxLineChars: 100, onOversize })
    d.push('{"ok":1}\n')
    // 250 chars over three chunks: the cap trips in the middle one.
    d.push('a'.repeat(80))
    d.push('b'.repeat(80))
    d.push('c'.repeat(90))
    d.push('\n{"ok":2}\n')
    expect(onOversize).toHaveBeenCalledTimes(1)
    // The head is what was held when the cap tripped: enough for the reader
    // to see whose message it was.
    expect(onOversize).toHaveBeenCalledWith(250, 'a'.repeat(80) + 'b'.repeat(80))
    expect(lines).toEqual(['{"ok":1}', '{"ok":2}'])
  })

  it('caps the reported head at OVERSIZE_HEAD_CHARS and starts afresh for the next line', () => {
    const onOversize = vi.fn()
    const { decoder: d } = decoder({ maxLineChars: 5_000, onOversize })
    const first = `{"id":7,"result":"${'y'.repeat(9_000)}"}`
    d.push(`${first}\n`)
    d.push(`{"id":8,${'z'.repeat(6_000)}\n`)
    expect(onOversize).toHaveBeenCalledTimes(2)
    const [[firstChars, firstHead], [, secondHead]] = onOversize.mock.calls as [number, string][]
    expect(firstChars).toBe(first.length)
    expect(firstHead).toBe(first.slice(0, OVERSIZE_HEAD_CHARS))
    // Nothing of the first line leaks into the second's head.
    expect(secondHead.startsWith('{"id":8,')).toBe(true)
  })

  it('keeps a line exactly at maxLineChars', () => {
    const onOversize = vi.fn()
    const { lines, decoder: d } = decoder({ maxLineChars: 10, onOversize })
    d.push('0123456789\n')
    expect(lines).toEqual(['0123456789'])
    expect(onOversize).not.toHaveBeenCalled()
  })

  it('reports an oversize final line flushed by end()', () => {
    const onOversize = vi.fn()
    const { lines, decoder: d } = decoder({ maxLineChars: 10, onOversize })
    d.push('x'.repeat(25))
    d.end()
    expect(onOversize).toHaveBeenCalledWith(25, 'x'.repeat(25))
    expect(lines).toEqual([])
  })
})
