/** What a review looks at: the working tree's uncommitted changes, the
 * changes against a base branch, one commit, or whatever the instructions
 * say. */
export type ReviewTarget =
  | { type: 'uncommitted_changes' }
  | { type: 'base_branch'; branch: string }
  | { type: 'commit'; sha: string; title?: string }
  | { type: 'custom'; instructions: string }

/**
 * A turn that runs one of the provider's own operations instead of a prompt:
 * a code review, or compacting the conversation. The provider runs it on the
 * session's thread with no prompt of ours, and it cannot be steered. Offered
 * by a provider through `ProviderCapabilities.operations`.
 */
export type TurnOperation =
  | { kind: 'review'; target: ReviewTarget }
  /** `instructions`: what was typed after `/compact`. A provider whose
   * compaction takes none (Codex) says it did not use them. */
  | { kind: 'compact'; instructions?: string }

export type TurnOperationKind = TurnOperation['kind']

export const TURN_OPERATION_KINDS: readonly TurnOperationKind[] = ['review', 'compact']

/**
 * The operation a message typed in the composer asks for, when the provider
 * offers it (`offered`); undefined for any other message, which is a prompt.
 *
 * - `/compact` compacts the conversation, with whatever follows it as
 *   `instructions`.
 * - `/review` reviews the uncommitted changes (also `/review uncommitted`).
 * - `/review base <branch>` reviews the changes against a base branch.
 * - `/review commit <sha> [title]` reviews one commit; `<sha>` is 7 to 40
 *   hex digits, or the whole is instructions.
 * - `/review <anything else>` reviews with those instructions.
 *
 * Command words (`review`, `compact`, `base`, `commit`, `uncommitted`) match
 * in any case.
 */
export function parseTurnOperation(
  text: string,
  offered: readonly TurnOperationKind[] = TURN_OPERATION_KINDS,
): TurnOperation | undefined {
  const match = /^\/(review|compact)(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!match) return undefined
  const kind = match[1]!.toLowerCase() as TurnOperationKind
  if (!offered.includes(kind)) return undefined
  const rest = match[2]?.trim() ?? ''
  if (kind === 'compact') return rest ? { kind, instructions: rest } : { kind }
  return { kind, target: reviewTarget(rest) }
}

function reviewTarget(rest: string): ReviewTarget {
  if (!rest || /^uncommitted$/i.test(rest)) return { type: 'uncommitted_changes' }
  const base = /^base\s+(\S+)$/i.exec(rest)
  if (base) return { type: 'base_branch', branch: base[1]! }
  const commit = /^commit\s+([0-9a-f]{7,40})(?:\s+([\s\S]+))?$/i.exec(rest)
  if (commit) {
    const title = commit[2]?.trim()
    return { type: 'commit', sha: commit[1]!, ...(title ? { title } : {}) }
  }
  return { type: 'custom', instructions: rest }
}

/** The operation in a few words, for the row that opens its turn. */
export function describeTurnOperation(operation: TurnOperation): {
  label: string
  detail?: string
} {
  if (operation.kind === 'compact') return { label: 'Compact the conversation' }
  const target = operation.target
  switch (target.type) {
    case 'uncommitted_changes':
      return { label: 'Code review', detail: 'uncommitted changes' }
    case 'base_branch':
      return { label: 'Code review', detail: `changes against ${target.branch}` }
    case 'commit':
      return {
        label: 'Code review',
        detail: `commit ${target.sha.slice(0, 7)}${target.title ? ` ${target.title}` : ''}`,
      }
    case 'custom':
      return { label: 'Code review', detail: target.instructions }
  }
}
