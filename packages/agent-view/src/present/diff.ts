import type { ToolCallContent } from '@agentpack/contract'

export type DiffHunk = {
  path: string
  oldText: string | null
  newText: string
  added: number
  removed: number
}

export type StructuredDiff = {
  added: number
  removed: number
  hunks: DiffHunk[]
}

function lines(text: string): string[] {
  if (!text) return []
  const result = text.split(/\r?\n/)
  if (result[result.length - 1] === '') result.pop()
  return result
}

function lineChanges(oldText: string, newText: string): { added: number; removed: number } {
  const before = lines(oldText)
  const after = lines(newText)
  const previous = new Array<number>(after.length + 1).fill(0)
  for (let beforeIndex = 1; beforeIndex <= before.length; beforeIndex += 1) {
    let diagonal = 0
    for (let afterIndex = 1; afterIndex <= after.length; afterIndex += 1) {
      const above = previous[afterIndex]!
      const left = previous[afterIndex - 1]!
      const value =
        before[beforeIndex - 1] === after[afterIndex - 1] ? diagonal + 1 : Math.max(above, left)
      diagonal = above
      previous[afterIndex] = value
    }
  }
  const common = previous[after.length]!
  return { added: after.length - common, removed: before.length - common }
}

/** Extracts only contract-native structured diff items; text content is never inspected. */
export function extractDiff(contentItems: readonly ToolCallContent[]): StructuredDiff | undefined {
  const hunks: DiffHunk[] = []
  let added = 0
  let removed = 0
  for (const item of contentItems) {
    if (item.type !== 'diff') continue
    const changes = lineChanges(item.oldText ?? '', item.newText)
    added += changes.added
    removed += changes.removed
    hunks.push({
      path: item.path,
      oldText: item.oldText ?? null,
      newText: item.newText,
      ...changes,
    })
  }
  return hunks.length ? { added, removed, hunks } : undefined
}

export const extractStructuredDiff = extractDiff
