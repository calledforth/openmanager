import type { DatabaseSync } from 'node:sqlite'
import {
  ContentBlockSchema,
  HistoryCursorSchema,
  InteractionSchema,
  InteractionResponseSchema,
  PlanHistoryEntrySchema,
  ReasoningBlockSchema,
  SessionListCursorSchema,
  SessionSummarySchema,
  ToolCallStateSchema,
  TurnSchema,
  resolvePageLimit,
  type ActivityRef,
  type HistoryCursor,
  type Interaction,
  type Message,
  type PlanHistoryEntry,
  type ReasoningBlock,
  type ToolCallState,
  type SessionListCursor,
  type SessionStatus,
  type SessionSummary,
  type Thread,
  type Turn,
  type TurnStart,
} from '@openmanager/protocol/node'
import {
  INTERACTIONS_FOR_TURN_SQL,
  INTERACTION_IN_THREAD_SQL,
  MESSAGE_HISTORY_PAGE_SQL,
  MESSAGE_PARTS_SQL,
  SESSION_LIST_FOR_ENVIRONMENT_SQL,
  SESSION_LIST_FOR_WORKSPACE_SQL,
  THREAD_IN_SESSION_SQL,
  THREADS_FOR_SESSION_SQL,
  TURN_ACTIVITY_PAGE_SQL,
  TURN_FOR_COMMAND_ID_SQL,
  TURNS_FOR_THREAD_SQL,
  USER_MESSAGE_FOR_TURN_SQL,
} from './queries.ts'

export interface SessionListQuery {
  workspaceId?: string
  cursor?: SessionListCursor
  limit?: number
}

export interface SessionListPage {
  sessions: SessionSummary[]
  nextCursor: SessionListCursor | null
}

export interface CommandTurnQuery {
  sessionId: string
  threadId: string
  commandId: string
}

export interface SessionHistoryQuery {
  sessionId: string
  threadId: string
  cursor?: HistoryCursor
  limit?: number
}

export interface SessionHistoryPage {
  messages: Message[]
  turns: Turn[]
  /** `turnId` is server-side detail for snapshots; the history response schema drops it. */
  interactions: Array<{ threadId: string; turnId: string; interaction: Interaction }>
  plans: PlanHistoryEntry[]
  /** Reasoning blocks and tool calls of the turns whose messages are on the page. */
  reasoning: ReasoningBlock[]
  tools: ToolCallState[]
  /** The page's messages, reasoning and tools in the order they happened. */
  order: ActivityRef[]
  nextCursor: HistoryCursor | null
}

type SessionRow = {
  session_id: string
  workspace_id: string
  parent_session_id: string | null
  provider_id: string
  title_source: string | null
  title: string | null
  status: string
  composer_json?: string | null
  updated_at: number
}

type ThreadRow = { thread_id: string; session_id: string }
type TurnRow = {
  turn_id: string
  thread_id: string
  state: string
  started_at: number
  finished_at: number | null
}
type TurnActivityRow = {
  activity_id: string
  turn_id: string
  kind: 'reasoning' | 'tool'
  ordinal: number
  state_json: string
}
type MessageRow = {
  message_id: string
  thread_id: string
  turn_id: string
  role: 'user' | 'assistant'
  ordinal: number
}
type PartRow = { content_json: string }
type InteractionRow = {
  turn_id: string
  request_json: string
  state: string
  created_at: number
  resolved_at: number | null
  resolved_by_client_id: string | null
}

function interactionFromRow(row: InteractionRow): Interaction {
  return InteractionSchema.parse({
    ...JSON.parse(row.request_json),
    lifecycle: {
      state: row.state,
      createdAt: new Date(row.created_at).toISOString(),
      resolvedAt: row.resolved_at === null ? null : new Date(row.resolved_at).toISOString(),
      resolvedByClientId: row.resolved_by_client_id,
    },
  })
}

const FIRST_LIST_CURSOR = {
  updatedAtMs: Number.MAX_SAFE_INTEGER,
  sessionId: '\uffff',
} as const
const FIRST_HISTORY_ORDINAL = Number.MAX_SAFE_INTEGER

export function sessionRowToSummary(row: SessionRow): SessionSummary {
  return SessionSummarySchema.parse({
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    title: row.title,
    ...(row.title_source !== null ? { titleSource: row.title_source } : {}),
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    status: row.status as SessionStatus,
    providerId: row.provider_id,
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.composer_json ? { composer: JSON.parse(row.composer_json) } : {}),
  })
}

/**
 * Newest-first keyset page over the environment or one workspace. Fetches
 * `limit + 1` so `nextCursor` is exact without counting the table.
 */
