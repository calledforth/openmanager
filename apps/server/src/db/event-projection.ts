import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ProofEvent } from '@openmanager/protocol/node'
import type { DurableProofEvent } from './event-repository.ts'

type SessionSummary = Extract<ProofEvent, { name: 'session.created' }>['payload']['session']
type TurnStarted = Extract<ProofEvent, { name: 'turn.started' }>
type MessageDelta = Extract<ProofEvent, { name: 'message.delta' }>
type MessageContent = MessageDelta['payload']['content']

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
  const s = {
    insertSession: database.prepare(
      `INSERT INTO sessions (
         session_id, workspace_id, provider_id, title, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'idle', ?, ?)`,
    ),
    updateWorkspaceName: database.prepare(
      'UPDATE workspaces SET name = ?, updated_at = ? WHERE workspace_id = ?',
    ),
    updateSessionTitle: database.prepare(
      'UPDATE sessions SET title = ?, updated_at = ? WHERE session_id = ?',
    ),
    updateSessionStatus: database.prepare(
      'UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?',
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
    selectThreadWorkspace: database.prepare(
      'SELECT workspace_id FROM threads WHERE thread_id = ?',
    ),
    insertTurn: database.prepare(
      `INSERT INTO turns (
         turn_id, thread_id, workspace_id, state, started_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
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
       SET state = ?, failure_reason = ?, finished_at = ?, updated_at = ?
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
       SET state = 'resolved', response_json = ?, resolved_at = ?, updated_at = ?
       WHERE interaction_id = ? AND turn_id = ? AND kind = ? AND state = 'pending'`,
    ),
    selectMessage: database.prepare(
      'SELECT turn_id, thread_id, role, is_final FROM messages WHERE message_id = ?',
    ),
    nextMessageOrdinal: database.prepare(
      'SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM messages WHERE thread_id = ?',
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
    message: TurnStarted['payload']['userMessage'],
    workspaceId: string,
    isFinal: boolean,
    at: number,
  ): void {
    const { ordinal } = s.nextMessageOrdinal.get(message.threadId) as { ordinal: number }
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
      | { part_id: string; ordinal: number; part_type: string; content_json: string }
      | undefined
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
      | { workspace_id: string }
      | undefined
    if (!thread) throw new Error(`Cannot project turn for missing thread ${event.scope.threadId}`)
    s.insertTurn.run(
      event.payload.turn.turnId,
      event.scope.threadId,
      thread.workspace_id,
      event.payload.turn.state,
      at,
      at,
    )
    insertMessage(event.payload.userMessage, thread.workspace_id, true, at)
    s.updateSessionStatus.run('running', at, event.scope.sessionId)
  }

  function projectMessageDelta(event: MessageDelta, at: number): void {
    const { messageId, turnId, role, content } = event.payload
    const turn = s.selectTurnWorkspace.get(turnId, event.scope.threadId) as
      | { workspace_id: string }
      | undefined
    if (!turn) throw new Error(`Cannot project message for missing turn ${turnId}`)
    const existing = s.selectMessage.get(messageId) as
      | { turn_id: string; thread_id: string; role: string; is_final: number }
      | undefined
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

  return function projectEvent(event: DurableProofEvent): void {
    const at = Date.parse(event.timestamp)
    switch (event.name) {
      case 'session.created': {
        const session = event.payload.session
        const providerId = options.sessionProviderId?.(session)
        if (!providerId?.trim()) {
          throw new Error('session.created requires a host sessionProviderId resolver')
        }
        s.insertSession.run(
          session.sessionId,
          session.workspaceId,
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
      case 'session.updated':
        if (event.payload.title !== undefined) {
          s.updateSessionTitle.run(event.payload.title, at, event.payload.sessionId)
        }
        return
      case 'session.deleted':
        s.deleteSession.run(event.payload.sessionId)
        return
      case 'thread.created': {
        const session = s.selectSessionWorkspace.get(event.scope.sessionId) as
          | { workspace_id: string }
          | undefined
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
        return
      }
      case 'interaction.resolved': {
        const { response, turnId } = event.payload
        const resolved = s.resolvePendingInteraction.run(
          JSON.stringify(response),
          at,
          at,
          response.interactionId,
          turnId,
          response.kind,
        )
        if (resolved.changes !== 1) {
          throw new Error(
            `Cannot resolve missing, mismatched, or settled interaction ${response.interactionId}`,
          )
        }
        if (s.updateOpenTurnState.run('running', at, turnId, event.scope.threadId).changes !== 1) {
          throw new Error(`Cannot resume missing or finished turn ${turnId}`)
        }
        s.updateSessionStatus.run('running', at, event.scope.sessionId)
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
        const finished = s.finishOpenTurn.run(
          state,
          event.name === 'turn.failed' ? event.payload.reason : null,
          at,
          at,
          turnId,
          event.scope.threadId,
        )
        if (finished.changes !== 1) {
          throw new Error(`Cannot finalize missing or finished turn ${turnId}`)
        }
        s.finalizeTurnMessages.run(at, turnId)
        const session = s.updateSessionStatus.run(
          event.name === 'turn.failed' ? 'error' : 'idle',
          at,
          event.scope.sessionId,
        )
        if (session.changes !== 1) {
          throw new Error(`Cannot finalize turn for missing session ${event.scope.sessionId}`)
        }
        return
      }
      case 'message.reasoning':
      case 'tool.updated':
        return
    }
  }
}
