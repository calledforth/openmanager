import {
  SubagentSchema,
  isSettledSubagentStatus,
  type InteractionKind,
  type Subagent,
  type SubagentOrigin,
  type SubagentStatus,
} from '@openmanager/protocol/node'
import type { HostDeps } from '@agentpack/runtime/node'

/**
 * The subagent record, built from what a runtime reported about it
 * (docs/decisions/subagents.md, The record). Pure: the thread service owns
 * where a record is filed and when it is announced.
 */

type RuntimeEvent = Parameters<HostDeps['emitEvent']>[0]
export type SubtaskUpdate = Extract<RuntimeEvent, { event: 'subtask_update' }>['data']

/** What the record says beyond what its runtime reported: where it is filed. */
export type SubagentPlace = {
  subagentId: string
  parentSessionId: string
  turnId: string
  toolCallId?: string
  parentSubagentId?: string
  /** Its depth when the runtime does not say: one below the subagent that started it. */
  depth: number
  origin: SubagentOrigin
  providerId: string
  childSessionId?: string
}

/** Where the record stands besides what the runtime reported. */
export type SubagentTimes = {
  startedAt: string
  finishedAt?: string
  updatedAt: string
}

const SUBAGENT_FALLBACK_TITLE = 'Subagent'

/** Cut to the schema's bound, marking the cut, so a preview never fails the record. */
export function preview(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** The runtime's status in the record's terms; `unknown` says nothing new. */
export function subagentStatusOf(
  status: SubtaskUpdate['status'],
): Exclude<SubagentStatus, 'waiting'> | undefined {
  return status === undefined || status === 'unknown' ? undefined : status
}

/**
 * Lay a report over what was reported before: a field the report leaves out
 * keeps its value. A subagent revived after it settled starts over on what
 * belongs to one run (its answer, why it ended, what it was doing).
 */
export function mergeReport(previous: SubtaskUpdate, update: SubtaskUpdate): SubtaskUpdate {
  const reported = subagentStatusOf(update.status)
  const priorStatus = subagentStatusOf(previous.status)
  const revived =
    reported !== undefined &&
    !isSettledSubagentStatus(reported) &&
    priorStatus !== undefined &&
    isSettledSubagentStatus(priorStatus)
  const base: SubtaskUpdate = revived
    ? { ...previous, resultText: undefined, statusReason: undefined, currentActivity: undefined }
    : previous
  const merged: SubtaskUpdate = { ...base }
  for (const [key, value] of Object.entries(update) as [keyof SubtaskUpdate, unknown][]) {
    if (value === undefined) continue
    if (key === 'status' && value === 'unknown') continue
    ;(merged as Record<string, unknown>)[key] = value
  }
  return merged
}

const count = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.round(value))

const line = (text: string | undefined) => text?.trim().split('\n')[0]?.trim() || undefined

/**
 * The whole record. `waitingOn` is what the child's open request waits on,
 * when it has one: a running subagent blocked on the user reads `waiting`.
 */
export function subagentRecord(
  report: SubtaskUpdate,
  place: SubagentPlace,
  times: SubagentTimes,
  waitingOn: InteractionKind | undefined,
): Subagent {
  const reported = subagentStatusOf(report.status) ?? 'running'
  const status: SubagentStatus =
    waitingOn && !isSettledSubagentStatus(reported) ? 'waiting' : reported
  const title =
    report.title?.trim() || report.description?.trim() || report.subagentType?.trim() || ''
  const activity = line(report.currentActivity)
  const stats = {
    ...(count(report.toolCallCount) === undefined
      ? {}
      : { toolCalls: count(report.toolCallCount) }),
    ...(count(report.tokens) === undefined ? {} : { tokens: count(report.tokens) }),
    ...(count(report.durationMs) === undefined ? {} : { durationMs: count(report.durationMs) }),
  }
  return SubagentSchema.parse({
    subagentId: place.subagentId,
    parentSessionId: place.parentSessionId,
    turnId: place.turnId,
    ...(place.toolCallId ? { toolCallId: place.toolCallId } : {}),
    ...(place.parentSubagentId ? { parentSubagentId: place.parentSubagentId } : {}),
    depth: count(report.depth) || place.depth,
    origin: place.origin,
    providerId: place.providerId,
    ...(report.modelId ? { modelId: preview(report.modelId, 200) } : {}),
    ...(report.subagentType ? { agentType: preview(report.subagentType, 200) } : {}),
    title: preview(title || SUBAGENT_FALLBACK_TITLE, 500),
    ...(report.prompt ? { prompt: preview(report.prompt, 4000) } : {}),
    status,
    ...(status === 'waiting' ? { waitingOn } : {}),
    background: report.background ?? false,
    ...(place.childSessionId ? { childSessionId: place.childSessionId } : {}),
    promptable: report.promptable ?? !!report.childSessionId,
    stoppable: report.stoppable ?? false,
    stats,
    ...(activity ? { activity: preview(activity, 500) } : {}),
    ...(report.resultText?.trim() ? { result: preview(report.resultText.trim(), 4000) } : {}),
    ...(report.statusReason?.trim()
      ? { statusReason: preview(report.statusReason.trim(), 1000) }
      : {}),
    startedAt: times.startedAt,
    ...(isSettledSubagentStatus(status) && times.finishedAt
      ? { finishedAt: times.finishedAt }
      : {}),
    updatedAt: times.updatedAt,
  })
}

/** Whether two records say the same thing, whenever each was stated. */
export function sameRecord(left: Subagent, right: Subagent): boolean {
  return JSON.stringify({ ...left, updatedAt: '' }) === JSON.stringify({ ...right, updatedAt: '' })
}

/**
 * What a stored record says its runtime reported, for a subagent reported
 * again after a restart: enough to state it whole again.
 */
export function reportOf(taskId: string, record: Subagent): SubtaskUpdate {
  return {
    taskId,
    status: record.status === 'waiting' ? 'running' : record.status,
    ...(record.title !== SUBAGENT_FALLBACK_TITLE ? { title: record.title } : {}),
    ...(record.prompt ? { prompt: record.prompt } : {}),
    ...(record.agentType ? { subagentType: record.agentType } : {}),
    ...(record.modelId ? { modelId: record.modelId } : {}),
    ...(record.stats.toolCalls === undefined ? {} : { toolCallCount: record.stats.toolCalls }),
    ...(record.stats.tokens === undefined ? {} : { tokens: record.stats.tokens }),
    ...(record.stats.durationMs === undefined ? {} : { durationMs: record.stats.durationMs }),
    ...(record.activity ? { currentActivity: record.activity } : {}),
    ...(record.result ? { resultText: record.result } : {}),
    ...(record.statusReason ? { statusReason: record.statusReason } : {}),
    depth: record.depth,
    background: record.background,
    stoppable: record.stoppable,
    promptable: record.promptable,
  }
}