export function listSessionSummaries(
  database: DatabaseSync,
  query: SessionListQuery = {},
): SessionListPage {
  const limit = resolvePageLimit(query.limit)
  const cursor = query.cursor ? SessionListCursorSchema.parse(query.cursor) : undefined
  const updatedAtMs = cursor ? Date.parse(cursor.updatedAt) : FIRST_LIST_CURSOR.updatedAtMs
  const sessionId = cursor?.sessionId ?? FIRST_LIST_CURSOR.sessionId
  const rows = (
    query.workspaceId
      ? database
          .prepare(SESSION_LIST_FOR_WORKSPACE_SQL)
          .all(query.workspaceId, updatedAtMs, sessionId, limit + 1)
      : database.prepare(SESSION_LIST_FOR_ENVIRONMENT_SQL).all(updatedAtMs, sessionId, limit + 1)
  ) as SessionRow[]
  const page = rows.slice(0, limit).map(sessionRowToSummary)
  const last = page.at(-1)
  return {
    sessions: page,
    nextCursor:
      rows.length > limit && last ? { updatedAt: last.updatedAt, sessionId: last.sessionId } : null,
  }
}

export function listThreadsForSession(database: DatabaseSync, sessionId: string): Thread[] {
  return (database.prepare(THREADS_FOR_SESSION_SQL).all(sessionId) as ThreadRow[]).map((row) => ({
    threadId: row.thread_id,
    sessionId: row.session_id,
  }))
}

