/**
 * A reply cut into its top-level markdown blocks, so a long one is drawn as
 * many small trees rather than one. A streamed token then costs only the
 * block it lands in: the blocks before it are finished, and parsed and drawn
 * once. Without this every token parsed the whole reply again, and the reply
 * settling drew it all once more.
 *
 * Reading a growing text is append-only, so the scanner picks up where it
 * stopped rather than scanning again. A cut goes only where the two halves
 * parse the way the whole would: at a blank line, outside a code fence, before
 * a line that is not a continuation of what came before. Reference links are
 * the one thing that crosses blocks, so a text that defines one stays whole.
 */

export interface MarkdownBlocks {
  /** The finished blocks. The same array until one more finishes. */
  closed: readonly string[]
  /** The block still being written: the last one, whatever the state of the text. */
  tail: string
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])[ \t]/
const REFERENCE = /^ {0,3}\[[^\]]+\]:/

const NO_BLOCKS: readonly string[] = []

/** A block is at least this long: every block costs a tree of its own to mount. */
export const MIN_BLOCK_CHARS = 600

/**
 * Keys a parsed tree by each node's place in it. The library hands every node
 * a new key on every parse, so the block being written would unmount and mount
 * all of its native views on every token; by place, React updates what is
 * already on screen.
 */
export function keyByPlace<T extends { key: string; children: T[] }>(nodes: T[], prefix = ''): T[] {
  nodes.forEach((node, index) => {
    node.key = `${prefix}${index}`
    keyByPlace(node.children, `${node.key}.`)
  })
  return nodes
}

/** Reads one text as it grows. A text that is not an extension of the last starts over. */
export function createMarkdownScanner(minChars = MIN_BLOCK_CHARS) {
  let read = ''
  /** Where the next unread line starts. */
  let cursor = 0
  /** Where the block being written starts. */
  let blockStart = 0
  /** The last line outside any indentation belongs to a list. */
  let inList = false
  let blockHasLine = false
  /** The fence the cursor is inside: its character and length. */
  let fence: { char: string; size: number } | null = null
  let afterBlank = false
  let whole = false
  let closed = NO_BLOCKS

  const restart = () => {
    cursor = 0
    blockStart = 0
    inList = false
    blockHasLine = false
    fence = null
    afterBlank = false
    whole = false
    closed = NO_BLOCKS
  }

  const closesFence = (line: string) => {
    if (!fence) return false
    const match = FENCE.exec(line)
    return (
      !!match &&
      match[1]![0] === fence.char &&
      match[1]!.length >= fence.size &&
      match[2]!.trim() === ''
    )
  }

  const readLine = (line: string, lineStart: number) => {
    if (fence) {
      if (closesFence(line)) fence = null
      return
    }
    if (line.trim() === '') {
      afterBlank = true
      return
    }
    if (REFERENCE.test(line)) {
      whole = true
      return
    }
    const indented = /^[ \t]/.test(line)
    const listItem = LIST_ITEM.test(line)
    const continues = indented || (inList && listItem)
    if (afterBlank && !continues && blockHasLine && lineStart - blockStart >= minChars) {
      closed = [...closed, read.slice(blockStart, lineStart).trimEnd()]
      blockStart = lineStart
      blockHasLine = false
    }
    if (!indented) inList = listItem || (inList && !afterBlank)
    afterBlank = false
    blockHasLine = true
    const opens = FENCE.exec(line)
    // An info string with a backtick is inline code, not a fence.
    if (opens && !(opens[1]![0] === '`' && opens[2]!.includes('`'))) {
      fence = { char: opens[1]![0]!, size: opens[1]!.length }
    }
  }

  return {
    read(text: string): MarkdownBlocks {
      if (!text.startsWith(read)) restart()
      read = text
      while (!whole) {
        const end = text.indexOf('\n', cursor)
        if (end === -1) break
        readLine(text.slice(cursor, end).replace(/\r$/, ''), cursor)
        cursor = end + 1
      }
      // The line still being written may be a reference already.
      if (!fence && REFERENCE.test(text.slice(cursor))) whole = true
      if (whole) return { closed: NO_BLOCKS, tail: text }
      return { closed, tail: text.slice(blockStart) }
    },
  }
}
