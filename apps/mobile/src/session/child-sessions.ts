import type { Subagent } from '@openmanager/protocol'

import type { HomeSession } from '../home/rows'

/**
 * The sessions the environment lists under `parentId`, in the order the
 * shared listing hands them out: the phone keeps no ordering of its own.
 */
export function childSessionsOf(sessions: readonly HomeSession[], parentId: string): HomeSession[] {
  return sessions.filter((session) => session.parentExternalId === parentId)
}

/**
 * The children no subagent card stands for. A subagent's card sits in the
 * transcript where it was started and opens its child, so only a child the
 * thread holds no record of (one delegated before subagents had cards) is
 * still listed at the end.
 */
export function childSessionsWithoutCards(
  children: readonly HomeSession[],
  subagents: readonly Pick<Subagent, 'childSessionId'>[],
): readonly HomeSession[] {
  if (children.length === 0 || subagents.length === 0) return children
  const carded = new Set(subagents.map((subagent) => subagent.childSessionId))
  const rest = children.filter((child) => !carded.has(child.externalId))
  return rest.length === children.length ? children : rest
}
