import type { HomeSession } from '../home/rows'

/**
 * The sessions the environment lists under `parentId`, in the order the
 * shared listing hands them out: the phone keeps no ordering of its own.
 */
export function childSessionsOf(sessions: readonly HomeSession[], parentId: string): HomeSession[] {
  return sessions.filter((session) => session.parentExternalId === parentId)
}
