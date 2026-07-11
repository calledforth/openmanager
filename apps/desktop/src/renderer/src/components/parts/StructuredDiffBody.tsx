import type { StructuredDiff } from '@agentpack/view'
import { typographyMonoCaption } from '../../lib/typography'

type DiffLine = { kind: 'context' | 'added' | 'removed'; text: string }

function lines(text: string): string[] {
  if (!text) return []
  const result = text.split(/\r?\n/)
  if (result.at(-1) === '') result.pop()
  return result
}

function diffLines(oldText: string, newText: string): DiffLine[] {
  const before = lines(oldText)
  const after = lines(newText)
  const common = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  )

  for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = after.length - 1; newIndex >= 0; newIndex -= 1) {
      common[oldIndex]![newIndex] =
        before[oldIndex] === after[newIndex]
          ? common[oldIndex + 1]![newIndex + 1]! + 1
          : Math.max(common[oldIndex + 1]![newIndex]!, common[oldIndex]![newIndex + 1]!)
    }
  }

  const output: DiffLine[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < before.length || newIndex < after.length) {
    if (
      oldIndex < before.length &&
      newIndex < after.length &&
      before[oldIndex] === after[newIndex]
    ) {
      output.push({ kind: 'context', text: before[oldIndex]! })
      oldIndex += 1
      newIndex += 1
    } else if (
      oldIndex < before.length &&
      (newIndex >= after.length ||
        common[oldIndex + 1]![newIndex]! >= common[oldIndex]![newIndex + 1]!)
    ) {
      output.push({ kind: 'removed', text: before[oldIndex]! })
      oldIndex += 1
    } else {
      output.push({ kind: 'added', text: after[newIndex]! })
      newIndex += 1
    }
  }
  return output
}

export function StructuredDiffBody({ diff }: { diff: StructuredDiff }) {
  return (
    <div className={typographyMonoCaption}>
      {diff.hunks.map((hunk, hunkIndex) => (
        <div key={`${hunk.path}:${hunkIndex}`}>
          <div className="text-[var(--basis-text-faint)]">{hunk.path}</div>
          {diffLines(hunk.oldText ?? '', hunk.newText).map((line, lineIndex) => (
            <div
              key={`${line.kind}:${lineIndex}`}
              className={
                line.kind === 'added'
                  ? 'text-emerald-500/90'
                  : line.kind === 'removed'
                    ? 'text-rose-500/90'
                    : 'text-[var(--basis-text-faint)]'
              }
            >
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
              {line.text}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
