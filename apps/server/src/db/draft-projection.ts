import type { DatabaseSync } from 'node:sqlite'
import type { Draft, DraftContent } from '@openmanager/protocol/node'

const EMPTY_CONTENT_JSON = JSON.stringify({ text: '' } satisfies DraftContent)

/**
 * Projection statements for `draft.saved` and `draft.deleted`, run inside the
 * event transaction. A deleted draft keeps its row, emptied, as the tombstone
 * that refuses saves based on an older revision. A save on top of it keeps
 * `deleted_revision`, so those saves stay refused.
 */
export function prepareDraftProjection(database: DatabaseSync) {
  const upsert = database.prepare(`
    INSERT INTO drafts (
      draft_id, session_id, workspace_id, launch_session_id, content_json, revision,
      updated_by_client_id, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(draft_id) DO UPDATE SET
      session_id = excluded.session_id,
      workspace_id = excluded.workspace_id,
      launch_session_id = excluded.launch_session_id,
      content_json = excluded.content_json,
      revision = excluded.revision,
      updated_by_client_id = excluded.updated_by_client_id,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `)
  const tombstone = database.prepare(`
    INSERT INTO drafts (
      draft_id, session_id, content_json, revision, created_at, updated_at, deleted_at,
      deleted_revision
    ) VALUES (?, ?, '${EMPTY_CONTENT_JSON}', ?, ?, ?, ?, ?)
    ON CONFLICT(draft_id) DO UPDATE SET
      content_json = excluded.content_json,
      revision = excluded.revision,
      updated_by_client_id = NULL,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at,
      deleted_revision = excluded.deleted_revision
  `)
  return {
    saved(draft: Draft) {
      upsert.run(
        draft.draftId,
        draft.target.type === 'session' ? draft.target.sessionId : null,
        draft.target.type === 'new_session' ? draft.target.workspaceId : null,
        draft.target.type === 'new_session' ? draft.target.sessionId : null,
        JSON.stringify(draft.content),
        draft.revision,
        draft.updatedByClientId,
        Date.parse(draft.createdAt),
        Date.parse(draft.updatedAt),
      )
    },
    deleted(payload: { draftId: string; revision: number; sessionId: string | null }, at: number) {
      tombstone.run(
        payload.draftId,
        payload.sessionId,
        payload.revision,
        at,
        at,
        at,
        payload.revision,
      )
    },
  }
}
