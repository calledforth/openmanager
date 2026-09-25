import type { ProviderId } from '@agentpack/contract'

// The sidebar's view of sessions and projects, independent of any host.

export interface SidebarSession {
  externalId: string
  title?: string
  status: string
  providerId?: ProviderId
  parentExternalId?: string
  /** Its project folder is unreachable, so the row cannot run until it is back. */
  workspaceUnavailable?: boolean
  /** ISO time of the last activity, when the host tracks it. */
  updatedAt?: string
  /** ISO time the user settled it; null or absent while it is active. */
  settledAt?: string | null
}

export interface SidebarWorkspace {
  path: string
  name: string
  /** Registered but not on disk right now; no session can start here. */
  missing?: boolean
  availability?: 'available' | 'missing' | 'inaccessible'
  /** The checkout's branch (null when detached) and whether it is a linked worktree. */
  git?: { branch: string | null; worktree: boolean }
  sessions: SidebarSession[]
}

export interface SidebarSessionRow {
  session: SidebarSession
  depth: number
  isChild: boolean
  isOrphan: boolean
}

/** Preserve recency order within each level while placing child transcripts
 * directly beneath their parent. Missing parents and cycles remain visible. */
export function flattenSidebarSessions(sessions: SidebarSession[]): SidebarSessionRow[] {
  const byId = new Map(sessions.map((session) => [session.externalId, session]))
  const children = new Map<string, SidebarSession[]>()
  const roots: SidebarSession[] = []
  for (const session of sessions) {
    if (session.parentExternalId && byId.has(session.parentExternalId)) {
      const siblings = children.get(session.parentExternalId) ?? []
      siblings.push(session)
      children.set(session.parentExternalId, siblings)
    } else {
      roots.push(session)
    }
  }

  const rows: SidebarSessionRow[] = []
  const visited = new Set<string>()
  const visit = (session: SidebarSession, depth: number, isOrphan: boolean) => {
    if (visited.has(session.externalId)) return
    visited.add(session.externalId)
    rows.push({
      session,
      depth,
      isChild: !!session.parentExternalId,
      isOrphan,
    })
    for (const child of children.get(session.externalId) ?? []) {
      visit(child, depth + 1, false)
    }
  }

  for (const root of roots) {
    visit(root, 0, !!root.parentExternalId)
  }
  for (const session of sessions) {
    if (!visited.has(session.externalId)) visit(session, 0, true)
  }
  return rows
}
