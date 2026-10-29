import { describe, expect, it } from 'vitest'
import {
  FLOW_POLICY,
  FRAGMENT_LAST,
  FRAGMENT_MORE,
  FragmentAssembler,
  FramingError,
  fragmentBytesFor,
  utf8Length,
} from '@openmanager/protocol'

describe('fragment size', () => {
  it('starts at 1 KiB and follows two seconds of the measured rate', () => {
    expect(fragmentBytesFor(undefined)).toBe(1024)
    expect(fragmentBytesFor(300)).toBe(600)
    expect(fragmentBytesFor(1024)).toBe(2048)
  })

  it.each([0, 1, 100, 1e3, 1e5, 1e9, Number.POSITIVE_INFINITY])(
    'stays within 512 B and 8 KiB at %d B/s',
    (rate) => {
      const size = fragmentBytesFor(rate)
      expect(size).toBeGreaterThanOrEqual(FLOW_POLICY.minFragmentBytes)
      expect(size).toBeLessThanOrEqual(FLOW_POLICY.maxFragmentBytes)
    },
  )
})

describe('utf8Length', () => {
  it.each([
    '',
    'plain',
    'é',
    '€',
    '😀',
    'a😀é€\n"' + String.fromCharCode(92),
    JSON.stringify('\ud800 lone'),
  ])('equals the encoded length of %j', (text) => {
    expect(utf8Length(text)).toBe(new TextEncoder().encode(text).byteLength)
  })
})

describe('FragmentAssembler', () => {
  const encode = (text: string) => new TextEncoder().encode(text)
  const frame = (flag: number, bytes: Uint8Array) => {
    const out = new Uint8Array(bytes.byteLength + 1)
    out[0] = flag
    out.set(bytes, 1)
    return out
  }

  it('returns the whole message at the last fragment, across a split character', () => {
    const bytes = encode('{"text":"a😀b"}')
    const assembler = new FragmentAssembler()
    // Cut inside the four-byte emoji.
    expect(assembler.push(frame(FRAGMENT_MORE, bytes.subarray(0, 11)))).toBeUndefined()
    expect(assembler.partial).toBe(true)
    const whole = assembler.push(frame(FRAGMENT_LAST, bytes.subarray(11)))
    expect(new TextDecoder().decode(whole)).toBe('{"text":"a😀b"}')
    expect(assembler.partial).toBe(false)
  })

  it('rejects an unknown flag and an empty frame', () => {
    const assembler = new FragmentAssembler()
    expect(() => assembler.push(new Uint8Array([7, 1]))).toThrow(FramingError)
    expect(() => assembler.push(new Uint8Array([]))).toThrow(FramingError)
  })
})
