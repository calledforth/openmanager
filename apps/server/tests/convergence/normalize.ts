import {
  selectSessionList,
  type EnvironmentState,
  type SessionSummary,
  type ThreadState,
} from '@openmanager/environment-client'
import type { ServerThreadRead } from './child-protocol.ts'

/**
 * The server-owned part of a client's state, as `docs/sync-foundations.md`
 * §8.1 defines it, in a canonical form two clients can be compared in.
 *
 * Kept: the environment, workspaces, every session summary in sidebar order,
 * and, for the session on screen, each thread's turns, messages, reasoning,
 * tools, order, pending interactions and (on main) failures.
 *
 * Dropped: everything the client owns or only reads (connection, selection,
 * hydration, the outbox, history cursors, drafts, the provider catalog and
 * health), transient notices, and composer preferences, which a fresh load
 * holds only once something asks for them (they join in F5, with the
 * environment snapshot that carries them).
 *
 * A session's thread list is kept only for the session on screen: a fresh
 * load learns the threads of the session it opens, and no others, so for
 * any other session the list says what this client happened to learn, not
 * what the server holds.
 */
export interface NormalizedView {
  environment: unknown
  workspaces: Record<string, unknown>
  sessions: unknown[]
  active: { sessionId: string; present: boolean; threads: Record<string, ThreadView> } | null
}

export interface ThreadView {
  turns: unknown[]
  messages: unknown[]
  reasoning: Record<string, unknown>
  tools: Record<string, unknown>
  order: unknown[]
  interactions: Record<string, unknown>
  failures: Record<string, unknown>
}

/** JSON semantics: `undefined` members vanish, keys sort, so equal state prints equal. */
export function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value))
    return value.map((item) => (item === undefined ? null : canonical(item)))
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const member = (value as Record<string, unknown>)[key]
    if (member !== undefined) out[key] = canonical(member)
  }
  return out
}

const keyed = <T>(items: readonly T[], key: (item: T) => string): Record<string, unknown> =>
  Object.fromEntries(items.map((item) => [key(item), item]))

function sessionView(session: SessionSummary, onScreen: boolean): unknown {
  const { threadIds, settledAt, doneAt, backgroundTasks, ...rest } = session
  return {
    ...rest,
    // "Null or absent while it is active" (types.ts): one meaning, one form.
    settledAt: settledAt ?? null,
    doneAt: doneAt ?? null,
    // No work is no key at all on the client; a listing may say [].
    ...(backgroundTasks?.length ? { backgroundTasks } : {}),
    ...(onScreen ? { threadIds } : {}),
  }
}

export function threadView(
  thread: Pick<
    ThreadState,
    'turns' | 'messages' | 'reasoning' | 'tools' | 'order' | 'interactions' | 'failures'
  >,
): ThreadView {
  return canonical({
    // Display order: the transcript walks turns, then each turn's messages.
    turns: thread.turns,
    messages: thread.messages,
    // Placed by `order`; their own array order only matters for what `order`
    // does not place, so they compare by id.
    reasoning: keyed(thread.reasoning, (entry) => entry.messageId),
    tools: keyed(thread.tools, (tool) => tool.toolCallId),
    order: thread.order,
    interactions: keyed(
      thread.interactions.map((item) => ({ turnId: item.turnId, interaction: item.interaction })),
      (item) => item.interaction.interactionId,
    ),
    failures: keyed(thread.failures, (failure) => failure.turnId),
  }) as ThreadView
}

/** The server's own read of a thread, in the same shape. It has no failures on main. */
export function serverThreadView(read: ServerThreadRead): ThreadView {
  return threadView({
    turns: read.turns,
    messages: read.messages,
    reasoning: read.reasoning,
    tools: read.tools,
    order: read.order,
    interactions: read.interactions,
    failures: [],
  } as unknown as ThreadState)
}

/** `activeSessionId` is the client under test's selection; a fresh load opens the same one. */
export function normalize(state: EnvironmentState, activeSessionId: string | null): NormalizedView {
  const session = activeSessionId ? state.sessions[activeSessionId] : undefined
  return canonical({
    environment: state.environment,
    workspaces: state.workspaces,
    sessions: selectSessionList(state).map((summary) =>
      sessionView(summary, summary.sessionId === activeSessionId),
    ),
    active: activeSessionId
      ? {
          sessionId: activeSessionId,
          present: session !== undefined,
          threads: Object.fromEntries(
            (session?.threadIds ?? []).flatMap((threadId) => {
              const thread = state.threads[threadId]
              return thread ? [[threadId, threadView(thread)]] : []
            }),
          ),
        }
      : null,
  }) as NormalizedView
}

