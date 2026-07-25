// Pure reducer that folds runs of consecutive tool parts into a single
// summarised activity row ("Edited 4 files, explored 2 files, ran 3 commands").
// Mirrors the flush-on-boundary shape of `foldExploreGroups` in
// `@agentpack/view`, but operates on the rendered message-part list instead of
// raw agent events, and covers every tool category rather than reads alone.
//
// Reasoning, assistant text, plans and anything the user must read or act on
// (permission prompts, failures) act as barriers: they stay on their own row
// and split the surrounding tools into separate groups.

import { canonicalizeToolName } from './tool-meta'
import { countDiffStats, formatToolOutput, getToolStateType, isToolRunning } from './tool-presenter'

export type ActivityCategory = 'edit' | 'read' | 'search' | 'shell' | 'other'

export interface ActivitySummary {
  /** Past-tense phrase for a settled group. */
  text: string
  /** Present-tense phrase used while any member is still running. */
  runningText: string
  diffAdded: number
  diffRemoved: number
  isRunning: boolean
  toolCount: number
}

export type ActivityNode<T> =
  { kind: 'part'; part: T } | { kind: 'group'; id: string; items: T[]; summary: ActivitySummary }

export interface GroupActivityOptions {
  /** Tool call awaiting approval — kept on its own row so the prompt stays visible. */
  pendingPermissionCallId?: string | null
  /**
   * Runs shorter than this render as plain rows. Defaults to 1 so a live turn
   * shows one summary line from the first tool call onward, rewriting itself as
   * the run grows rather than listing each call as it lands.
   */
  minGroupSize?: number
}

interface ToolPartShape {
  type: string
  id: string
  tool?: unknown
  /** ACP tool kind, carried alongside the provider's human-readable title. */
  kind?: unknown
  callID?: unknown
  state?: {
    type?: string
    status?: string
    input?: unknown
    output?: unknown
    error?: string
  }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'WebFetch'])

/** Tools that carry standalone meaning and never fold into a count. */
const BARRIER_TOOLS = new Set(['TodoWrite', 'Task', 'AskUserQuestion'])

/**
 * Providers put a human-readable title in `tool` ("Read File", "Searched
 * files"), so the canonical-name lookup misses for everything but OpenCode.
 * The ACP `kind` is the dependable signal.
 */
const KIND_CATEGORIES: Record<string, ActivityCategory> = {
  read: 'read',
  search: 'search',
  fetch: 'search',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  execute: 'shell',
}

const CATEGORY_ORDER: ActivityCategory[] = ['edit', 'read', 'search', 'shell', 'other']

function isToolError(stateType: string): boolean {
  return /error|fail/i.test(stateType)
}

function toolCategory(part: ToolPartShape): ActivityCategory {
  const canonical = canonicalizeToolName(typeof part.tool === 'string' ? part.tool : '')
  if (EDIT_TOOLS.has(canonical)) return 'edit'
  if (canonical === 'Read') return 'read'
  if (SEARCH_TOOLS.has(canonical)) return 'search'
  if (canonical === 'Bash') return 'shell'
  const kind = typeof part.kind === 'string' ? part.kind.toLowerCase() : ''
  return KIND_CATEGORIES[kind] ?? 'other'
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function isGroupable(part: ToolPartShape, pendingPermissionCallId?: string | null): boolean {
  if (part.type !== 'tool') return false
  const toolName = typeof part.tool === 'string' ? part.tool : ''
  if (BARRIER_TOOLS.has(canonicalizeToolName(toolName))) return false
  if (isToolError(getToolStateType(part.state))) return false
  const callId = typeof part.callID === 'string' ? part.callID : undefined
  if (pendingPermissionCallId && callId && callId === pendingPermissionCallId) return false
  return true
}

function summarise(items: readonly ToolPartShape[]): ActivitySummary {
  const counts = new Map<ActivityCategory, number>()
  let diffAdded = 0
  let diffRemoved = 0
  let isRunning = false

  for (const item of items) {
    const category = toolCategory(item)
    counts.set(category, (counts.get(category) ?? 0) + 1)
    const running = isToolRunning(getToolStateType(item.state))
    if (running) isRunning = true
    if (category === 'edit' && !running) {
      const stats = countDiffStats(formatToolOutput(item.state?.output ?? item.state?.error))
      diffAdded += stats.added
      diffRemoved += stats.removed
    }
  }

  const past: string[] = []
  const running: string[] = []
  for (const category of CATEGORY_ORDER) {
    const count = counts.get(category)
    if (!count) continue
    switch (category) {
      case 'edit':
        past.push(`edited ${plural(count, 'file')}`)
        running.push(`editing ${plural(count, 'file')}`)
        break
      case 'read':
        past.push(`explored ${plural(count, 'file')}`)
        running.push(`exploring ${plural(count, 'file')}`)
        break
      case 'search':
        // Follows a read segment as a bare count so the two read as one phrase:
        // "explored 3 files, 1 search".
        past.push(
          counts.get('read')
            ? plural(count, 'search', 'searches')
            : `explored ${plural(count, 'search', 'searches')}`,
        )
        running.push(
          counts.get('read')
            ? plural(count, 'search', 'searches')
            : `exploring ${plural(count, 'search', 'searches')}`,
        )
        break
      case 'shell':
        past.push(`ran ${plural(count, 'command')}`)
        running.push(`running ${plural(count, 'command')}`)
        break
      case 'other':
        past.push(`used ${plural(count, 'tool')}`)
        running.push(`using ${plural(count, 'tool')}`)
        break
    }
  }

  return {
    text: capitalise(past.join(', ')),
    runningText: capitalise(running.join(', ')),
    diffAdded,
    diffRemoved,
    isRunning,
    toolCount: items.length,
  }
}

function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text
}

export function groupActivityParts<T extends { type: string; id: string }>(
  parts: readonly T[],
  options: GroupActivityOptions = {},
): ActivityNode<T>[] {
  const minGroupSize = options.minGroupSize ?? 1
  const output: ActivityNode<T>[] = []
  let run: T[] = []

  const flush = () => {
    if (run.length === 0) return
    if (run.length < minGroupSize) {
      for (const part of run) output.push({ kind: 'part', part })
    } else {
      output.push({
        kind: 'group',
        // Anchored to the first member so appending during streaming keeps the
        // group's React identity (and its expanded state) stable.
        id: `activity:${run[0]!.id}`,
        items: run,
        summary: summarise(run as unknown as ToolPartShape[]),
      })
    }
    run = []
  }

  for (const part of parts) {
    if (isGroupable(part as unknown as ToolPartShape, options.pendingPermissionCallId)) {
      run.push(part)
      continue
    }
    flush()
    output.push({ kind: 'part', part })
  }
  flush()
  return output
}
