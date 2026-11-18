import { diffLines } from '../../components/scratchpad/line-diff'

/** One change to the base: lines `[start, end)` of it replaced by `lines`. */
interface Hunk {
  start: number
  end: number
  lines: string[]
}

/** An empty document has no lines, not one empty line. */
const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'))

/** The changes `after` made to `base`, as runs of base lines replaced. */
function hunksOf(base: string, after: string): Hunk[] {
  const hunks: Hunk[] = []
  let index = 0
  let open: Hunk | null = null
  for (const line of diffLines(base, after)) {
    if (line.kind === 'same') {
      if (open) hunks.push(open)
      open = null
      index += 1
      continue
    }
    open ??= { start: index, end: index, lines: [] }
    if (line.kind === 'removed') {
      index += 1
      open.end = index
    } else {
      open.lines.push(line.text)
    }
  }
  if (open) hunks.push(open)
  return hunks
}

const insertion = (hunk: Hunk) => hunk.start === hunk.end

const same = (a: Hunk, b: Hunk) =>
  a.start === b.start &&
  a.end === b.end &&
  a.lines.length === b.lines.length &&
  a.lines.every((line, index) => line === b.lines[index])

/**
 * Whether two changes touch the same lines of the base. Two insertions at
 * one place do not: both are kept, so neither is lost. An insertion at the
 * very edge of a replaced run does not either; it goes beside it.
 */
function overlaps(a: Hunk, b: Hunk): boolean {
  if (insertion(a) && insertion(b)) return false
  if (insertion(a)) return b.start < a.start && a.start < b.end
  if (insertion(b)) return a.start < b.start && b.start < a.end
  return a.start < b.end && b.start < a.end
}

/**
 * Merge two edits of one text, line by line: `mine` and `theirs` were both
 * made from `base`. A change only one side made is kept; where both changed
 * the same lines, `mine` wins those lines and theirs there is dropped. Lines
 * both sides inserted at the same place are all kept, mine first.
 *
 * This is the scratchpad's whole conflict rule: the panel's text is `mine`,
 * so nothing the user typed is ever lost to an agent's edit, and an agent's
 * edit elsewhere in the page survives the user's.
 */
export function mergeLines(base: string, mine: string, theirs: string): string {
  if (mine === theirs || theirs === base) return mine
  if (mine === base) return theirs
  const ours = hunksOf(base, mine)
  const kept = hunksOf(base, theirs).filter(
    (hunk) => !ours.some((own) => same(own, hunk)) && !ours.some((own) => overlaps(own, hunk)),
  )
  // Applied in base order. At one place an insertion goes before a run
  // replaced there, and mine before theirs.
  const tagged = [
    ...ours.map((hunk) => ({ hunk, mine: true })),
    ...kept.map((hunk) => ({ hunk, mine: false })),
  ].sort(
    (a, b) =>
      a.hunk.start - b.hunk.start ||
      Number(!insertion(a.hunk)) - Number(!insertion(b.hunk)) ||
      Number(b.mine) - Number(a.mine),
  )
  const source = linesOf(base)
  const out: string[] = []
  let index = 0
  for (const { hunk } of tagged) {
    while (index < hunk.start) out.push(source[index++]!)
    out.push(...hunk.lines)
    index = Math.max(index, hunk.end)
  }
  while (index < source.length) out.push(source[index++]!)
  return out.join('\n')
}