// ---------------------------------------------------------------------------
// Structural diff
// ---------------------------------------------------------------------------

export interface DiffEntry {
  /** Which two views: the client under test against a fresh load or the server's read. */
  comparison: string
  path: string
  left: unknown
  right: unknown
}

const ID_KEYS = ['turnId', 'messageId', 'toolCallId', 'sessionId', 'workspaceId'] as const

function idOf(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined
  const record = item as Record<string, unknown>
  // An order entry: the same id may be a message and a reasoning block.
  if (typeof record.kind === 'string' && typeof record.id === 'string') {
    return `${record.kind}:${record.id}`
  }
  for (const key of ID_KEYS) if (typeof record[key] === 'string') return record[key] as string
  return undefined
}

/** Long strings print as their head and length, so a diff of a 1 MB message stays readable. */
export function trim(value: unknown, max = 160): unknown {
  if (typeof value === 'string') {
    return value.length > max ? `${value.slice(0, max)}… (${value.length} chars)` : value
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 12).map((item) => trim(item, max))
    return value.length > 12 ? [...items, `… ${value.length - 12} more`] : items
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trim(item, max)]))
  }
  return value
}

const ABSENT = '<absent>'

/**
 * Entries for every place `left` and `right` differ. Arrays of entities are
 * aligned by id, so one missing message reads as one missing message rather
 * than every later index differing; a change of their sequence is its own
 * `(order)` entry.
 */
export function diff(comparison: string, left: unknown, right: unknown, path = ''): DiffEntry[] {
  if (Object.is(left, right)) return []
  const entry = (l: unknown, r: unknown): DiffEntry => ({
    comparison,
    path: path || '(root)',
    left: l,
    right: r,
  })
  if (Array.isArray(left) && Array.isArray(right)) {
    const leftIds = left.map(idOf)
    const rightIds = right.map(idOf)
    if (
      leftIds.every((id) => id !== undefined) &&
      rightIds.every((id) => id !== undefined) &&
      new Set(leftIds).size === left.length &&
      new Set(rightIds).size === right.length
    ) {
      const entries: DiffEntry[] = []
      const rightById = new Map(right.map((item, index) => [rightIds[index]!, item]))
      const leftById = new Map(left.map((item, index) => [leftIds[index]!, item]))
      for (const [id, item] of leftById) {
        const other = rightById.get(id)
        if (other === undefined) entries.push({ ...entry(item, ABSENT), path: `${path}[${id}]` })
        else entries.push(...diff(comparison, item, other, `${path}[${id}]`))
      }
      for (const [id, item] of rightById) {
        if (!leftById.has(id)) entries.push({ ...entry(ABSENT, item), path: `${path}[${id}]` })
      }
      const common = (ids: (string | undefined)[], other: Map<string, unknown>) =>
        ids.filter((id) => other.has(id!))
      const leftCommon = common(leftIds, rightById)
      const rightCommon = common(rightIds, leftById)
      if (leftCommon.some((id, index) => id !== rightCommon[index])) {
        entries.push({ ...entry(leftCommon, rightCommon), path: `${path}(order)` })
      }
      return entries
    }
    const entries: DiffEntry[] = []
    const length = Math.max(left.length, right.length)
    for (let index = 0; index < length; index++) {
      entries.push(
        ...diff(
          comparison,
          index < left.length ? left[index] : ABSENT,
          index < right.length ? right[index] : ABSENT,
          `${path}[${index}]`,
        ),
      )
    }
    return entries
  }
  if (
    left &&
    right &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    return [...keys]
      .sort()
      .flatMap((key) =>
        diff(
          comparison,
          key in left ? (left as Record<string, unknown>)[key] : ABSENT,
          key in right ? (right as Record<string, unknown>)[key] : ABSENT,
          path ? `${path}.${key}` : key,
        ),
      )
  }
  return [entry(left, right)]
}

export function describeDiff(entries: readonly DiffEntry[], limit = 40): string {
  const lines = entries
    .slice(0, limit)
    .map(
      (item) =>
        `  [${item.comparison}] ${item.path}: ${JSON.stringify(trim(item.left))} ≠ ${JSON.stringify(trim(item.right))}`,
    )
  if (entries.length > limit) lines.push(`  … ${entries.length - limit} more`)
  return lines.join('\n')
}

export { ABSENT }
