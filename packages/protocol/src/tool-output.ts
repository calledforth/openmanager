/**
 * Bounds for what one tool call carries on the wire, and the pure functions
 * that keep it inside them. The environment and every client run the same
 * functions, so a stored tool call and a client that folded the live events
 * hold the same output byte for byte.
 *
 * Every size here is measured as JSON-encoded UTF-8 bytes, the way the value
 * travels in a socket frame: a newline or a quote costs two bytes there, a
 * control character six.
 */

/** The most one tool call's output takes on the wire, its truncation marker included. */
export const TOOL_OUTPUT_MAX_BYTES = 16 * 1024
/** How much of the start of an output survives once it is truncated. */
export const TOOL_OUTPUT_HEAD_BYTES = 4 * 1024
/** Room kept for the output object's keys, quotes and the omitted-byte count. */
const TOOL_OUTPUT_OVERHEAD_BYTES = 64
/** How much of the newest end of an output survives once it is truncated. */
export const TOOL_OUTPUT_TAIL_BYTES =
  TOOL_OUTPUT_MAX_BYTES - TOOL_OUTPUT_HEAD_BYTES - TOOL_OUTPUT_OVERHEAD_BYTES
/** The most one tool call's input takes on the wire. */
export const TOOL_INPUT_MAX_BYTES = 4 * 1024
/** The longest single string an input keeps before it is cut short. */
export const TOOL_INPUT_STRING_MAX_BYTES = 2 * 1024
/** The most files one tool call names. */
export const TOOL_LOCATIONS_MAX = 16
/** A path longer than this is dropped from a tool's locations rather than cut. */
export const TOOL_LOCATION_PATH_MAX_LENGTH = 1024
/** The longest provider tool name kept. MCP names are `mcp__<server>__<tool>`. */
export const TOOL_NAME_MAX_LENGTH = 256
/** Ends a string the input bound cut short. */
export const TOOL_INPUT_TRUNCATION_SUFFIX = '…'

/**
 * A tool call's output, bounded. `text` is the whole output while it fits;
 * once it does not, `text` keeps the start, `tail` the newest end, and
 * `omittedBytes` says how many UTF-8 bytes were left out between them.
 */
export type ToolOutput = {
  text: string
  omittedBytes?: number
  tail?: string
}

export type ToolJsonValue =
  string | number | boolean | null | ToolJsonValue[] | { [key: string]: ToolJsonValue }

/** Bytes one UTF-16 code unit (or a surrogate pair) costs inside a JSON string. */
function unitCost(text: string, index: number): { cost: number; width: 1 | 2 } {
  const code = text.charCodeAt(index)
  if (code === 0x22 || code === 0x5c) return { cost: 2, width: 1 }
  if (code < 0x20) {
    // \b \t \n \f \r have short escapes; every other control character is \u00XX.
    const short = code === 8 || code === 9 || code === 10 || code === 12 || code === 13
    return { cost: short ? 2 : 6, width: 1 }
  }
  if (code < 0x80) return { cost: 1, width: 1 }
  if (code < 0x800) return { cost: 2, width: 1 }
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) return { cost: 4, width: 2 }
    // A lone surrogate is escaped as \uXXXX by JSON.stringify.
    return { cost: 6, width: 1 }
  }
  if (code >= 0xdc00 && code <= 0xdfff) return { cost: 6, width: 1 }
  return { cost: 3, width: 1 }
}

/** JSON-encoded UTF-8 bytes of `text` as a string value, without its quotes. */
export function jsonStringBytes(text: string): number {
  let total = 0
  for (let index = 0; index < text.length;) {
    const unit = unitCost(text, index)
    total += unit.cost
    index += unit.width
  }
  return total
}

/** Plain UTF-8 bytes of `text`; what an omitted count reports. */
export function utf8Bytes(text: string): number {
  let total = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) total += 1
    else if (code < 0x800) total += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        total += 4
        index += 1
      } else total += 3
    } else total += 3
  }
  return total
}

/** The end of the longest prefix of `text` costing at most `budget`; never splits a pair. */
function prefixEnd(text: string, budget: number): number {
  let spent = 0
  let index = 0
  while (index < text.length) {
    const unit = unitCost(text, index)
    if (spent + unit.cost > budget) break
    spent += unit.cost
    index += unit.width
  }
  return index
}

/**
 * The start of the longest suffix of `text` costing at most `budget`, never
 * reaching before `floor` and never splitting a surrogate pair.
 */
function suffixStart(text: string, budget: number, floor: number): number {
  let spent = 0
  let index = text.length
  while (index > floor) {
    const low = text.charCodeAt(index - 1)
    const high = index - 2 >= floor ? text.charCodeAt(index - 2) : -1
    const pair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff
    const width = pair ? 2 : 1
    const cost = unitCost(text, index - width).cost
    if (spent + cost > budget) break
    spent += cost
    index -= width
  }
  return index
}

