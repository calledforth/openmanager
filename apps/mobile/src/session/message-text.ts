/**
 * A message as one run of styled text, for the select-text sheet: native
 * selection on Android and iOS works inside one text view only, and the
 * transcript draws a reply as many (a paragraph, a list item, a code block
 * each its own), so handles stop at the edge of a paragraph. Here the whole
 * message is a single text, its formatting carried by spans, so the handles
 * go anywhere in it and what is copied is the text as it reads: no markdown
 * marks, code as written.
 *
 * Pure, so the tests read it: a parsed markdown tree in, runs out.
 */
import { assistantCopyText, type MessagePart } from '@openmanager/app-core/logic'

/** How a run of text is drawn. Absent marks are plain prose. */
export interface RunMarks {
  strong?: true
  em?: true
  strike?: true
  /** Inline code. */
  code?: true
  link?: true
  heading?: number
  /** A fenced or indented block of code. */
  codeBlock?: true
  quote?: true
  /** A list's bullet or number, a rule: drawn in the faint ink. */
  faint?: true
}

export interface MessageRun {
  text: string
  marks: RunMarks
}

/** The shape of a node of `react-native-markdown-display`'s parsed tree that this reads. */
export interface MarkdownNode {
  type: string
  content?: string
  children: MarkdownNode[]
  attributes?: Record<string, unknown>
}

/** What a message's long press acts on: its text, and how that text is written. */
export interface MessageTarget {
  /** A reply is markdown; a prompt is what the reader typed. */
  kind: 'assistant' | 'user'
  /** What "Copy message" copies: the reply's markdown as written, or the prompt. */
  text: string
}

/** The row's target, or null while there is nothing settled to copy (a reply still streaming). */
export function messageTargetOf(row: {
  role: 'user' | 'assistant'
  content: string
  isFinal: boolean
  parts?: readonly MessagePart[]
}): MessageTarget | null {
  if (row.role === 'user') {
    const text = row.content.trim()
    return text ? { kind: 'user', text } : null
  }
  // Web's copy button's own rule: the answer, without the work before it.
  const text = assistantCopyText(row.content, row.isFinal, row.parts)
  return text ? { kind: 'assistant', text } : null
}

const BULLET = '•'
/** Between a list's marker and its item. */
const MARKER_GAP = '  '
const INDENT = '    '
const CELL_GAP = '  |  '

const trimNewline = (text: string) => text.replace(/\n+$/, '')

/** The runs of a message's markdown tree, adjacent runs alike merged. */
export function messageRuns(nodes: readonly MarkdownNode[]): MessageRun[] {
  const runs: MessageRun[] = []
  for (const run of blocks(nodes, {}, 0, '\n\n')) {
    if (!run.text) continue
    const last = runs[runs.length - 1]
    if (last && sameMarks(last.marks, run.marks)) last.text += run.text
    else runs.push({ text: run.text, marks: run.marks })
  }
  return runs
}

/** The plain text the runs read as: what a selection of all of it copies. */
export const runsText = (runs: readonly MessageRun[]) => runs.map((run) => run.text).join('')

function sameMarks(a: RunMarks, b: RunMarks): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof RunMarks>
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

/** Block nodes, `gap` between each two that say anything. */
function blocks(
  nodes: readonly MarkdownNode[],
  marks: RunMarks,
  depth: number,
  gap: string,
): MessageRun[] {
  const out: MessageRun[] = []
  for (const node of nodes) {
    const runs = block(node, marks, depth)
    if (!runs.some((run) => run.text)) continue
    if (out.length > 0) out.push({ text: gap, marks: {} })
    out.push(...runs)
  }
  return out
}

function block(node: MarkdownNode, marks: RunMarks, depth: number): MessageRun[] {
  const heading = /^heading([1-6])$/.exec(node.type)
  if (heading) return inline(node.children, { ...marks, heading: Number(heading[1]) })
  switch (node.type) {
    case 'paragraph':
    case 'textgroup':
      return inline(node.children, marks)
    case 'bullet_list':
    case 'ordered_list':
      return list(node, marks, depth)
    case 'blockquote':
      return blocks(node.children, { ...marks, quote: true }, depth, '\n\n')
    case 'fence':
    case 'code_block':
      return [{ text: trimNewline(node.content ?? ''), marks: { ...marks, codeBlock: true } }]
    case 'hr':
      return [{ text: '———', marks: { ...marks, faint: true } }]
    case 'table':
      return table(node, marks)
    case 'html_block':
      return [{ text: trimNewline(node.content ?? ''), marks }]
    default:
      // Anything else that is a block holds blocks; inline content falls through.
      return node.children.length > 0
        ? blocks(node.children, marks, depth, '\n\n')
        : inline([node], marks)
  }
}

function list(node: MarkdownNode, marks: RunMarks, depth: number): MessageRun[] {
  const ordered = node.type === 'ordered_list'
  const start = Number(node.attributes?.start ?? 1)
  const first = Number.isFinite(start) ? start : 1
  const out: MessageRun[] = []
  node.children.forEach((item, index) => {
    if (index > 0) out.push({ text: '\n', marks: {} })
    const marker = ordered ? `${first + index}.` : BULLET
    out.push({ text: INDENT.repeat(depth), marks: {} })
    out.push({ text: marker, marks: { ...marks, faint: true } })
    out.push({ text: MARKER_GAP, marks: {} })
    // An item's own lists sit one level in, on the lines under it.
    out.push(...blocks(item.children, marks, depth + 1, '\n'))
  })
  return out
}

function table(node: MarkdownNode, marks: RunMarks): MessageRun[] {
  const rows: { cells: MarkdownNode[]; head: boolean }[] = []
  for (const section of node.children) {
    for (const row of section.children) {
      rows.push({ cells: row.children, head: section.type === 'thead' })
    }
  }
  const out: MessageRun[] = []
  rows.forEach((row, index) => {
    if (index > 0) out.push({ text: '\n', marks: {} })
    row.cells.forEach((cell, column) => {
      if (column > 0) out.push({ text: CELL_GAP, marks: { faint: true } })
      out.push(...inline(cell.children, row.head ? { ...marks, strong: true } : marks))
    })
  })
  return out
}

function inline(nodes: readonly MarkdownNode[], marks: RunMarks): MessageRun[] {
  const out: MessageRun[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'html_inline':
        out.push({ text: node.content ?? '', marks })
        break
      case 'code_inline':
        out.push({ text: node.content ?? '', marks: { ...marks, code: true } })
        break
      case 'softbreak':
      case 'hardbreak':
        // The transcript draws a line break in the source as one, too.
        out.push({ text: '\n', marks })
        break
      case 'strong':
        out.push(...inline(node.children, { ...marks, strong: true }))
        break
      case 'em':
        out.push(...inline(node.children, { ...marks, em: true }))
        break
      case 's':
        out.push(...inline(node.children, { ...marks, strike: true }))
        break
      case 'link':
      case 'blocklink':
        out.push(...inline(node.children, { ...marks, link: true }))
        break
      case 'image':
        // Its words, where the transcript shows the picture.
        out.push({ text: node.content ?? '', marks })
        break
      default:
        if (node.children.length > 0) out.push(...inline(node.children, marks))
        else if (node.content) out.push({ text: node.content, marks })
    }
  }
  return out
}
