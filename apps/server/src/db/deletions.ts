import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ProofEventSchemas, type ProofEvent } from '@openmanager/protocol/node'

/**
 * What deleting a session or removing a workspace takes with it, as events
 * (docs/sync-foundations.md §4.4, §4.7.8 item 5). The foreign keys still do
 * the deleting; these events say so first, in the same transaction, so no
 * client mirrors a cascade and a replay carries every removal:
 *
 * - every session under the deleted ones, deepest first, each after a
 *   `draft.deleted` for its own draft when it has one;
 * - for a workspace, a `draft.saved` that detaches each of its new-session
 *   drafts (`workspaceId: null`), which the user keeps.
 *
 * The projections assert that nothing is left for a foreign key to remove
 * silently: a session with children or a draft, or a workspace with sessions
 * or attached drafts, refuses its deletion.
 */

type DraftRow = {
  draft_id: string
  session_id: string | null
  launch_session_id: string | null
  content_json: string
  revision: number
  created_at: number
}

const iso = (at: number) => new Date(at).toISOString()

function event(environmentId: string, at: number, name: ProofEvent['name'], payload: unknown) {
  const schema = ProofEventSchemas[name] as { parse(input: unknown): ProofEvent }
  return schema.parse({
    type: 'event',
    name,
    eventId: randomUUID(),
    timestamp: iso(at),
    scope: { type: 'environment', environmentId },
    payload,
  })
}

/** These sessions and every session under them, deepest first. */
function sessionTree(database: DatabaseSync, roots: readonly string[]): string[] {
  if (roots.length === 0) return []
  const rows = database
    .prepare(
      `WITH RECURSIVE tree(session_id, depth) AS (
         SELECT session_id, 0 FROM sessions WHERE session_id IN (SELECT value FROM json_each(?))
         UNION ALL
         SELECT sessions.session_id, tree.depth + 1
         FROM sessions JOIN tree ON sessions.parent_session_id = tree.session_id
       )
       SELECT session_id, MAX(depth) AS depth FROM tree
       GROUP BY session_id ORDER BY depth DESC, session_id`,
    )
    .all(JSON.stringify(roots)) as { session_id: string }[]
  return rows.map((row) => row.session_id)
}

function sessionRemovals(
  database: DatabaseSync,
  environmentId: string,
  sessions: readonly string[],
  at: number,
): ProofEvent[] {
  const liveDraft = database.prepare(
    'SELECT draft_id, revision FROM drafts WHERE session_id = ? AND deleted_at IS NULL',
  )
  return sessions.flatMap((sessionId) => {
    const draft = liveDraft.get(sessionId) as { draft_id: string; revision: number } | undefined
    return [
      ...(draft
        ? [
            event(environmentId, at, 'draft.deleted', {
              draftId: draft.draft_id,
              revision: draft.revision + 1,
              sessionId,
            }),
          ]
        : []),
      event(environmentId, at, 'session.deleted', { sessionId }),
    ]
  })
}

/** The events that delete these sessions and everything under them. */
export function sessionDeletionEvents(
  database: DatabaseSync,
  environmentId: string,
  sessionIds: readonly string[],
  at: number,
): ProofEvent[] {
  return sessionRemovals(database, environmentId, sessionTree(database, sessionIds), at)
}

/**
 * The events that remove a workspace: its sessions and their drafts, its
 * new-session drafts detached, then `workspace.removed`, whose projection
 * deletes the row.
 */
export function workspaceRemovalEvents(
  database: DatabaseSync,
  environmentId: string,
  workspaceId: string,
  at: number,
): ProofEvent[] {
  // Every session in it, children too: the tree orders them by their deepest
  // place, so a child goes before its parent wherever each one is listed.
  const roots = (
    database.prepare('SELECT session_id FROM sessions WHERE workspace_id = ?').all(workspaceId) as {
      session_id: string
    }[]
  ).map((row) => row.session_id)
  const drafts = database
    .prepare(
      `SELECT draft_id, session_id, launch_session_id, content_json, revision, created_at
       FROM drafts WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at, draft_id`,
    )
    .all(workspaceId) as unknown as DraftRow[]
  return [
    ...sessionRemovals(database, environmentId, sessionTree(database, roots), at),
    // The user keeps what they typed; the draft only loses its project.
    ...drafts.map((draft) =>
      event(environmentId, at, 'draft.saved', {
        draft: {
          draftId: draft.draft_id,
          target: {
            type: 'new_session',
            workspaceId: null,
            sessionId: draft.launch_session_id ?? draft.draft_id,
          },
          content: JSON.parse(draft.content_json),
          revision: draft.revision + 1,
          createdAt: iso(draft.created_at),
          updatedAt: iso(at),
          updatedByClientId: null,
        },
      }),
    ),
    event(environmentId, at, 'workspace.removed', { workspaceId }),
  ]
}
