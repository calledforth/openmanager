import { isSettledSubagentStatus, type Subagent } from '@openmanager/protocol/node'

/**
 * Telling a parent agent that subagents it started with `spawn_agent` have
 * finished. See docs/decisions/subagents.md, "Waking the parent".
 *
 * An MCP tool cannot start a turn in the model, but the environment owns the
 * parent session, so it queues the parent a message: it runs as soon as the
 * parent is idle, or after its current turn, the same for every provider.
 * Children that settle within `coalesceMs` of each other share one message,
 * so four children finishing together cost the parent one turn, not four.
 *
 * Nothing wakes for a child whose answer the parent already read (`wait_agent`,
 * a foreground `spawn_agent`), nor for one stopped by the user or the agent:
 * the caller marks those delivered before they settle.
 */

/** How long to hold a wake for others that settle at about the same time. */
export const WAKE_COALESCE_MS = 1_500
/** How much of each answer the wake message carries; the rest is a `wait_agent` away. */
export const WAKE_RESULT_MAX = 4_000
/** The whole message stays inside the queue's own bound for one item. */
export const WAKE_MESSAGE_MAX = 20_000

export function wakeMessage(
  children: readonly Subagent[],
  resultOf: (subagentId: string) => string | undefined,
): string {
  const head =
    children.length === 1
      ? 'A subagent you started has finished.'
      : `${children.length} subagents you started have finished.`
  let budget = WAKE_MESSAGE_MAX - head.length
  const blocks = children.map((child) => {
    const label = `${child.subagentId} (${child.title}) on ${child.providerId}${child.modelId ? `/${child.modelId}` : ''}: ${child.status}`
    const reason = child.statusReason ? `\nReason: ${child.statusReason}` : ''
    const answer = resultOf(child.subagentId) ?? child.result
    if (!answer) return `${label}${reason}\nIt gave no answer.`
    const room = Math.max(0, Math.min(WAKE_RESULT_MAX, budget - label.length - 200))
    const cut =
      answer.length > room
        ? `${answer.slice(0, room)}\n[… cut; wait_agent with id ${child.subagentId} reads the whole answer]`
        : answer
    budget -= label.length + cut.length
    return `${label}${reason}\nAnswer:\n${cut}`
  })
  return `<subagents-finished>\n${head}\n\n${blocks.join('\n\n')}\n</subagents-finished>`
}

export interface WakeDeps {
  /** Queue the parent one message with `origin: 'subagents'`. False when the parent is gone. */
  enqueue(parentSessionId: string, text: string, subagentIds: readonly string[]): boolean
  /** The current record, read when the wake fires: a child may have been marked meanwhile. */
  get(parentSessionId: string, subagentId: string): Subagent | undefined
  resultOf(parentSessionId: string, subagentId: string): string | undefined
  coalesceMs?: number
  setTimer?: (run: () => void, ms: number) => { cancel(): void }
}

/**
 * Tracks which children of ours still owe their parent a wake, and sends it.
 * Fed every record change; only an `openmanager` child that settles undelivered
 * counts.
 */
export function createSubagentWake(deps: WakeDeps) {
  const delivered = new Set<string>()
  /** parent session → subagent ids settled and waiting to be told. */
  const pending = new Map<string, Set<string>>()
  const timers = new Map<string, { cancel(): void }>()
  const coalesceMs = deps.coalesceMs ?? WAKE_COALESCE_MS
  const setTimer =
    deps.setTimer ??
    ((run: () => void, ms: number) => {
      const handle = setTimeout(run, ms)
      handle.unref?.()
      return { cancel: () => clearTimeout(handle) }
    })

  const key = (parentSessionId: string, subagentId: string) => `${parentSessionId}\u0000${subagentId}`

  const flush = (parentSessionId: string) => {
    timers.delete(parentSessionId)
    const ids = pending.get(parentSessionId)
    pending.delete(parentSessionId)
    if (!ids) return
    const children = [...ids]
      .filter((id) => !delivered.has(key(parentSessionId, id)))
      .map((id) => deps.get(parentSessionId, id))
      .filter((child): child is Subagent => !!child && isSettledSubagentStatus(child.status))
    if (children.length === 0) return
    const text = wakeMessage(children, (id) => deps.resultOf(parentSessionId, id))
    const woken = children.map((child) => child.subagentId)
    if (deps.enqueue(parentSessionId, text, woken)) {
      for (const id of woken) delivered.add(key(parentSessionId, id))
    }
  }

  return {
    /** The parent read this child's answer itself, or someone stopped it: never wake for it. */
    markDelivered(parentSessionId: string, subagentId: string) {
      delivered.add(key(parentSessionId, subagentId))
      pending.get(parentSessionId)?.delete(subagentId)
    },
    /** A child's answer is owed again: a follow-up (`send_agent`, or the user) started a new run. */
    reopen(parentSessionId: string, subagentId: string) {
      delivered.delete(key(parentSessionId, subagentId))
    },
    observe(subagent: Subagent) {
      if (subagent.origin !== 'openmanager') return
      if (!isSettledSubagentStatus(subagent.status)) return
      if (subagent.status === 'cancelled') return
      const id = key(subagent.parentSessionId, subagent.subagentId)
      if (delivered.has(id)) return
      let ids = pending.get(subagent.parentSessionId)
      if (!ids) pending.set(subagent.parentSessionId, (ids = new Set()))
      ids.add(subagent.subagentId)
      if (!timers.has(subagent.parentSessionId)) {
        timers.set(
          subagent.parentSessionId,
          setTimer(() => flush(subagent.parentSessionId), coalesceMs),
        )
      }
    },
    /** The parent is gone: drop what it was owed. */
    forgetParent(parentSessionId: string) {
      timers.get(parentSessionId)?.cancel()
      timers.delete(parentSessionId)
      pending.delete(parentSessionId)
    },
    dispose() {
      for (const timer of timers.values()) timer.cancel()
      timers.clear()
      pending.clear()
    },
  }
}

export type SubagentWake = ReturnType<typeof createSubagentWake>
