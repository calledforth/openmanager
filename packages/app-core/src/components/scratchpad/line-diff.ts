export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string }

/** Past this many lines a side the diff gives up and shows a replace. */
const MAX_LINES = 2000

/** An empty document has no lines, not one empty line. */
const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'))

/**
 * A line diff by longest common subsequence: what `after` added to and
 * removed from `before`, in order. A scratchpad is small enough for the
 * quadratic table.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = linesOf(before)
  const b = linesOf(after)
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text) => ({ kind: 'removed' as const, text })),
      ...b.map((text) => ({ kind: 'added' as const, text })),
    ]
  }
  const n = a.length
  const m = b.length
  // lcs[i][j]: the common run of a[i..] and b[j..].
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: a[i++]! })
    } else {
      out.push({ kind: 'added', text: b[j++]! })
    }
  }
  while (i < n) out.push({ kind: 'removed', text: a[i++]! })
  while (j < m) out.push({ kind: 'added', text: b[j++]! })
  return out
}

export function diffStat(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'added') added++
    else if (line.kind === 'removed') removed++
  }
  return { added, removed }
}
