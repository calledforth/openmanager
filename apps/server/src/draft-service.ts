import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import {
  DRAFT_DELETED_MESSAGE,
  DRAFT_DELETE_CAPABILITY,
  DRAFT_LIST_CAPABILITY,
  DRAFT_SAVE_CAPABILITY,
  DRAFT_TEXT_MAX_LENGTH,
  DraftCommandSchemas,
  DraftContentSchema,
  DraftResponseSchemas,
  ProofEventSchemas,
  type CommandEnvelope,
  type Draft,
  type DraftContent,
  type DraftTarget,
  type DraftTombstone,
  type ErrorCode,
  type ProofEvent,
} from '@openmanager/protocol/node'
import type { CommandContext } from './command-context.ts'

/**
 * How long a sent or discarded new-session draft is remembered. A save from
 * before the send is refused for as long as the row is there; a client that
 * was offline for longer than this could bring the draft back.
 */
export const DRAFT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

type DraftRow = {
  draft_id: string
  session_id: string | null
  workspace_id: string | null
  launch_session_id: string | null
  content_json: string
  revision: number
  updated_by_client_id: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
  deleted_revision: number
}

export interface DraftServiceOptions {
  /** The connection the event log and its projection write through. */
  database: DatabaseSync
  environmentId: () => string
  /** Commits events and their projection in one transaction, after anything buffered. */
  appendAtomic: (events: readonly ProofEvent[]) => void
  now?: () => number
}

/** What a `session.create` sent from a draft: put back as the draft if the session is rolled back. */
export interface SentDraft {
  workspaceId: string
  sessionId: string
  content: DraftContent
}

/** What `session.create` needs to send a draft: the deletion, and its undo. */
export interface DraftLaunch {
  /** Appended in the transaction that announces the session. */
  event: ProofEvent
  /**
   * Puts the draft back, as it was sent, when the session it became is
   * rolled back, so the retry starts from what the user wrote. Does nothing
   * once another write has touched the draft.
   */
  restore: () => void
}

const errorResult = (
  requestId: string,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
) => ({
  type: 'error' as const,
  requestId,
  error: { code, message, ...(details ? { details } : {}) },
})

const iso = (ms: number) => new Date(ms).toISOString()

/**
 * Composer drafts, kept by the environment so every paired client sees the
 * same one (docs/decisions/composer-drafts.md).
 *
 * Every write is an environment event whose projection writes the row in the
 * same transaction, so a reconnecting client replays exactly what it missed.
 * Handlers read and append synchronously: no other command can land between
 * the revision check and the write.
 */
