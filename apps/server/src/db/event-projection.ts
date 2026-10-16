import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ProofEvent } from '@openmanager/protocol/node'
import type { DurableProofEvent } from './event-repository.ts'
import { prepareDraftProjection } from './draft-projection.ts'

type SessionSummary = Extract<ProofEvent, { name: 'session.created' }>['payload']['session']
type TurnStarted = Extract<ProofEvent, { name: 'turn.started' }>
type MessageDelta = Extract<ProofEvent, { name: 'message.delta' }>
type MessageContent = MessageDelta['payload']['content']
type MessageReasoning = Extract<ProofEvent, { name: 'message.reasoning' }>
type ToolUpdated = Extract<ProofEvent, { name: 'tool.updated' }>
type NoticeRecorded = Extract<ProofEvent, { name: 'turn.notice.recorded' }>
type ActivityRow = { turn_id: string; thread_id: string; kind: string; state_json: string }

export interface EventProjectionOptions {
  /** Host-owned provider identity, absent from the public session summary. */
  sessionProviderId?: (session: SessionSummary) => string
}

/**
 * Apply a durable event to the relational rows it describes.
 * Every statement runs inside the caller's transaction and throws on a missing,
 * mismatched, or already-settled target so the whole batch rolls back.
 */
export function createEventProjector(
  database: DatabaseSync,
  options: EventProjectionOptions,
): (event: DurableProofEvent) => void {
  const drafts = prepareDraftProjection(database)
  const s = {
    insertSession: database.prepare(
      `INSERT INTO sessions (
         session_id, workspace_id, parent_session_id, provider_id, title, status,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)`,
    ),
    updateWorkspaceName: database.prepare(
      'UPDATE workspaces SET name = ?, updated_at = ? WHERE workspace_id = ?',
    ),
    // Automatic titles never replace one the user set; a rename, or a title
    // the user asked to have generated, may. A title the title model wrote is
    // kept as 'provider' plus `title_generated` (see migration 15), and
    // neither the agent's name for its session nor a first-prompt fallback
    // replaces it. `IS` keeps a source-less update from reading as NULL.
    // ?1 title, ?2 stored source, ?3 source as sent, ?4 time, ?5 session.
    updateSessionTitle: database.prepare(
      `UPDATE sessions
          SET title = ?1,
              title_source = COALESCE(?2, title_source),
              title_generated = CASE
                WHEN ?3 IS NULL THEN title_generated
                WHEN ?3 = 'generated' THEN 1
                ELSE 0
              END,
              updated_at = ?4
        WHERE session_id = ?5
          AND (?3 IN ('user', 'generated') OR title_source IS NULL OR title_source <> 'user')
          AND NOT ((?3 IS 'provider' OR ?3 IS 'fallback') AND title_generated = 1)`,
    ),
    updateSessionStatus: database.prepare(
      'UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?',
    ),
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
    // Not a sidebar-ordering change, so `updated_at` stays put.
    updateSessionComposer: database.prepare(
      'UPDATE sessions SET composer_json = ? WHERE session_id = ?',
    ),
    deleteSession: database.prepare('DELETE FROM sessions WHERE session_id = ?'),
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
      'SELECT workspace_id FROM turns WHERE turn_id = ? AND thread_id = ?',
    ),
    /** Only an unfinished turn may change state; late events for finished turns roll back. */
    updateOpenTurnState: database.prepare(
      `UPDATE turns SET state = ?, updated_at = ?
       WHERE turn_id = ? AND thread_id = ? AND state IN ('running', 'waiting')`,
    ),
    finishOpenTurn: database.prepare(
      `UPDATE turns
       SET state = ?, failure_reason = ?, failure_json = ?, finished_at = ?, updated_at = ?
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
    cancelPendingInteractions: database.prepare(
      `UPDATE interactions SET state = 'cancelled', resolved_at = ?, updated_at = ?
       WHERE turn_id = ? AND state = 'pending'`,
    ),
    selectMessage: database.prepare(
      'SELECT turn_id, thread_id, role, is_final FROM messages WHERE message_id = ?',
    ),
    // One counter across messages, turn activity and notices, so sorting
    // them on `ordinal` gives the order text, thoughts, tools and notices
    // happened in. Activity rebuilt by migration 11 sits at fractional
    // ordinals between messages, so the next live ordinal is the integer
    // above whatever is highest. Notices reuse the second thread id (`?2`).
    nextMessageOrdinal: database.prepare(
      `SELECT CAST(MAX(
         COALESCE((SELECT MAX(ordinal) FROM messages WHERE thread_id = ?), -1),
         COALESCE((SELECT MAX(ordinal) FROM turn_activity WHERE thread_id = ?), -1),
         COALESCE((SELECT MAX(ordinal) FROM turn_notices WHERE thread_id = ?2), -1)
       ) AS INTEGER) + 1 AS ordinal`,
    ),
    insertNotice: database.prepare(
      `INSERT INTO turn_notices (
         notice_id, workspace_id, thread_id, turn_id, ordinal, notice_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
    if (!thread) throw new Error(`Cannot project turn for missing thread ${event.scope.threadId}`)
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
    const turn = s.selectTurnWorkspace.get(turnId, event.scope.threadId) as
      { workspace_id: string } | undefined
    if (!turn) throw new Error(`Cannot project message for missing turn ${turnId}`)
    const existing = s.selectMessage.get(messageId) as
      { turn_id: string; thread_id: string; role: string; is_final: number } | undefined
    if (
      existing &&
      (existing.turn_id !== turnId ||
        existing.thread_id !== event.scope.threadId ||
        existing.role !== role ||
        existing.is_final !== 0)
    ) {
      throw new Error(`Cannot append to mismatched or finalized message ${messageId}`)
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
    const turn = s.selectTurnWorkspace.get(turnId, event.scope.threadId) as
      { workspace_id: string } | undefined
    if (!turn) throw new Error(`Cannot project ${kind} for missing turn ${turnId}`)
    const existing = s.selectActivity.get(activityId) as ActivityRow | undefined
    if (existing) {
      if (
        existing.turn_id !== turnId ||
        existing.thread_id !== event.scope.threadId ||
        existing.kind !== kind
      ) {
        throw new Error(`Cannot update mismatched ${kind} ${activityId}`)
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

  /** Mirrors the client fold: adjacent text merges, tokens only ever grow. */
  function projectReasoning(event: MessageReasoning, at: number): void {
    const { messageId, turnId, phase, content, tokens } = event.payload
    upsertActivity(event, messageId, 'reasoning', at, (existing) => {
      const previous = existing as
        | { content: MessageContent[]; tokens?: number; phase: string }
        | undefined
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

  /** A durable notice takes the next ordinal, which places it in its turn. */
  function projectNotice(event: NoticeRecorded, at: number): void {
    const { noticeId, turnId } = event.payload
    const turn = s.selectTurnWorkspace.get(turnId, event.scope.threadId) as
      { workspace_id: string } | undefined
    if (!turn) throw new Error(`Cannot project notice for missing turn ${turnId}`)
    const { ordinal } = s.nextMessageOrdinal.get(event.scope.threadId, event.scope.threadId) as {
      ordinal: number
    }
    s.insertNotice.run(
      noticeId,
      turn.workspace_id,
      event.scope.threadId,
      turnId,
      ordinal,
      JSON.stringify(event.payload),
      at,
    )
  }

  return function projectEvent(event: DurableProofEvent): void {
    const at = Date.parse(event.timestamp)
    switch (event.name) {
      case 'session.created': {
        const session = event.payload.session
        const providerId = options.sessionProviderId?.(session)
        if (!providerId?.trim()) {
          throw new Error('session.created requires a host sessionProviderId resolver')
        }
        // The composite foreign key rejects a parent from another workspace,
        // so a child can never be filed under a session it cannot belong to.
        s.insertSession.run(
          session.sessionId,
          session.workspaceId,
          session.parentSessionId ?? null,
          providerId,
          session.title,
          at,
          at,
        )
        return
      }
      case 'workspace.updated':
        s.updateWorkspaceName.run(
          event.payload.workspace.name,
          at,
          event.payload.workspace.workspaceId,
        )
        return
      case 'workspace.removed':
        // The registry deletes the row itself; sessions cascade with it.
        return
      case 'session.updated':
        if (event.payload.status !== undefined) {
          if (
            s.updateSessionStatus.run(event.payload.status, at, event.payload.sessionId).changes !==
            1
          ) {
            throw new Error(`Cannot update status for missing session ${event.payload.sessionId}`)
          }
        }
        if (event.payload.title !== undefined) {
          const titleSource = event.payload.titleSource ?? null
          s.updateSessionTitle.run(
            event.payload.title,
            titleSource === 'generated' ? 'provider' : titleSource,
            titleSource,
            at,
            event.payload.sessionId,
          )
        }
        if (event.payload.settledAt !== undefined) {
          const settledAt =
            event.payload.settledAt === null ? null : Date.parse(event.payload.settledAt)
          if (s.updateSessionSettled.run(settledAt, event.payload.sessionId).changes !== 1) {
            throw new Error(`Cannot settle missing session ${event.payload.sessionId}`)
          }
        }
        if (event.payload.doneAt !== undefined) {
          const doneAt = event.payload.doneAt === null ? null : Date.parse(event.payload.doneAt)
          if (s.updateSessionDone.run(doneAt, event.payload.sessionId).changes !== 1) {
            throw new Error(`Cannot acknowledge missing session ${event.payload.sessionId}`)
          }
        }
        if (event.payload.backgroundTasks !== undefined) {
          // A roster reported while its session is being deleted has no row
          // left to describe; that is not worth rolling the batch back for.
          s.updateSessionBackground.run(
            event.payload.backgroundTasks.length > 0
              ? JSON.stringify(event.payload.backgroundTasks)
              : null,
            event.payload.sessionId,
          )
        }
        return
      case 'session.composer.updated':
        // A selection reported while its session is being deleted has no row
        // left to describe; that is not worth rolling the batch back for.
        s.updateSessionComposer.run(
          JSON.stringify(event.payload.composer),
          event.payload.sessionId,
        )
        return
      case 'draft.saved':
        drafts.saved(event.payload.draft)
        return
      case 'draft.deleted':
        drafts.deleted(event.payload, at)
        return
      case 'composer.preferences.updated':
      case 'provider.catalog.updated':
        // The composer store already holds both; the log only carries them to clients.
        return
      case 'session.deleted':
        s.deleteSession.run(event.payload.sessionId)
        return
      case 'thread.created': {
        const session = s.selectSessionWorkspace.get(event.scope.sessionId) as
          { workspace_id: string } | undefined
        if (!session) {
          throw new Error(`Cannot project thread for missing session ${event.scope.sessionId}`)
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
        if (s.updateOpenTurnState.run('waiting', at, turnId, event.scope.threadId).changes !== 1) {
          throw new Error(`Cannot mark missing or finished turn ${turnId} as waiting`)
        }
        s.updateSessionStatus.run('waiting', at, event.scope.sessionId)
        s.unsettleSession.run(event.scope.sessionId)
        return
      }
      case 'interaction.resolved':
      case 'interaction.expired': {
        const { response, turnId } = event.payload
        const resolved = s.resolvePendingInteraction.run(
          event.name === 'interaction.expired' ? 'expired' : 'resolved',
          JSON.stringify(response),
          at,
          at,
          event.name === 'interaction.resolved' ? (event.payload.resolvedByClientId ?? null) : null,
          response.interactionId,
          turnId,
          response.kind,
        )
        if (resolved.changes !== 1) {
          throw new Error(
            `Cannot resolve missing, mismatched, or settled interaction ${response.interactionId}`,
          )
        }
        const status = s.pendingInteractions.get(turnId) ? 'waiting' : 'running'
        if (s.updateOpenTurnState.run(status, at, turnId, event.scope.threadId).changes !== 1) {
          throw new Error(`Cannot resume missing or finished turn ${turnId}`)
        }
        s.updateSessionStatus.run(status, at, event.scope.sessionId)
        return
      }
      case 'turn.completed':
      case 'turn.interrupted':
      case 'turn.failed': {
        const turnId = event.payload.turnId
        const state =
          event.name === 'turn.completed'
            ? 'completed'
            : event.name === 'turn.interrupted'
              ? 'interrupted'
              : 'failed'
        const failure = event.name === 'turn.failed' ? event.payload : undefined
        const finished = s.finishOpenTurn.run(
          state,
          failure ? failure.reason : null,
          failure
            ? JSON.stringify({
                reason: failure.reason,
                message: failure.message,
                ...(failure.action ? { action: failure.action } : {}),
                ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {}),
              })
            : null,
          at,
          at,
          turnId,
          event.scope.threadId,
        )
        if (finished.changes !== 1) {
          throw new Error(`Cannot finalize missing or finished turn ${turnId}`)
        }
        s.finalizeTurnMessages.run(at, turnId)
        s.cancelPendingInteractions.run(at, at, turnId)
        // The turn is over but the session is not resting while work it
        // started is still running in the background.
        const working = !!s.hasBackgroundTasks.get(event.scope.sessionId)
        const session = s.updateSessionStatus.run(
          event.name === 'turn.failed' ? 'error' : working ? 'running' : 'idle',
          at,
          event.scope.sessionId,
        )
        if (session.changes !== 1) {
          throw new Error(`Cannot finalize turn for missing session ${event.scope.sessionId}`)
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
      case 'turn.notice.recorded':
        projectNotice(event, at)
        return
    }
  }
}
