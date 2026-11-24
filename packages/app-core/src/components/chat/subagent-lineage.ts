import { useEffect, useRef, useState } from 'react'
import type { SessionSummary, Subagent } from '@openmanager/protocol'
import {
  subagentDetail,
  subagentTone,
  subagentWaitReason,
  type SubagentTone,
} from '../parts/subagent-card'

/**
 * The family tree of the subagents under one session: who started whom, at
 * any depth, native and spawned alike. Built from what a client already
 * holds: every child session's summary (each names its parent), joined to
 * the subagent records of whichever threads are held, which add the model,
 * the clock and what it is doing now. A child whose parent's thread is not
 * held still has a node, drawn from its summary alone.
 */

/** What the dock needs of a session: the summary fields plus the threads that hold its records. */
export type LineageSession = Pick<
  SessionSummary,
  'sessionId' | 'title' | 'status' | 'providerId' | 'parentSessionId' | 'subagent' | 'waitingOn'
> & { threadIds?: readonly string[] }

export interface LineageNode {
  /** Stable across updates: the subagent id when known, else the child session's. */
  key: string
  /** Its child session, which a click opens. Absent for a record no session holds yet. */
  sessionId?: string
  /** The session whose agent started it. */
  parentSessionId: string
  /** The full record, when the thread it travels on is held. */
  subagent?: Subagent
  title: string
  providerId: string
  /** The record's status, or the one its summary implies. */
  status: Subagent['status']
  waitingOn?: Subagent['waitingOn']
  tone: SubagentTone
  /** It, or anything under it, is working or waiting. */
  live: boolean
  /** 1 under the root, 2 under that, and so on. */
  depth: number
  children: LineageNode[]
}

export interface Lineage {
  roots: LineageNode[]
  /** Every node, depth first. */
  all: LineageNode[]
  /** Nodes that are themselves working or waiting. */
  live: LineageNode[]
  /** Settled nodes (done, failed or stopped). */
  settled: number
}

const EMPTY: Lineage = { roots: [], all: [], live: [], settled: 0 }

/** A status for a child its record does not cover, from what its summary says. */
function statusOfSummary(session: LineageSession): Subagent['status'] {
  switch (session.status) {
    case 'running':
      return 'running'
    case 'waiting':
      return 'waiting'
    case 'error':
      return 'failed'
    case 'idle':
      return 'completed'
  }
}

/**
 * The lineage under `rootSessionId`. `threadSubagents` is the subagents
 * each held thread lists, by thread id (`state.threads[id].subagents`).
 */
export function buildLineage(
  rootSessionId: string | null | undefined,
  sessions: Readonly<Record<string, LineageSession>>,
  threadSubagents: (threadId: string) => readonly Subagent[] | undefined,
): Lineage {
  if (!rootSessionId || !sessions[rootSessionId]) return EMPTY
  const childrenOf = new Map<string, LineageSession[]>()
  for (const session of Object.values(sessions)) {
    if (!session.subagent || !session.parentSessionId) continue
    const siblings = childrenOf.get(session.parentSessionId) ?? []
    siblings.push(session)
    childrenOf.set(session.parentSessionId, siblings)
  }
  const seen = new Set<string>([rootSessionId])

  /** The records a session's threads hold: its own agent's subagents. */
  const recordsOf = (sessionId: string): readonly Subagent[] => {
    const out: Subagent[] = []
    for (const threadId of sessions[sessionId]?.threadIds ?? []) {
      out.push(...(threadSubagents(threadId) ?? []))
    }
    return out
  }

  const nodesUnder = (sessionId: string, depth: number): LineageNode[] => {
    if (depth > 16) return []
    const records = recordsOf(sessionId)
    const bySession = new Map<string, Subagent>()
    const byId = new Map<string, Subagent>()
    for (const record of records) {
      byId.set(record.subagentId, record)
      if (record.childSessionId) bySession.set(record.childSessionId, record)
    }
    const used = new Set<string>()
    const nodes: LineageNode[] = []
    for (const child of childrenOf.get(sessionId) ?? []) {
      if (seen.has(child.sessionId)) continue
      seen.add(child.sessionId)
      const record =
        bySession.get(child.sessionId) ??
        (child.subagent ? byId.get(child.subagent.subagentId) : undefined)
      if (record) used.add(record.subagentId)
      nodes.push(node(child.sessionId, sessionId, child, record, depth))
    }
    // A record whose child session has not reached this client yet.
    for (const record of records) {
      if (used.has(record.subagentId)) continue
      if (record.childSessionId && seen.has(record.childSessionId)) continue
      nodes.push(node(record.childSessionId, sessionId, undefined, record, depth))
    }
    return nodes.sort((left, right) => startOf(left).localeCompare(startOf(right)))
  }

  const node = (
    sessionId: string | undefined,
    parentSessionId: string,
    session: LineageSession | undefined,
    record: Subagent | undefined,
    depth: number,
  ): LineageNode => {
    const status = record?.status ?? (session ? statusOfSummary(session) : 'running')
    const tone = subagentTone(status)
    const children = sessionId ? nodesUnder(sessionId, depth + 1) : []
    const self = tone === 'running' || tone === 'waiting'
    const waitingOn = record?.waitingOn ?? session?.waitingOn
    return {
      key: record?.subagentId ?? session?.subagent?.subagentId ?? sessionId ?? parentSessionId,
      ...(sessionId ? { sessionId } : {}),
      parentSessionId,
      ...(record ? { subagent: record } : {}),
      title: record?.title.trim() || session?.title?.trim() || record?.agentType || 'Subagent',
      providerId: record?.providerId ?? session?.providerId ?? 'agent',
      status,
      ...(waitingOn && status === 'waiting' ? { waitingOn } : {}),
      tone,
      live: self || children.some((childNode) => childNode.live),
      depth,
      children,
    }
  }

  const roots = nodesUnder(rootSessionId, 1)
  const all: LineageNode[] = []
  const walk = (nodes: LineageNode[]) => {
    for (const item of nodes) {
      all.push(item)
      walk(item.children)
    }
  }
  walk(roots)
  const live = all.filter((item) => item.tone === 'running' || item.tone === 'waiting')
  return { roots, all, live, settled: all.length - live.length }
}