/** The output of a tool as one bounded value: the start and the newest end. */
export function boundToolOutput(text: string): ToolOutput {
  if (jsonStringBytes(text) <= TOOL_OUTPUT_MAX_BYTES - TOOL_OUTPUT_OVERHEAD_BYTES) return { text }
  const headEnd = prefixEnd(text, TOOL_OUTPUT_HEAD_BYTES)
  const tailStart = suffixStart(text, TOOL_OUTPUT_TAIL_BYTES, headEnd)
  return {
    text: text.slice(0, headEnd),
    omittedBytes: utf8Bytes(text.slice(headEnd, tailStart)),
    tail: text.slice(tailStart),
  }
}

/**
 * Append newly streamed output. The start stays put; past the cap the newest
 * end keeps moving, so a live viewer always sees the latest output.
 */
export function appendToolOutput(output: ToolOutput | undefined, delta: string): ToolOutput {
  if (!output) return boundToolOutput(delta)
  if (!delta) return output
  if (output.omittedBytes === undefined) return boundToolOutput(output.text + delta)
  const tail = (output.tail ?? '') + delta
  const start = suffixStart(tail, TOOL_OUTPUT_TAIL_BYTES, 0)
  if (start === 0) return { text: output.text, omittedBytes: output.omittedBytes, tail }
  return {
    text: output.text,
    omittedBytes: output.omittedBytes + utf8Bytes(tail.slice(0, start)),
    tail: tail.slice(start),
  }
}

/** Encoded bytes of the output object as it travels. */
export function toolOutputBytes(output: ToolOutput): number {
  return utf8Bytes(JSON.stringify(output))
}

/**
 * Cut an output further, to fit `budget` encoded bytes: a history page that
 * cannot carry every output whole. A quarter of the room keeps the start and
 * the rest the newest end, the way the live bound splits it.
 */
export function shrinkToolOutput(output: ToolOutput, budget: number): ToolOutput {
  const room = Math.max(0, budget - TOOL_OUTPUT_OVERHEAD_BYTES)
  const tail = output.tail ?? ''
  if (jsonStringBytes(output.text) + jsonStringBytes(tail) <= room) return output
  const headEnd = prefixEnd(output.text, Math.floor(room / 4))
  const head = output.text.slice(0, headEnd)
  const tailRoom = room - jsonStringBytes(head)
  if (output.omittedBytes === undefined) {
    const tailStart = suffixStart(output.text, tailRoom, headEnd)
    return {
      text: head,
      omittedBytes: utf8Bytes(output.text.slice(headEnd, tailStart)),
      tail: output.text.slice(tailStart),
    }
  }
  const tailStart = suffixStart(tail, tailRoom, 0)
  return {
    text: head,
    omittedBytes:
      output.omittedBytes +
      utf8Bytes(output.text.slice(headEnd)) +
      utf8Bytes(tail.slice(0, tailStart)),
    tail: tail.slice(tailStart),
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The output as one string, with a marker where the middle was left out. */
export function renderToolOutput(output: ToolOutput): string {
  if (output.omittedBytes === undefined) return output.text
  return `${output.text}\n[${formatBytes(output.omittedBytes)} of output not shown]\n${output.tail ?? ''}`
}

function boundString(value: string, limit: number): string {
  if (jsonStringBytes(value) <= limit) return value
  return value.slice(0, prefixEnd(value, Math.max(0, limit - 3))) + TOOL_INPUT_TRUNCATION_SUFFIX
}

const INPUT_MAX_DEPTH = 8
const INPUT_MAX_ENTRIES = 64

function boundJson(value: unknown, limit: number, depth: number): ToolJsonValue | undefined {
  if (value === null) return null
  switch (typeof value) {
    case 'string':
      return boundString(value, limit)
    case 'number':
      return Number.isFinite(value) ? value : undefined
    case 'boolean':
      return value
    case 'object': {
      if (depth >= INPUT_MAX_DEPTH) return undefined
      if (Array.isArray(value)) {
        return value
          .slice(0, INPUT_MAX_ENTRIES)
          .map((item) => boundJson(item, limit, depth + 1) ?? null)
      }
      const bounded: { [key: string]: ToolJsonValue } = {}
      let entries = 0
      for (const [key, item] of Object.entries(value)) {
        if (entries >= INPUT_MAX_ENTRIES) break
        const next = boundJson(item, limit, depth + 1)
        if (next === undefined) continue
        bounded[key] = next
        entries += 1
      }
      return bounded
    }
    default:
      return undefined
  }
}

/**
 * A tool's input as a bounded JSON value: each string cut to a few KiB, and
 * cut shorter until the whole fits. Undefined when nothing JSON-shaped is
 * left, or when even short strings cannot fit (an input of thousands of keys).
 */
export function boundToolInput(value: unknown): ToolJsonValue | undefined {
  for (let limit = TOOL_INPUT_STRING_MAX_BYTES; limit >= 64; limit = Math.floor(limit / 2)) {
    const bounded = boundJson(value, limit, 0)
    if (bounded === undefined) return undefined
    if (utf8Bytes(JSON.stringify(bounded)) <= TOOL_INPUT_MAX_BYTES) return bounded
  }
  return undefined
}