export function getSessionSummary(
  database: DatabaseSync,
  sessionId: string,
): SessionSummary | undefined {
  const row = database
    .prepare(
      `SELECT session_id, workspace_id, parent_session_id, provider_id, title, title_source, status,
              composer_json, updated_at
       FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as SessionRow | undefined
  return row ? sessionRowToSummary(row) : undefined
}

/**
 * The host session already registered for a provider's own session id, if
 * any. Child sessions are registered from provider subtask events, which
 * repeat across turns and reconnects, so registration must find its earlier
 * self instead of filing a second host session for the same provider thread.
 */
export function findSessionIdByProviderSession(
  database: DatabaseSync,
  providerId: string,
  providerSessionId: string,
): string | undefined {
  const row = database
    .prepare('SELECT session_id FROM sessions WHERE provider_id = ? AND provider_session_id = ?')
    .get(providerId, providerSessionId) as { session_id: string } | undefined
  return row?.session_id
}

/**
 * The provider's own session id, stored when the runtime session first
 * resolved. Resuming needs it to load the provider thread instead of
 * creating a second one for the same session.
 */
export function getProviderSessionId(
  database: DatabaseSync,
  sessionId: string,
): string | undefined {
  const row = database
    .prepare('SELECT provider_session_id FROM sessions WHERE session_id = ?')
    .get(sessionId) as { provider_session_id: string | null } | undefined
  return row?.provider_session_id ?? undefined
}

/**
 * One newest-first page of a thread's messages, with parts, turns, and
 * pending interactions hydrated. `nextCursor.ordinal` is the oldest ordinal
 * on this page — the exclusive bound for the next older page.
 */
export function listSessionHistory(
  database: DatabaseSync,
  query: SessionHistoryQuery,
): SessionHistoryPage | undefined {
  const thread = database.prepare(THREAD_IN_SESSION_SQL).get(query.threadId, query.sessionId) as
    ThreadRow | undefined
  if (!thread) return undefined

  const limit = resolvePageLimit(query.limit)
  const ordinal = query.cursor
    ? HistoryCursorSchema.parse(query.cursor).ordinal
    : FIRST_HISTORY_ORDINAL
  const rows = database
    .prepare(MESSAGE_HISTORY_PAGE_SQL)
    .all(query.threadId, ordinal, limit + 1) as MessageRow[]
  const pageRows = rows.slice(0, limit)
  const messages = pageRows.map((row) => messageFromRow(database, row)).reverse()
  const turns = (database.prepare(TURNS_FOR_THREAD_SQL).all(query.threadId) as TurnRow[]).map(
    (row) =>
      TurnSchema.parse({
        turnId: row.turn_id,
        threadId: row.thread_id,
        state: row.state,
        startedAt: new Date(row.started_at).toISOString(),
        ...(row.finished_at === null ? {} : { finishedAt: new Date(row.finished_at).toISOString() }),
      }),
  )
  // The reasoning and tool calls that belong to this page: everything after
  // the newest message the next older page will carry, up to this page's own
  // newest message. Activity goes with the message that followed it, and what
  // followed nothing yet (a turn that ended in a tool call) goes with the
  // newest page. Both tables draw their ordinal from the same thread-wide
  // counter, so the window partitions activity across pages exactly and one
  // sort interleaves it with the page's messages.
  const olderBound = rows[limit]?.ordinal ?? -1
  const newerBound = query.cursor ? (pageRows[0]?.ordinal ?? olderBound) : ordinal
  const activityRows = database
    .prepare(TURN_ACTIVITY_PAGE_SQL)
    .all(query.threadId, olderBound, newerBound) as TurnActivityRow[]
  const reasoning: ReasoningBlock[] = []
  const tools: ToolCallState[] = []
  for (const row of activityRows) {
    const state: unknown = JSON.parse(row.state_json)
    if (row.kind === 'reasoning') reasoning.push(ReasoningBlockSchema.parse(state))
    else tools.push(ToolCallStateSchema.parse(state))
  }
  capReasoningText(reasoning)
  const order: ActivityRef[] = [
    ...pageRows.map((row) => ({
      ordinal: row.ordinal,
      ref: { kind: 'message' as const, id: row.message_id, turnId: row.turn_id },
    })),
    ...activityRows.map((row) => ({
      ordinal: row.ordinal,
      ref: { kind: row.kind, id: row.activity_id, turnId: row.turn_id },
    })),
  ]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((item) => item.ref)
  const interactions = turns.flatMap((turn) =>
    (database.prepare(INTERACTIONS_FOR_TURN_SQL).all(turn.turnId) as InteractionRow[]).map(
      (row) => ({
        threadId: query.threadId,
        turnId: turn.turnId,
        interaction: interactionFromRow(row),
      }),
    ),
  )
  const oldest = pageRows.at(-1)
  const plans = (
    database
      .prepare(
        `
    SELECT interactions.turn_id, request_json, response_json, interactions.state,
           interactions.created_at, resolved_at, resolved_by_client_id
    FROM interactions JOIN turns ON turns.turn_id = interactions.turn_id
    WHERE turns.thread_id = ? AND kind = 'plan'
    ORDER BY interactions.created_at, interaction_id
  `,
      )
      .all(query.threadId) as Array<
      InteractionRow & {
        response_json: string | null
      }
    >
  ).map((row) =>
    PlanHistoryEntrySchema.parse({
      threadId: query.threadId,
      turnId: row.turn_id,
      plan: interactionFromRow(row),
      state: row.state,
      outcome: row.response_json
        ? InteractionResponseSchema.parse(JSON.parse(row.response_json)).outcome
        : undefined,
    }),
  )
  return {
    messages,
    turns,
    interactions,
    plans,
    reasoning,
    tools,
    order,
    nextCursor: rows.length > limit && oldest !== undefined ? { ordinal: oldest.ordinal } : null,
  }
}

function messageFromRow(database: DatabaseSync, row: MessageRow): Message {
  const parts = database.prepare(MESSAGE_PARTS_SQL).all(row.message_id) as PartRow[]
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    role: row.role,
    content: parts.map((part) => ContentBlockSchema.parse(JSON.parse(part.content_json))),
  }
}

/**
 * Reasoning text a page may carry before the oldest blocks are elided. A
 * history page or a snapshot is one socket frame under a 1 MiB budget shared
 * with the messages; a long session's thoughts alone could exceed it and cost
 * the client its connection instead of its transcript.
 */
export const REASONING_TEXT_BUDGET_BYTES = 384 * 1024

/**
 * Keep the newest reasoning text whole and replace what falls outside the
 * budget with a note of how much was left out. Tokens and phase stay, so the
 * row still reads as a finished thought of a known size.
 */
function capReasoningText(reasoning: ReasoningBlock[]): void {
  let remaining = REASONING_TEXT_BUDGET_BYTES
  for (let index = reasoning.length - 1; index >= 0; index -= 1) {
    const block = reasoning[index]!
    const bytes = Buffer.byteLength(JSON.stringify(block.content), 'utf8')
    if (bytes <= remaining) {
      remaining -= bytes
      continue
    }
    const characters = block.content.reduce(
      (total, item) => total + (item.type === 'text' ? item.text.length : 0),
      0,
    )
    reasoning[index] = {
      ...block,
      content: [{ type: 'text', text: `[${characters} characters of thinking not loaded]` }],
    }
    remaining = 0
  }
}

/**
 * Whether the log holds this interaction for the thread. One that memory has
 * forgotten — a restart ends every turn — can only be settled by now.
 */
export function hasInteraction(
  database: DatabaseSync,
  query: { sessionId: string; threadId: string; interactionId: string },
): boolean {
  return !!database
    .prepare(INTERACTION_IN_THREAD_SQL)
    .get(query.interactionId, query.threadId, query.sessionId)
}

/**
 * The turn a command id already started in this thread, with the prompt it
 * recorded. A retry of that id answers with this turn rather than starting a
 * second one, including after a restart when nothing is left in memory.
 */
export function findTurnByCommandId(
  database: DatabaseSync,
  query: CommandTurnQuery,
): TurnStart | undefined {
  const thread = database.prepare(THREAD_IN_SESSION_SQL).get(query.threadId, query.sessionId) as
    ThreadRow | undefined
  if (!thread) return undefined
  const turn = database.prepare(TURN_FOR_COMMAND_ID_SQL).get(query.threadId, query.commandId) as
    TurnRow | undefined
  if (!turn) return undefined
  const message = database.prepare(USER_MESSAGE_FOR_TURN_SQL).get(turn.turn_id) as
    MessageRow | undefined
  if (!message) return undefined
  return {
    turn: TurnSchema.parse({ turnId: turn.turn_id, threadId: turn.thread_id, state: turn.state }),
    userMessage: messageFromRow(database, message),
    commandId: query.commandId,
  }
}
