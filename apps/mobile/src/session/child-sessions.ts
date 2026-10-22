import type { HomeSession } from '../home/rows'

/** The sessions the environment lists under `parentId`, newest activity first. */
export function childSessionsOf(sessions: readonly HomeSession[], parentId: string): HomeSession[] {
  const time = (session: HomeSession) => {
    const at = session.updatedAt ? Date.parse(session.updatedAt) : 0
    return Number.isFinite(at) ? at : 0
  }
  return sessions
    .filter((session) => session.parentExternalId === parentId)
    .sort((a, b) => time(b) - time(a))
}
