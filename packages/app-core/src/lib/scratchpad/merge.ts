/**
 * A three-way merge of the scratchpad, line by line.
 *
 * Both edits are diffed against the base they were made from, and each is
 * read as what it did to every base line (kept, replaced, or removed) and
 * what it inserted between base lines. The merge then walks the base once:
 *
 * - a line only one side changed takes that side's change;
 * - a line both sides changed takes `mine`'s (the same change once);
 * - lines inserted at one place are all kept, mine first (the same insert once).
 *
 * This is the scratchpad's whole conflict rule: the panel's text is `mine`,
 * so nothing the user typed is ever lost to an agent's edit, and an agent's
 * edit to any line the user did not touch survives the user's.
 *
 * The diff is Myers' (linear space, no size cutoff): unlike the display diff
 * it never gives up and calls the whole document replaced, which would make
 * every outside change look like a clash. The file is capped at 60 KB, so
 * the realistic cost is small; the merge only runs when two edits race.
 */

/** An empty document has no lines, not one empty line. */
const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'))

/**
 * The lines of `a` and `b` that a shortest edit script keeps, as pairs of
 * indices in order. Myers' O((N+M)D) algorithm, split at the middle snake
 * (as diff-match-patch does), so its memory stays linear.
 */
export function matchLines(a: readonly number[], b: readonly number[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  const walk = (aLo: number, aHi: number, bLo: number, bHi: number) => {
    // Common head and tail are matched without searching.
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) pairs.push([aLo++, bLo++])
    let tail = 0
    while (aHi - tail > aLo && bHi - tail > bLo && a[aHi - 1 - tail] === b[bHi - 1 - tail]) tail++
    if (aLo < aHi - tail && bLo < bHi - tail) {
      const split = middleSnake(a, aLo, aHi - tail, b, bLo, bHi - tail)
      if (split) {
        const [x, y] = split
        walk(aLo, aLo + x, bLo, bLo + y)
        walk(aLo + x, aHi - tail, bLo + y, bHi - tail)
      }
    }
    for (let i = tail; i > 0; i--) pairs.push([aHi - i, bHi - i])
  }
  walk(0, a.length, 0, b.length)
  return pairs
}

/**
 * Where the shortest edit script of `a[aLo, aHi)` into `b[bLo, bHi)` crosses
 * its middle, relative to the starts; null when the two share no line.
 */
function middleSnake(
  a: readonly number[],
  aLo: number,
  aHi: number,
  b: readonly number[],
  bLo: number,
  bHi: number,
): [number, number] | null {
  const n = aHi - aLo
  const m = bHi - bLo
  const maxD = Math.ceil((n + m) / 2)
  const offset = maxD
  const length = 2 * maxD + 2
  const forward = new Int32Array(length).fill(-1)
  const backward = new Int32Array(length).fill(-1)
  forward[offset + 1] = 0
  backward[offset + 1] = 0
  const delta = n - m
  // With an odd delta the paths meet on a forward step, else a backward one.
  const front = delta % 2 !== 0
  let k1Start = 0
  let k1End = 0
  let k2Start = 0
  let k2End = 0
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1Start; k1 <= d - k1End; k1 += 2) {
      const k1Offset = offset + k1
      let x1 =
        k1 === -d || (k1 !== d && forward[k1Offset - 1]! < forward[k1Offset + 1]!)
          ? forward[k1Offset + 1]!
          : forward[k1Offset - 1]! + 1
      let y1 = x1 - k1
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
        x1++
        y1++
      }
      forward[k1Offset] = x1
      if (x1 > n) k1End += 2
      else if (y1 > m) k1Start += 2
      else if (front) {
        const k2Offset = offset + delta - k1
        if (k2Offset >= 0 && k2Offset < length && backward[k2Offset] !== -1) {
          if (x1 >= n - backward[k2Offset]!) return [x1, y1]
        }
      }
    }
    for (let k2 = -d + k2Start; k2 <= d - k2End; k2 += 2) {
      const k2Offset = offset + k2
      let x2 =
        k2 === -d || (k2 !== d && backward[k2Offset - 1]! < backward[k2Offset + 1]!)
          ? backward[k2Offset + 1]!
          : backward[k2Offset - 1]! + 1
      let y2 = x2 - k2
      while (x2 < n && y2 < m && a[aHi - 1 - x2] === b[bHi - 1 - y2]) {
        x2++
        y2++
      }
      backward[k2Offset] = x2
      if (x2 > n) k2End += 2
      else if (y2 > m) k2Start += 2
      else if (!front) {
        const k1Offset = offset + delta - k2
        if (k1Offset >= 0 && k1Offset < length && forward[k1Offset] !== -1) {
          const x1 = forward[k1Offset]!
          const y1 = offset + x1 - k1Offset
          if (x1 >= n - x2) return [x1, y1]
        }
      }
    }
  }
  return null
}

/**
 * What one edit did to each base line, and what it inserted before each:
 * `replaced[i]` is undefined for a kept line, else the lines that stand in
 * for it (none: removed); `inserted[i]` goes before base line `i`
 * (`inserted[n]` at the end). A run of removed lines replaced by a run of
 * added ones is paired line for line, the extra added lines inserted after
 * the pairs, so a change to one line of a run is that line's change alone.
 */
function changesOf(base: readonly number[], after: readonly number[], text: readonly string[]) {
  const n = base.length
  const replaced: Array<string[] | undefined> = new Array(n).fill(undefined)
  const inserted: string[][] = Array.from({ length: n + 1 }, () => [])
  let i = 0
  let j = 0
  const gap = (toI: number, toJ: number) => {
    const removed = toI - i
    const added = toJ - j
    const paired = Math.min(removed, added)
    for (let p = 0; p < paired; p++) replaced[i + p] = [text[j + p]!]
    for (let p = paired; p < removed; p++) replaced[i + p] = []
    inserted[i + paired]!.push(...text.slice(j + paired, toJ))
    i = toI
    j = toJ
  }
  for (const [baseIndex, afterIndex] of matchLines(base, after)) {
    gap(baseIndex, afterIndex)
    i = baseIndex + 1
    j = afterIndex + 1
  }
  gap(n, after.length)
  return { replaced, inserted }
}

const sameLines = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((line, index) => line === b[index])

/** Merge two edits of `base`; see the top of this file for the rule. */
export function mergeLines(base: string, mine: string, theirs: string): string {
  if (mine === theirs || theirs === base) return mine
  if (mine === base) return theirs
  const baseLines = linesOf(base)
  const mineLines = linesOf(mine)
  const theirLines = linesOf(theirs)
  // Lines become numbers once, so the diff compares integers.
  const ids = new Map<string, number>()
  const idsOf = (lines: readonly string[]) =>
    lines.map((line) => {
      let id = ids.get(line)
      if (id === undefined) ids.set(line, (id = ids.size))
      return id
    })
  const baseIds = idsOf(baseLines)
  const ours = changesOf(baseIds, idsOf(mineLines), mineLines)
  const others = changesOf(baseIds, idsOf(theirLines), theirLines)
  const out: string[] = []
  for (let i = 0; i <= baseLines.length; i++) {
    const own = ours.inserted[i]!
    const their = others.inserted[i]!
    out.push(...own)
    if (!sameLines(own, their)) out.push(...their)
    if (i === baseLines.length) break
    const mineLine = ours.replaced[i]
    const theirLine = others.replaced[i]
    out.push(...(mineLine ?? theirLine ?? [baseLines[i]!]))
  }
  return out.join('\n')
}
