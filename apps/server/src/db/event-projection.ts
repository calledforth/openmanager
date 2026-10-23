import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ProjectionRefusal } from './write-errors.ts'
import { isDeepStrictEqual } from 'node:util'
import {
  ProviderComposerProfileSchema,
  SessionSummarySchema,
  WorkspaceComposerPreferenceSchema,
  WorkspaceSchema,
  type ProofEvent,
} from '@openmanager/protocol/node'
import {
  preferenceFromRow,
  prepareComposerProjection,
  profileFromRow,
  readPreferenceRow,
  readProfileRow,
} from './composer-rows.ts'
import type { DurableProofEvent, WriteOptions } from './event-repository.ts'
import { prepareDraftProjection } from './draft-projection.ts'
import { OPEN_TURN_FOR_SESSION_SQL } from './queries.ts'
import { getSessionSummary } from './session-store.ts'
import { gitJsonOf, readWorkspace } from './workspace-rows.ts'
import { createTurnClosure, reasoningIsOpen, toolIsOpen } from './turn-closure.ts'

type TurnStarted = Extract<ProofEvent, { name: 'turn.started' }>
type MessageDelta = Extract<ProofEvent, { name: 'message.delta' }>
type MessageContent = MessageDelta['payload']['content']
type MessageReasoning = Extract<ProofEvent, { name: 'message.reasoning' }>
type ToolUpdated = Extract<ProofEvent, { name: 'tool.updated' }>
type ActivityRow = { turn_id: string; thread_id: string; kind: string; state_json: string }
type TurnRow = { workspace_id: string; state: string }

/** A turn that has ended takes no new output. */
const finished = (turn: TurnRow) => turn.state !== 'running' && turn.state !== 'waiting'

/**
 * Apply a durable event to the relational rows it describes.
 * Every statement runs inside the caller's transaction and throws on a missing,
 * mismatched, or already-settled target so the whole batch rolls back.
 */
