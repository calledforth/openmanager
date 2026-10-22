import type { DatabaseSync } from 'node:sqlite'
import { WorkspaceSchema, type Workspace, type WorkspaceGit } from '@openmanager/protocol/node'

/**
 * A workspace as its row describes it, the one reader every path shares: the
 * registry's listing, the environment snapshot, the projection's check of
 * what a `workspace.updated` said, and the repository's derived recency
 * (docs/sync-foundations.md §4.4, §4.7.1). Nothing here touches the
 * filesystem: what the folder looked like is the last observation, stored.
 */

export type WorkspaceAvailability = 'available' | 'missing' | 'inaccessible'

/** What an observation of a folder found: whether it is a checkout, and its head. */
export interface GitReading {
  checkout: boolean
  git?: WorkspaceGit
}

export interface WorkspaceRow {
  workspace_id: string
  name: string
  path: string
  availability: WorkspaceAvailability
  last_used_at: number | null
  git_json: string | null
}

const WORKSPACE_COLUMNS = 'workspace_id, name, path, availability, last_used_at, git_json'

export function readWorkspaceRow(
  database: DatabaseSync,
  workspaceId: string,
): WorkspaceRow | undefined {
  return database
    .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE workspace_id = ?`)
    .get(workspaceId) as WorkspaceRow | undefined
}

/** Every workspace in registration order. */
export function readWorkspaceRows(database: DatabaseSync): WorkspaceRow[] {
  return database
    .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces ORDER BY created_at, rowid`)
    .all() as unknown as WorkspaceRow[]
}

/** The stored reading, or none when the folder is unavailable or was never observed. */
export function gitReadingOf(row: Pick<WorkspaceRow, 'git_json'>): GitReading | undefined {
  return row.git_json === null ? undefined : (JSON.parse(row.git_json) as GitReading)
}

/** The column value for a reading: kept only while the folder is available. */
export function gitJsonOf(
  availability: WorkspaceAvailability,
  reading: GitReading | undefined,
): string | null {
  return availability === 'available' && reading ? JSON.stringify(reading) : null
}

/** Latest session `updated_at` of one workspace, or null when it has none. */
export function lastSessionActivity(database: DatabaseSync, workspaceId: string): number | null {
  const row = database
    .prepare('SELECT MAX(updated_at) AS at FROM sessions WHERE workspace_id = ?')
    .get(workspaceId) as { at: number | null }
  return row.at
}

/** Latest session `updated_at` per workspace, in one grouped read. */
export function lastSessionActivities(database: DatabaseSync): Map<string, number> {
  const rows = database
    .prepare(
      'SELECT workspace_id, MAX(updated_at) AS at FROM sessions GROUP BY workspace_id',
    )
    .all() as { workspace_id: string; at: number | null }[]
  const activity = new Map<string, number>()
  for (const row of rows) if (row.at !== null) activity.set(row.workspace_id, row.at)
  return activity
}

/**
 * A workspace's recency: its newest session's time, or the last time a
 * session started there, whichever is later.
 */
export function lastActivityOf(
  row: Pick<WorkspaceRow, 'last_used_at'>,
  sessionLast: number | null,
): number | null {
  if (sessionLast === null) return row.last_used_at
  return row.last_used_at === null ? sessionLast : Math.max(sessionLast, row.last_used_at)
}

const toIso = (epochMs: number | null): string | null =>
  epochMs === null ? null : new Date(epochMs).toISOString()

/** The public workspace a row describes, given its sessions' latest time. */
export function workspaceFromRow(row: WorkspaceRow, sessionLast: number | null): Workspace {
  const exists = row.availability === 'available'
  const reading = exists ? gitReadingOf(row) : undefined
  return WorkspaceSchema.parse({
    workspaceId: row.workspace_id,
    name: row.name,
    path: row.path,
    lastUsedAt: toIso(row.last_used_at),
    lastActivityAt: toIso(lastActivityOf(row, sessionLast)),
    exists,
    availability: row.availability,
    capabilities: { git: reading?.checkout === true },
    ...(reading?.git ? { git: reading.git } : {}),
  })
}

/** One workspace, read from its row and its sessions. */
export function readWorkspace(database: DatabaseSync, workspaceId: string): Workspace | undefined {
  const row = readWorkspaceRow(database, workspaceId)
  return row ? workspaceFromRow(row, lastSessionActivity(database, workspaceId)) : undefined
}

/** Every workspace, in registration order, read from rows only. */
export function readWorkspaces(database: DatabaseSync): Workspace[] {
  const activity = lastSessionActivities(database)
  return readWorkspaceRows(database).map((row) =>
    workspaceFromRow(row, activity.get(row.workspace_id) ?? null),
  )
}