export function createDraftService(options: DraftServiceOptions) {
  const { database } = options
  const now = options.now ?? Date.now

  const selectDraft = database.prepare(`
    SELECT draft_id, session_id, workspace_id, launch_session_id, content_json, revision,
           updated_by_client_id, created_at, updated_at, deleted_at, deleted_revision
    FROM drafts WHERE draft_id = ?
  `)
  const selectAll = database.prepare(`
    SELECT draft_id, session_id, workspace_id, launch_session_id, content_json, revision,
           updated_by_client_id, created_at, updated_at, deleted_at, deleted_revision
    FROM drafts
    WHERE deleted_at IS NULL OR session_id IS NOT NULL
    ORDER BY updated_at DESC, draft_id
  `)
  const selectSession = database.prepare('SELECT 1 FROM sessions WHERE session_id = ?')
  const selectWorkspace = database.prepare('SELECT 1 FROM workspaces WHERE workspace_id = ?')
  const selectClient = database.prepare('SELECT 1 FROM authorized_clients WHERE client_id = ?')
  const pruneTombstones = database.prepare(`
    DELETE FROM drafts
    WHERE session_id IS NULL AND deleted_at IS NOT NULL AND deleted_at < ?
  `)

  const read = (draftId: string) => selectDraft.get(draftId) as DraftRow | undefined

  const toDraft = (row: DraftRow): Draft => ({
    draftId: row.draft_id,
    target: row.session_id
      ? { type: 'session', sessionId: row.session_id }
      : {
          type: 'new_session',
          workspaceId: row.workspace_id,
          // Only a blind tombstone lacks one, and those are never listed.
          sessionId: row.launch_session_id ?? row.draft_id,
        },
    content: DraftContentSchema.parse(JSON.parse(row.content_json)),
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    updatedByClientId: row.updated_by_client_id,
  })

  const environmentEvent = <N extends 'draft.saved' | 'draft.deleted'>(
    name: N,
    payload: unknown,
    at: number,
  ) =>
    ProofEventSchemas[name].parse({
      type: 'event',
      name,
      eventId: randomUUID(),
      timestamp: iso(at),
      scope: { type: 'environment', environmentId: options.environmentId() },
      payload,
    }) as ProofEvent

  const deletionEvent = (draftId: string, row: DraftRow | undefined, at: number) => {
    const sessionId =
      row?.session_id ?? (row === undefined && selectSession.get(draftId) ? draftId : null)
    const tombstone: DraftTombstone = { draftId, revision: (row?.revision ?? 0) + 1 }
    return {
      tombstone,
      event: environmentEvent('draft.deleted', { ...tombstone, sessionId }, at),
    }
  }

  const known = (clientId: string | undefined) =>
    clientId !== undefined && selectClient.get(clientId) !== undefined ? clientId : null

  const sameTarget = (row: DraftRow, target: DraftTarget) =>
    target.type === 'session'
      ? row.session_id === target.sessionId
      : row.session_id === null &&
        (row.launch_session_id === null || row.launch_session_id === target.sessionId)

  const save = (command: CommandEnvelope, context?: CommandContext) => {
    const parsed = DraftCommandSchemas[DRAFT_SAVE_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      return errorResult(command.requestId, 'validation', 'Invalid draft save request.')
    }
    const { draftId, baseRevision, content } = parsed.data.payload
    let target = parsed.data.payload.target
    if (target.type === 'session') {
      if (draftId !== target.sessionId) {
        return errorResult(
          command.requestId,
          'validation',
          "A session's draft is named by the session's id.",
        )
      }
      // The session runs on its own selection; a draft only carries what is sent.
      if (content.providerId !== undefined || content.preference !== undefined) {
        return errorResult(
          command.requestId,
          'validation',
          "A session's draft cannot hold model or mode picks.",
        )
      }
      if (!selectSession.get(target.sessionId)) {
        return errorResult(command.requestId, 'not_found', 'The session does not exist.')
      }
    } else if (target.workspaceId !== null && !selectWorkspace.get(target.workspaceId)) {
      // The project went away while this was being typed. The draft is kept,
      // as it is when the project is removed after the save.
      target = { ...target, workspaceId: null }
    }
    const row = read(draftId)
    if (row && !sameTarget(row, target)) {
      return errorResult(command.requestId, 'validation', 'A draft cannot move to another session.')
    }
    if (row && baseRevision < row.deleted_revision) {
      // Last write wins, except over a send or a discard: a save from before
      // either would bring back text that is gone or already in the chat,
      // or replace the draft written since on top of it.
      return errorResult(command.requestId, 'conflict', DRAFT_DELETED_MESSAGE, {
        draftId,
        revision: row.deleted_revision,
      })
    }
    if (row && row.deleted_at === null) {
      const current = toDraft(row)
      if (
        isDeepStrictEqual(current.target, target) &&
        isDeepStrictEqual(current.content, content)
      ) {
        return DraftResponseSchemas[DRAFT_SAVE_CAPABILITY].parse({
          type: 'response',
          requestId: command.requestId,
          payload: { draft: current },
        })
      }
    }
    const at = now()
    const draft: Draft = {
      draftId,
      target,
      content,
      revision: (row?.revision ?? 0) + 1,
      // A revived tombstone is a new draft as far as anyone can tell.
      createdAt: iso(row && row.deleted_at === null ? row.created_at : at),
      updatedAt: iso(at),
      updatedByClientId: known(context?.clientId),
    }
    options.appendAtomic([environmentEvent('draft.saved', { draft }, at)])
    return DraftResponseSchemas[DRAFT_SAVE_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: { draft },
    })
  }

  const remove = (command: CommandEnvelope) => {
    const parsed = DraftCommandSchemas[DRAFT_DELETE_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      return errorResult(command.requestId, 'validation', 'Invalid draft delete request.')
    }
    const { draftId, baseRevision } = parsed.data.payload
    const row = read(draftId)
    if (row?.deleted_at != null) {
      return DraftResponseSchemas[DRAFT_DELETE_CAPABILITY].parse({
        type: 'response',
        requestId: command.requestId,
        payload: { draftId, revision: row.revision },
      })
    }
    if (row && baseRevision < row.deleted_revision) {
      // A clear from before the last send or discard: the draft written on
      // top of that one is not what this client meant to delete.
      return errorResult(command.requestId, 'conflict', DRAFT_DELETED_MESSAGE, {
        draftId,
        revision: row.deleted_revision,
      })
    }
    // A draft that never reached the environment still gets a tombstone: its
    // first save may be on the wire behind this delete.
    const { tombstone, event } = deletionEvent(draftId, row, now())
    options.appendAtomic([event])
    return DraftResponseSchemas[DRAFT_DELETE_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: tombstone,
    })
  }

  const list = (command: CommandEnvelope) => {
    const parsed = DraftCommandSchemas[DRAFT_LIST_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      return errorResult(command.requestId, 'validation', 'Invalid draft list request.')
    }
    const drafts: Draft[] = []
    const tombstones: DraftTombstone[] = []
    for (const row of selectAll.all() as DraftRow[]) {
      if (row.deleted_at === null) drafts.push(toDraft(row))
      else tombstones.push({ draftId: row.draft_id, revision: row.revision })
    }
    return DraftResponseSchemas[DRAFT_LIST_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: { drafts, tombstones },
    })
  }

  return {
    dispatch(command: CommandEnvelope, context?: CommandContext): unknown {
      switch (command.name) {
        case DRAFT_LIST_CAPABILITY:
          return list(command)
        case DRAFT_SAVE_CAPABILITY:
          return save(command, context)
        case DRAFT_DELETE_CAPABILITY:
          return remove(command)
        default:
          return undefined
      }
    },

    /**
     * The deletion a new-session draft's send commits with the session, or an
     * error message when the id names a session's own draft. A draft the
     * environment never saw is still tombstoned, so a first save that was in
     * flight cannot recreate it.
     */
    launch(draftId: string, sent: SentDraft): DraftLaunch | { error: string } {
      const row = read(draftId)
      if (row?.session_id) return { error: "A session's draft cannot start another session." }
      const { tombstone, event } = deletionEvent(draftId, row, now())
      return {
        event,
        restore: () => {
          const current = read(draftId)
          if (!current || current.deleted_at === null || current.revision !== tombstone.revision) {
            return
          }
          // What was sent, not the last save: the send may have beaten the
          // autosave of its own text, or of the draft itself.
          const at = now()
          const draft: Draft = {
            draftId,
            target: {
              type: 'new_session',
              workspaceId: selectWorkspace.get(sent.workspaceId) ? sent.workspaceId : null,
              sessionId: sent.sessionId,
            },
            content: DraftContentSchema.parse({
              ...sent.content,
              text: sent.content.text.slice(0, DRAFT_TEXT_MAX_LENGTH),
            }),
            revision: tombstone.revision + 1,
            createdAt: iso(row && row.deleted_at === null ? row.created_at : at),
            updatedAt: iso(at),
            updatedByClientId: null,
          }
          options.appendAtomic([environmentEvent('draft.saved', { draft }, at)])
        },
      }
    },

    /** Forgets sent and discarded new-session drafts older than the retention. */
    pruneTombstones(): number {
      return Number(pruneTombstones.run(now() - DRAFT_TOMBSTONE_RETENTION_MS).changes)
    },
  }
}

export type DraftService = ReturnType<typeof createDraftService>