export function createEventProjector(
  database: DatabaseSync,
): (event: DurableProofEvent, write?: WriteOptions) => void {
  const drafts = prepareDraftProjection(database)
  const composer = prepareComposerProjection(database)
  const closure = createTurnClosure(database)
  const s = {
    insertSession: database.prepare(
      `INSERT INTO sessions (
         session_id, workspace_id, parent_session_id, provider_id, provider_session_id, title,
         title_source, title_generated, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
    ),
    // The registry's one writer (docs/sync-foundations.md §4.7.11): a
    // registration inserts, every later change rewrites what the event states.
    upsertWorkspace: database.prepare(
      `INSERT INTO workspaces (
         workspace_id, name, path, availability, git_json, last_used_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT(workspace_id) DO UPDATE SET
         name = excluded.name,
         path = excluded.path,
         availability = excluded.availability,
         git_json = excluded.git_json,
         last_used_at = excluded.last_used_at,
         updated_at = excluded.updated_at`,
    ),
    deleteWorkspace: database.prepare('DELETE FROM workspaces WHERE workspace_id = ?'),
    // Automatic titles never replace one the user set; a rename, or a title
    // the user asked to have generated, may. A title the title model wrote is
    // kept as 'provider' plus `title_generated` (see migration 15), and
    // neither the agent's name for its session nor a first-prompt fallback
    // replaces it. `IS` keeps a source-less update from reading as NULL.
    // The producer applies the same rule before it emits (thread-service.ts
    // `applyTitle`), so a title this refuses is a bug, not a race (I2).
    // A title is not activity: `updated_at` stays put (§4.7.1).
    // ?1 title, ?2 stored source, ?3 source as sent, ?4 session.
    updateSessionTitle: database.prepare(
      `UPDATE sessions
          SET title = ?1,
              title_source = COALESCE(?2, title_source),
              title_generated = CASE
                WHEN ?3 IS NULL THEN title_generated
                WHEN ?3 = 'generated' THEN 1
                ELSE 0
              END
        WHERE session_id = ?4
          AND (?3 IN ('user', 'generated') OR title_source IS NULL OR title_source <> 'user')
          AND NOT ((?3 IS 'provider' OR ?3 IS 'fallback') AND title_generated = 1)`,
    ),
    updateSessionStatus: database.prepare(
      'UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?',
    ),
    updateSessionTime: database.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?'),
    // Neither is settling: the session keeps its place when it comes back.
    updateSessionSettled: database.prepare(
      'UPDATE sessions SET settled_at = ? WHERE session_id = ?',
    ),
    // Work that needs the user brings a settled session back to the active list.
    unsettleSession: database.prepare(
      'UPDATE sessions SET settled_at = NULL WHERE session_id = ? AND settled_at IS NOT NULL',
    ),
    // Done is unseen work, not activity: it never moves the session in the list.
    updateSessionDone: database.prepare('UPDATE sessions SET done_at = ? WHERE session_id = ?'),
    clearSessionDone: database.prepare(
      'UPDATE sessions SET done_at = NULL WHERE session_id = ? AND done_at IS NOT NULL',
    ),
    // Background work is not activity the user did; `updated_at` stays put.
    updateSessionBackground: database.prepare(
      'UPDATE sessions SET background_tasks_json = ? WHERE session_id = ?',
    ),
    hasBackgroundTasks: database.prepare(
      'SELECT 1 FROM sessions WHERE session_id = ? AND background_tasks_json IS NOT NULL',
    ),
    selectSessionStatus: database.prepare('SELECT status FROM sessions WHERE session_id = ?'),
    openTurnForSession: database.prepare(OPEN_TURN_FOR_SESSION_SQL),
    // Not a sidebar-ordering change, so `updated_at` stays put.
    updateSessionComposer: database.prepare(
      'UPDATE sessions SET composer_json = ? WHERE session_id = ?',
    ),
    deleteSession: database.prepare('DELETE FROM sessions WHERE session_id = ?'),
    // What a deletion must already have said, so no foreign key removes a
    // client-visible row silently (db/deletions.ts).
    childOfSession: database.prepare('SELECT 1 FROM sessions WHERE parent_session_id = ? LIMIT 1'),
    liveSessionDraft: database.prepare(
      'SELECT 1 FROM drafts WHERE session_id = ? AND deleted_at IS NULL LIMIT 1',
    ),
    sessionInWorkspace: database.prepare('SELECT 1 FROM sessions WHERE workspace_id = ? LIMIT 1'),
    liveWorkspaceDraft: database.prepare(
      'SELECT 1 FROM drafts WHERE workspace_id = ? AND deleted_at IS NULL LIMIT 1',
    ),
    selectSessionWorkspace: database.prepare(
      'SELECT workspace_id FROM sessions WHERE session_id = ?',
    ),
    insertThread: database.prepare(
      `INSERT INTO threads (
         thread_id, session_id, workspace_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ),
    selectThreadWorkspace: database.prepare('SELECT workspace_id FROM threads WHERE thread_id = ?'),
    insertTurn: database.prepare(
      `INSERT INTO turns (
         turn_id, thread_id, workspace_id, state, command_id, origin, started_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    selectTurnWorkspace: database.prepare(
      'SELECT workspace_id, state FROM turns WHERE turn_id = ? AND thread_id = ?',
    ),
    /** Only an unfinished turn may change state; late events for finished turns roll back. */
    updateOpenTurnState: database.prepare(
      `UPDATE turns SET state = ?, updated_at = ?
       WHERE turn_id = ? AND thread_id = ? AND state IN ('running', 'waiting')`,
    ),
    finishOpenTurn: database.prepare(
      `UPDATE turns
       SET state = ?, failure_reason = ?, failure_message = ?, interrupted_by = ?,
           finished_at = ?, updated_at = ?
       WHERE turn_id = ? AND thread_id = ? AND state IN ('running', 'waiting')`,
    ),
    insertInteraction: database.prepare(
      `INSERT INTO interactions (
         interaction_id, turn_id, kind, state, request_json, expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
    ),
    resolvePendingInteraction: database.prepare(
      `UPDATE interactions
       SET state = ?, response_json = ?, resolved_at = ?, updated_at = ?, resolved_by_client_id = ?
       WHERE interaction_id = ? AND turn_id = ? AND kind = ? AND state = 'pending'`,
    ),
    pendingInteractions: database.prepare(
      "SELECT 1 FROM interactions WHERE turn_id = ? AND state = 'pending' LIMIT 1",
    ),

    selectMessage: database.prepare(
      'SELECT turn_id, thread_id, role, is_final FROM messages WHERE message_id = ?',
    ),
    // One counter across messages and turn activity, so sorting both on
    // `ordinal` gives the order text, thoughts and tools happened in. Activity
    // rebuilt by migration 11 sits at fractional ordinals between messages, so
    // the next live ordinal is the integer above whatever is highest.
    nextMessageOrdinal: database.prepare(
      `SELECT CAST(MAX(
         COALESCE((SELECT MAX(ordinal) FROM messages WHERE thread_id = ?), -1),
         COALESCE((SELECT MAX(ordinal) FROM turn_activity WHERE thread_id = ?), -1)
       ) AS INTEGER) + 1 AS ordinal`,
    ),
    selectActivity: database.prepare(
      'SELECT turn_id, thread_id, kind, state_json FROM turn_activity WHERE activity_id = ?',
    ),
    insertActivity: database.prepare(
      `INSERT INTO turn_activity (
         activity_id, workspace_id, thread_id, turn_id, kind, ordinal, state_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateActivity: database.prepare(
      'UPDATE turn_activity SET state_json = ?, updated_at = ? WHERE activity_id = ?',
    ),
    insertMessage: database.prepare(
      `INSERT INTO messages (
         message_id, workspace_id, thread_id, turn_id, role, ordinal, is_final,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    touchMessage: database.prepare('UPDATE messages SET updated_at = ? WHERE message_id = ?'),
    finalizeTurnMessages: database.prepare(
      'UPDATE messages SET is_final = 1, updated_at = ? WHERE turn_id = ?',
    ),
    selectLastPart: database.prepare(
      `SELECT part_id, ordinal, part_type, content_json
       FROM message_parts WHERE message_id = ? ORDER BY ordinal DESC LIMIT 1`,
    ),
    updatePartContent: database.prepare(
      'UPDATE message_parts SET content_json = ?, updated_at = ? WHERE part_id = ?',
    ),
    insertPart: database.prepare(
      `INSERT INTO message_parts (
         part_id, message_id, ordinal, part_type, content_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
  }

  function insertMessage(
    message: NonNullable<TurnStarted['payload']['userMessage']>,
    workspaceId: string,
    isFinal: boolean,
    at: number,
  ): void {
    const { ordinal } = s.nextMessageOrdinal.get(message.threadId, message.threadId) as {
      ordinal: number
    }
    s.insertMessage.run(
      message.messageId,
      workspaceId,
      message.threadId,
      message.turnId,
      message.role,
      ordinal,
      isFinal ? 1 : 0,
      at,
      at,
    )
    for (const content of message.content) appendContent(message.messageId, content, at)
  }

  /** Adjacent text parts merge so coalesced deltas project to one row. */
  function appendContent(messageId: string, content: MessageContent, at: number): void {
    const last = s.selectLastPart.get(messageId) as
      { part_id: string; ordinal: number; part_type: string; content_json: string } | undefined
    if (content.type === 'text' && last?.part_type === 'text') {
      const previous = JSON.parse(last.content_json) as { type: 'text'; text: string }
      s.updatePartContent.run(
        JSON.stringify({ type: 'text', text: previous.text + content.text }),
        at,
        last.part_id,
      )
      return
    }
    s.insertPart.run(
      randomUUID(),
      messageId,
      (last?.ordinal ?? -1) + 1,
      content.type,
      JSON.stringify(content),
      at,
      at,
    )
  }

  function projectTurnStarted(event: TurnStarted, at: number): void {
    const thread = s.selectThreadWorkspace.get(event.scope.threadId) as
      { workspace_id: string } | undefined
    if (!thread)
      throw new ProjectionRefusal(`Cannot project turn for missing thread ${event.scope.threadId}`)
    s.insertTurn.run(
      event.payload.turn.turnId,
      event.scope.threadId,
      thread.workspace_id,
      event.payload.turn.state,
      // Unique per thread, so a replayed send cannot project a second turn.
      event.payload.commandId ?? null,
      event.payload.turn.origin ?? null,
      at,
      at,
    )
    // A turn the provider began by itself has no prompt to record.
    if (event.payload.userMessage) {
      insertMessage(event.payload.userMessage, thread.workspace_id, true, at)
    }
    s.updateSessionStatus.run('running', at, event.scope.sessionId)
    s.unsettleSession.run(event.scope.sessionId)
    // The earlier result is superseded by the turn now running.
    s.clearSessionDone.run(event.scope.sessionId)
  }

  function projectMessageDelta(event: MessageDelta, at: number): void {
    const { messageId, turnId, role, content } = event.payload
    const turn = s.selectTurnWorkspace.get(turnId, event.scope.threadId) as TurnRow | undefined
    if (!turn) throw new ProjectionRefusal(`Cannot project message for missing turn ${turnId}`)
    if (finished(turn))
      throw new ProjectionRefusal(`Cannot add a message to finished turn ${turnId}`)
    const existing = s.selectMessage.get(messageId) as
      { turn_id: string; thread_id: string; role: string; is_final: number } | undefined
    if (
      existing &&
      (existing.turn_id !== turnId ||
        existing.thread_id !== event.scope.threadId ||
        existing.role !== role ||
        existing.is_final !== 0)
    ) {
      throw new ProjectionRefusal(`Cannot append to mismatched or finalized message ${messageId}`)
    }
    if (!existing) {
      insertMessage(
        { messageId, threadId: event.scope.threadId, turnId, role, content: [] },
        turn.workspace_id,
        false,
        at,
      )
    }
    appendContent(messageId, content, at)
    s.touchMessage.run(at, messageId)
  }

  /**
   * Upsert one reasoning block or tool call of a turn. The first event for an
   * id takes the next thread-wide ordinal, which fixes the entry's place among
   * the turn's messages; later events only revise its state.
   */
  function upsertActivity(
    event: MessageReasoning | ToolUpdated,
    activityId: string,
    kind: 'reasoning' | 'tool',
    at: number,
    next: (existing: unknown | undefined) => unknown,
  ): void {
    const { turnId } = event.payload
    const turn = s.selectTurnWorkspace.get(turnId, event.scope.threadId) as TurnRow | undefined
    if (!turn) throw new ProjectionRefusal(`Cannot project ${kind} for missing turn ${turnId}`)
    const existing = s.selectActivity.get(activityId) as ActivityRow | undefined
    // A finished turn takes exactly one kind of child event: the close of a
    // child it left open (the legacy repair, docs/sync-foundations.md §4.2).
    // Anything else, a second close included, rolls the write back (I2).
    if (finished(turn) && !closesOpenChild(event, existing)) {
      throw new ProjectionRefusal(`Cannot change ${kind} ${activityId} of finished turn ${turnId}`)
    }
    if (existing) {
      if (
        existing.turn_id !== turnId ||
        existing.thread_id !== event.scope.threadId ||
        existing.kind !== kind
      ) {
        throw new ProjectionRefusal(`Cannot update mismatched ${kind} ${activityId}`)
      }
      s.updateActivity.run(JSON.stringify(next(JSON.parse(existing.state_json))), at, activityId)
      return
    }
    const { ordinal } = s.nextMessageOrdinal.get(event.scope.threadId, event.scope.threadId) as {
      ordinal: number
    }
    s.insertActivity.run(
      activityId,
      turn.workspace_id,
      event.scope.threadId,
      turnId,
      kind,
      ordinal,
      JSON.stringify(next(undefined)),
      at,
      at,
    )
  }

  /** Whether an event only closes an open child: tool to `cancelled`, thought to `stop`. */
  function closesOpenChild(
    event: MessageReasoning | ToolUpdated,
    existing: ActivityRow | undefined,
  ): boolean {
    if (!existing) return false
    const state = JSON.parse(existing.state_json) as { status?: string; phase?: string }
    if (event.name === 'tool.updated') {
      const { status, title, kind } = event.payload
      return (
        existing.kind === 'tool' &&
        toolIsOpen(state) &&
        status === 'cancelled' &&
        title === undefined &&
        kind === undefined
      )
    }
    const { phase, content, tokens } = event.payload
    return (
      existing.kind === 'reasoning' &&
      reasoningIsOpen(state) &&
      phase === 'stop' &&
      content === undefined &&
      tokens === undefined
    )
  }

  /** Mirrors the client fold: adjacent text merges, tokens only ever grow. */
  function projectReasoning(event: MessageReasoning, at: number): void {
    const { messageId, turnId, phase, content, tokens } = event.payload
    upsertActivity(event, messageId, 'reasoning', at, (existing) => {
      const previous = existing as
        { content: MessageContent[]; tokens?: number; phase: string } | undefined
      const blocks = previous?.content ?? []
      const last = blocks.at(-1)
      const merged =
        content === undefined
          ? blocks
          : last?.type === 'text' && content.type === 'text'
            ? [...blocks.slice(0, -1), { type: 'text', text: last.text + content.text }]
            : [...blocks, content]
      const total =
        tokens === undefined ? previous?.tokens : Math.max(previous?.tokens ?? 0, tokens)
      return {
        messageId,
        turnId,
        phase,
        content: merged,
        ...(total === undefined ? {} : { tokens: total }),
      }
    })
  }

  /** Later updates fill in or revise title, kind and status; nothing is forgotten. */
  function projectTool(event: ToolUpdated, at: number): void {
    const { toolCallId, turnId, title, kind, status } = event.payload
    upsertActivity(event, toolCallId, 'tool', at, (existing) => ({
      ...((existing as Record<string, unknown> | undefined) ?? {}),
      toolCallId,
      turnId,
      ...(title === undefined ? {} : { title }),
      ...(kind === undefined ? {} : { kind }),
      ...(status === undefined ? {} : { status }),
    }))
  }

  return function projectEvent(event: DurableProofEvent, write?: WriteOptions): void {
    const at = Date.parse(event.timestamp)
    switch (event.name) {
      case 'session.created': {
        const session = event.payload.session
        // The row is the payload: the producer built every field the
        // projection writes (docs/sync-foundations.md §4.7.2). A title the
        // title model wrote is kept as 'provider' plus `title_generated`.
        const source = session.titleSource
        // The composite foreign key rejects a parent from another workspace,
        // so a child can never be filed under a session it cannot belong to.
        s.insertSession.run(
          session.sessionId,
          session.workspaceId,
          session.parentSessionId ?? null,
          session.providerId,
          // Host-private: the identity rides the write, never the event.
          write?.identities?.[session.sessionId] ?? null,
          session.title,
          source === undefined ? null : source === 'generated' ? 'provider' : source,
          source === 'generated' ? 1 : 0,
          at,
          at,
        )
        // Built from the row the projection wrote, checked rather than
        // assumed: what a listing reads back equals what the event said.
        const written = getSessionSummary(database, session.sessionId)
        if (!isDeepStrictEqual(written, SessionSummarySchema.parse(session))) {
          throw new ProjectionRefusal(
            `session.created for ${session.sessionId} says ${JSON.stringify(session)}; its row reads ${JSON.stringify(written)}`,
          )
        }
        return
      }
      case 'workspace.updated': {
        // The whole workspace, as its producer read it from the rows and the
        // folder; the row takes every field it stores.
        const workspace = event.payload.workspace
        const availability = workspace.availability ?? (workspace.exists ? 'available' : 'missing')
        s.upsertWorkspace.run(
          workspace.workspaceId,
          workspace.name,
          workspace.path,
          availability,
          gitJsonOf(availability, {
            checkout: workspace.capabilities.git,
            ...(workspace.git ? { git: workspace.git } : {}),
          }),
          workspace.lastUsedAt === null ? null : Date.parse(workspace.lastUsedAt),
          at,
        )
        // Checked, not assumed: what a listing reads back, recency included,
        // is what the event said (I2).
        const written = readWorkspace(database, workspace.workspaceId)
        if (!isDeepStrictEqual(written, WorkspaceSchema.parse(workspace))) {
          throw new ProjectionRefusal(
            `workspace.updated for ${workspace.workspaceId} says ${JSON.stringify(workspace)}; its row reads ${JSON.stringify(written)}`,
          )
        }
        return
      }
      case 'workspace.removed': {
        // Its sessions were deleted and its drafts detached by events before
        // this one; nothing is left for the foreign keys to take silently.
        const { workspaceId } = event.payload
        if (s.sessionInWorkspace.get(workspaceId)) {
          throw new ProjectionRefusal(
            `Workspace ${workspaceId} still has sessions; delete them first`,
          )
        }
        if (s.liveWorkspaceDraft.get(workspaceId)) {
          throw new ProjectionRefusal(
            `Workspace ${workspaceId} still has drafts; detach them first`,
          )
        }
        if (s.deleteWorkspace.run(workspaceId).changes !== 1) {
          throw new ProjectionRefusal(`Cannot remove missing workspace ${workspaceId}`)
        }
        return
      }
      case 'session.updated': {
        // The activity time it states, when it states one: the status pass
        // restates the row's own, so projecting it again changes nothing.
        const movedAt =
          event.payload.updatedAt === undefined ? undefined : Date.parse(event.payload.updatedAt)
        if (event.payload.status !== undefined) {
          if (
            s.updateSessionStatus.run(event.payload.status, movedAt ?? at, event.payload.sessionId)
              .changes !== 1
          ) {
            throw new ProjectionRefusal(
              `Cannot update status for missing session ${event.payload.sessionId}`,
            )
          }
        } else if (movedAt !== undefined) {
          if (s.updateSessionTime.run(movedAt, event.payload.sessionId).changes !== 1) {
            throw new ProjectionRefusal(
              `Cannot move the time of missing session ${event.payload.sessionId}`,
            )
          }
        }
        if (event.payload.title !== undefined) {
          const titleSource = event.payload.titleSource ?? null
          const titled = s.updateSessionTitle.run(
            event.payload.title,
            titleSource === 'generated' ? 'provider' : titleSource,
            titleSource,
            event.payload.sessionId,
          )
          if (titled.changes !== 1) {
            throw new ProjectionRefusal(
              `Session ${event.payload.sessionId} is missing or keeps its title over a ${titleSource ?? 'source-less'} one`,
            )
          }
        }
        if (event.payload.settledAt !== undefined) {
          const settledAt =
            event.payload.settledAt === null ? null : Date.parse(event.payload.settledAt)
          if (s.updateSessionSettled.run(settledAt, event.payload.sessionId).changes !== 1) {
            throw new ProjectionRefusal(`Cannot settle missing session ${event.payload.sessionId}`)
          }
        }
        if (event.payload.doneAt !== undefined) {
          const doneAt = event.payload.doneAt === null ? null : Date.parse(event.payload.doneAt)
          if (s.updateSessionDone.run(doneAt, event.payload.sessionId).changes !== 1) {
            throw new ProjectionRefusal(
              `Cannot acknowledge missing session ${event.payload.sessionId}`,
            )
          }
        }
        if (event.payload.backgroundTasks !== undefined) {
          // Only a live session's runtime reports a roster, and a deletion
          // drops the record first, so a missing row is a bug (I2).
          const rostered = s.updateSessionBackground.run(
            event.payload.backgroundTasks.length > 0
              ? JSON.stringify(event.payload.backgroundTasks)
              : null,
            event.payload.sessionId,
          )
          if (rostered.changes !== 1) {
            throw new ProjectionRefusal(
              `Cannot record background work for missing session ${event.payload.sessionId}`,
            )
          }
          // Between turns the roster is all that says whether the session is
          // working, so the rows say it: a resting session runs while it has
          // background work and is idle once it has none. A failed session
          // stays failed, and a turn in flight owns the status. The status
          // pass announces the change (event-repository.ts).
          if (event.payload.status === undefined) {
            const row = s.selectSessionStatus.get(event.payload.sessionId) as
              { status: string } | undefined
            if (
              row &&
              (row.status === 'idle' || row.status === 'running') &&
              !s.openTurnForSession.get(event.payload.sessionId)
            ) {
              const rests = event.payload.backgroundTasks.length > 0 ? 'running' : 'idle'
              if (rests !== row.status)
                s.updateSessionStatus.run(rests, at, event.payload.sessionId)
            }
          }
        }
        return
      }
      case 'session.composer.updated':
        // The composer service publishes a selection only for a session that
        // still has its row (composer-service.ts), so a missing one is a bug (I2).
        if (
          s.updateSessionComposer.run(
            JSON.stringify(event.payload.composer),
            event.payload.sessionId,
          ).changes !== 1
        ) {
          throw new ProjectionRefusal(
            `Cannot record a selection for missing session ${event.payload.sessionId}`,
          )
        }
        return
      case 'draft.saved':
        drafts.saved(event.payload.draft)
        return
      case 'draft.deleted':
        drafts.deleted(event.payload, at)
        return
      case 'composer.preferences.updated': {
        // The composer store's one writer (docs/sync-foundations.md §4.7.11).
        const { workspaceId, providerId, preference, revision } = event.payload
        composer.preference({ workspaceId, providerId }, preference, revision, at)
        const row = readPreferenceRow(database, workspaceId, providerId)
        const announced = WorkspaceComposerPreferenceSchema.parse(preference)
        if (!row || !isDeepStrictEqual(preferenceFromRow(row), announced)) {
          throw new ProjectionRefusal(
            `Preference ${workspaceId}/${providerId} does not read back as announced`,
          )
        }
        return
      }
      case 'provider.catalog.updated': {
        const profile = event.payload.profile
        composer.profile(profile)
        const row = readProfileRow(database, profile.providerId)
        if (
          !row ||
          !isDeepStrictEqual(profileFromRow(row), ProviderComposerProfileSchema.parse(profile))
        ) {
          throw new ProjectionRefusal(
            `Profile ${profile.providerId} does not read back as announced`,
          )
        }
        return
      }
      case 'session.deleted': {
        // Children first and its draft first, each with its own event.
        const { sessionId } = event.payload
        if (s.childOfSession.get(sessionId)) {
          throw new ProjectionRefusal(
            `Session ${sessionId} still has child sessions; delete them first`,
          )
        }
        if (s.liveSessionDraft.get(sessionId)) {
          throw new ProjectionRefusal(`Session ${sessionId} still has a draft; delete it first`)
        }
        if (s.deleteSession.run(sessionId).changes !== 1) {
          throw new ProjectionRefusal(`Cannot delete missing session ${sessionId}`)
        }
        return
      }
      case 'thread.created': {
        const session = s.selectSessionWorkspace.get(event.scope.sessionId) as
          { workspace_id: string } | undefined
        if (!session) {
          throw new ProjectionRefusal(
            `Cannot project thread for missing session ${event.scope.sessionId}`,
          )
        }
        s.insertThread.run(
          event.payload.thread.threadId,
          event.scope.sessionId,
          session.workspace_id,
          at,
          at,
        )
        return
      }
      case 'turn.started':
        projectTurnStarted(event, at)
        return
      case 'message.delta':
        projectMessageDelta(event, at)
        return
      case 'interaction.requested': {
        const { interaction, turnId } = event.payload
        s.insertInteraction.run(
          interaction.interactionId,
          turnId,
          interaction.kind,
          JSON.stringify(interaction),
          interaction.kind === 'permission' && interaction.expiresAt
            ? Date.parse(interaction.expiresAt)
            : null,
          at,
          at,
        )
        if (event.payload.turnState !== 'waiting') {
          throw new ProjectionRefusal(
            `A request leaves turn ${turnId} waiting, not ${event.payload.turnState}`,
          )
        }
        if (s.updateOpenTurnState.run('waiting', at, turnId, event.scope.threadId).changes !== 1) {
          throw new ProjectionRefusal(`Cannot mark missing or finished turn ${turnId} as waiting`)
        }
        s.updateSessionStatus.run('waiting', at, event.scope.sessionId)
        s.unsettleSession.run(event.scope.sessionId)
        return
      }
      case 'interaction.resolved':
      case 'interaction.expired':
      case 'interaction.cancelled': {
        const { response, turnId } = event.payload
        const resolved = s.resolvePendingInteraction.run(
          event.name === 'interaction.expired'
            ? 'expired'
            : event.name === 'interaction.cancelled'
              ? 'cancelled'
              : 'resolved',
          JSON.stringify(response),
          at,
          at,
          event.name === 'interaction.resolved' ? (event.payload.resolvedByClientId ?? null) : null,
          response.interactionId,
          turnId,
          response.kind,
        )
        if (resolved.changes !== 1) {
          throw new ProjectionRefusal(
            `Cannot resolve missing, mismatched, or settled interaction ${response.interactionId}`,
          )
        }
        const status = s.pendingInteractions.get(turnId) ? 'waiting' : 'running'
        // The producer states the turn's state; the rows must agree (I2).
        if (event.payload.turnState !== status) {
          throw new ProjectionRefusal(
            `${event.name} says turn ${turnId} is ${event.payload.turnState}; its requests say ${status}`,
          )
        }
        if (s.updateOpenTurnState.run(status, at, turnId, event.scope.threadId).changes !== 1) {
          throw new ProjectionRefusal(`Cannot resume missing or finished turn ${turnId}`)
        }
        s.updateSessionStatus.run(status, at, event.scope.sessionId)
        return
      }
      case 'turn.completed':
      case 'turn.interrupted':
      case 'turn.failed': {
        const turnId = event.payload.turnId
        // Each open child got its own close event before this one (I3,
        // turn-closure.ts); a terminal that would leave one open rolls back.
        const open = closure.openChildren(turnId, event.scope.threadId)
        if (open.length > 0) {
          throw new ProjectionRefusal(
            `Turn ${turnId} cannot end with open children: ${open.join(', ')}`,
          )
        }
        const state =
          event.name === 'turn.completed'
            ? 'completed'
            : event.name === 'turn.interrupted'
              ? 'interrupted'
              : 'failed'
        const finished = s.finishOpenTurn.run(
          state,
          event.name === 'turn.failed' ? event.payload.reason : null,
          event.name === 'turn.failed' ? event.payload.message : null,
          event.name === 'turn.interrupted' ? event.payload.reason : null,
          at,
          at,
          turnId,
          event.scope.threadId,
        )
        if (finished.changes !== 1) {
          throw new ProjectionRefusal(`Cannot finalize missing or finished turn ${turnId}`)
        }
        s.finalizeTurnMessages.run(at, turnId)
        // The turn is over but the session is not resting while work it
        // started is still running in the background.
        const working = !!s.hasBackgroundTasks.get(event.scope.sessionId)
        // A restart cut the turn off: nobody asked it to stop, so the session
        // shows the failure, as a failed turn does.
        const failedHere =
          event.name === 'turn.failed' ||
          (event.name === 'turn.interrupted' && event.payload.reason === 'server_restarted')
        const session = s.updateSessionStatus.run(
          failedHere ? 'error' : working ? 'running' : 'idle',
          at,
          event.scope.sessionId,
        )
        if (session.changes !== 1) {
          throw new ProjectionRefusal(
            `Cannot finalize turn for missing session ${event.scope.sessionId}`,
          )
        }
        // Only a completed turn is news, and only once nothing is left running:
        // the turn that reports the background result is the one that is done.
        // An interrupt was the user's own doing, and a failure shows as the
        // error status instead.
        if (event.name === 'turn.completed' && !working) {
          s.updateSessionDone.run(at, event.scope.sessionId)
        } else s.clearSessionDone.run(event.scope.sessionId)
        return
      }
      case 'message.reasoning':
        projectReasoning(event, at)
        return
      case 'tool.updated':
        projectTool(event, at)
        return
    }
  }
}
