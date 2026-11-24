import { isSettledSubagentStatus, type Subagent } from '@openmanager/protocol'

/**
 * A subagent as a message part: the card the parent chat shows in place of
 * the tool call that started it. Built from the record the parent's thread
 * holds, so the card follows `subagent.updated` without a store of its own.
 */
export interface SubagentPart {
  type: 'subagent'
  id: string
  subagent: Subagent
  [key: string]: unknown
}

export function isSubagentPart(part: { type: string }): part is SubagentPart {
  return part.type === 'subagent' && 'subagent' in part
}

const subagentParts = new WeakMap<Subagent, SubagentPart>()

/** The record's part, the same object for as long as the record is. */
export function subagentPart(subagent: Subagent): SubagentPart {
  let part = subagentParts.get(subagent)
  if (!part) {
    part = { type: 'subagent', id: `subagent:${subagent.subagentId}`, subagent }
    subagentParts.set(subagent, part)
  }
  return part
}

export type SubagentTone = 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

export function subagentTone(status: Subagent['status']): SubagentTone {
  switch (status) {
    case 'pending':
    case 'running':
      return 'running'
    case 'waiting':
      return 'waiting'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
    case 'interrupted':
      return 'stopped'
  }
}

/**
 * The status in a word or two. One vocabulary everywhere a subagent is
 * shown: working, needs you, done, failed, stopped. What a waiting one
 * waits on is said beside it (`subagentWaitReason`), not in its status.
 */
export function subagentStatusLabel(subagent: Pick<Subagent, 'status' | 'waitingOn'>): string {
  switch (subagent.status) {
    case 'pending':
      return 'Starting'
    case 'running':
      return 'Working'
    case 'waiting':
      return 'Needs you'
    case 'completed':
      return 'Done'
    case 'failed':
      return 'Failed'
    case 'cancelled':
    case 'interrupted':
      return 'Stopped'
  }
}

/** What a waiting subagent waits on, as the line under its title says it. */
export function subagentWaitReason(waitingOn: Subagent['waitingOn']): string {
  return waitingOn === 'question'
    ? 'Asked you a question'
    : waitingOn === 'plan'
      ? 'Has a plan for you to review'
      : 'Waiting for your permission'
}

/** One line of free text: the first line that says something, whitespace folded. */
function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined
  const lines = text.split('\n')
  // A heading ("## Summary") names what follows; the line after says it.
  const prose = lines.filter((raw) => !/^\s*#/.test(raw))
  for (const raw of prose.some((raw) => raw.trim()) ? prose : lines) {
    const line = raw
      .replace(/^[#>*\-\s]+/, '')
      // Inline marks read as noise in one plain line: keep the words.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|`)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (line) return line
  }
  return undefined
}

/**
 * The card's second line: what it is doing while it works, what it needs
 * while it waits, and how it ended once settled. Undefined when nothing says.
 */
export function subagentDetail(
  subagent: Pick<
    Subagent,
    'status' | 'waitingOn' | 'activity' | 'result' | 'statusReason' | 'prompt'
  >,
): string | undefined {
  switch (subagentTone(subagent.status)) {
    case 'running':
      return (
        firstLine(subagent.activity) ??
        (subagent.status === 'pending' ? 'Starting…' : firstLine(subagent.prompt))
      )
    case 'waiting': {
      // What it wants to do, when the runtime said, after what it waits on.
      const doing = firstLine(subagent.activity)
      const reason = subagentWaitReason(subagent.waitingOn)
      return doing ? `${reason} · ${doing}` : reason
    }
    case 'done':
      return firstLine(subagent.result) ?? firstLine(subagent.prompt)
    case 'failed':
      return firstLine(subagent.statusReason) ?? firstLine(subagent.result)
    case 'stopped':
      return firstLine(subagent.statusReason) ?? firstLine(subagent.result)
  }
}

/** What the card's name is: its title, else its kind, else a plain word. */
export function subagentName(subagent: Pick<Subagent, 'title' | 'agentType'>): string {
  return subagent.title.trim() || subagent.agentType?.trim() || 'Subagent'
}

const instant = (iso: string | undefined) => {
  const at = iso ? Date.parse(iso) : Number.NaN
  return Number.isNaN(at) ? undefined : at
}

/**
 * How long it has run. While it runs, from its start to `now`, so the card
 * ticks; once settled, what the provider reported, else start to finish.
 * Undefined when nothing says.
 */
export function subagentElapsedMs(
  subagent: Pick<Subagent, 'status' | 'stats' | 'startedAt' | 'finishedAt'>,
  now: number,
): number | undefined {
  const started = instant(subagent.startedAt)
  if (!isSettledSubagentStatus(subagent.status)) {
    if (started === undefined) return subagent.stats.durationMs
    // A reported duration can run ahead of this clock; never tick backwards.
    return Math.max(now - started, subagent.stats.durationMs ?? 0, 0)
  }
  if (subagent.stats.durationMs !== undefined) return subagent.stats.durationMs
  const finished = instant(subagent.finishedAt)
  return started !== undefined && finished !== undefined
    ? Math.max(0, finished - started)
    : undefined
}

/** "8s", "1m 12s", "1h 4m": the elapsed time at a glance. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

/** "1 tool", "14 tools"; empty while nothing says. */
export function subagentToolCount(stats: Subagent['stats']): string {
  if (stats.toolCalls === undefined) return ''
  return stats.toolCalls === 1 ? '1 tool' : `${stats.toolCalls} tools`
}

const PROVIDER_NAMES: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  codex: 'Codex',
}

/** The name a provider goes by, for one the catalog has not named. */
export function providerName(providerId: string): string {
  return (
    PROVIDER_NAMES[providerId] ??
    (providerId ? providerId[0]!.toUpperCase() + providerId.slice(1) : 'Agent')
  )
}

/**
 * The model, short: the catalog's name for it when known, else the id with a
 * trailing date stamp cut (`claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`).
 */
export function subagentModelLabel(
  modelId: string | undefined,
  models?: ReadonlyArray<{ modelId: string; name: string }>,
): string | undefined {
  if (!modelId) return undefined
  const named = models?.find((model) => model.modelId === modelId)?.name
  return named ?? modelId.replace(/[-@]\d{8}$/, '')
}

/**
 * The line under a group's header: how many there are, and how they stand.
 * "3 subagents · 2 working, 1 done".
 */
export function subagentGroupSummary(subagents: readonly Pick<Subagent, 'status'>[]): {
  title: string
  detail: string
  running: boolean
  /** How many stand in each tone, in the order the detail reads them. */
  segments: Array<{ tone: SubagentTone; count: number }>
} {
  const counts = new Map<SubagentTone, number>()
  for (const subagent of subagents) {
    const tone = subagentTone(subagent.status)
    counts.set(tone, (counts.get(tone) ?? 0) + 1)
  }
  const order: Array<[SubagentTone, string]> = [
    ['waiting', 'need you'],
    ['running', 'working'],
    ['done', 'done'],
    ['failed', 'failed'],
    ['stopped', 'stopped'],
  ]
  const detail = order
    .filter(([tone]) => counts.get(tone))
    .map(([tone, word]) => {
      const count = counts.get(tone)!
      return `${count} ${tone === 'waiting' && count === 1 ? 'needs you' : word}`
    })
    .join(', ')
  const running = (counts.get('running') ?? 0) + (counts.get('waiting') ?? 0) > 0
  return {
    title: `${subagents.length} subagents`,
    detail,
    running,
    segments: order
      .filter(([tone]) => counts.get(tone))
      .map(([tone]) => ({ tone, count: counts.get(tone)! })),
  }
}