const startOf = (node: LineageNode) => node.subagent?.startedAt ?? ''

/**
 * The tree as rows to draw, depth first. Without `showSettled`, only what is
 * live and the ancestors that lead to it: a finished parent of a working
 * child stays, as context.
 */
export function lineageRows(
  lineage: Lineage,
  showSettled: boolean,
): Array<{ node: LineageNode; last: boolean; rails: boolean[] }> {
  const rows: Array<{ node: LineageNode; last: boolean; rails: boolean[] }> = []
  const walk = (nodes: LineageNode[], rails: boolean[]) => {
    const shown = showSettled ? nodes : nodes.filter((item) => item.live)
    shown.forEach((item, index) => {
      const last = index === shown.length - 1
      rows.push({ node: item, last, rails })
      walk(item.children, [...rails, !last])
    })
  }
  walk(lineage.roots, [])
  return rows
}

// ─── What the list shows, and when ──────────────────────────────────────────
//
// Shared by every surface that draws the open chat's subagents (web's rail
// and strip, the phone's strip), so they show and fade alike.

/** How long "All N done" stays before the list fades. */
export const ALL_DONE_LINGER_MS = 6_000

export type LineagePhase =
  | { kind: 'idle' }
  | { kind: 'live' }
  | { kind: 'done'; keys: ReadonlySet<string> }

/**
 * Whether the list shows, and for which subagents: while any is live, and
 * for `ALL_DONE_LINGER_MS` after the last of a burst settles (longer while
 * `held`). The burst is every subagent seen live since the list last hid.
 */
export function useLineagePhase(lineage: Lineage, held: boolean): LineagePhase {
  const burst = useRef(new Set<string>())
  const [phase, setPhase] = useState<LineagePhase>({ kind: 'idle' })
  const live = lineage.live.length > 0
  useEffect(() => {
    if (live) {
      for (const node of lineage.live) burst.current.add(node.key)
      setPhase((current) => (current.kind === 'live' ? current : { kind: 'live' }))
      return
    }
    setPhase((current) =>
      current.kind === 'live' && burst.current.size > 0
        ? { kind: 'done', keys: new Set(burst.current) }
        : current,
    )
  }, [live, lineage])
  useEffect(() => {
    if (phase.kind !== 'done' || held) return
    const timer = setTimeout(() => {
      burst.current.clear()
      setPhase({ kind: 'idle' })
    }, ALL_DONE_LINGER_MS)
    return () => clearTimeout(timer)
  }, [phase, held])
  return phase
}

/** The rows a phase shows: live ones and their way up, or the burst that just ended. */
export function lineagePhaseRows(lineage: Lineage, phase: LineagePhase, showSettled: boolean) {
  if (phase.kind === 'done') {
    return lineageRows(lineage, true).filter(({ node }) => phase.keys.has(node.key))
  }
  return lineageRows(lineage, showSettled)
}

/** "2 working · 1 needs you", or "All 3 done" once a burst has ended. */
export function lineageHeadline(lineage: Lineage, phase: LineagePhase): string {
  if (phase.kind === 'done') {
    const failed = lineage.all.filter(
      (node) => phase.keys.has(node.key) && node.tone === 'failed',
    ).length
    const count = phase.keys.size
    if (failed === 0) return count === 1 ? 'Subagent done' : `All ${count} done`
    return `${count - failed} done · ${failed} failed`
  }
  const waiting = lineage.live.filter((node) => node.tone === 'waiting').length
  const working = lineage.live.length - waiting
  return [
    working ? `${working} working` : '',
    waiting ? `${waiting} ${waiting === 1 ? 'needs' : 'need'} you` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The line under a row: what a working one is doing, what a waiting one
 * waits on, why a failed one failed. Nothing for one that is done or stopped.
 */
export function lineageNodeDetail(node: LineageNode): string | undefined {
  const record = node.subagent
  switch (node.tone) {
    case 'waiting':
      return subagentWaitReason(node.waitingOn)
    case 'running':
      return record ? subagentDetail(record) : undefined
    case 'failed':
      return record?.statusReason?.trim() || 'Failed'
    default:
      return undefined
  }
}
