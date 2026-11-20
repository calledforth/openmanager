import type { DatabaseSync } from 'node:sqlite'
import { ContentBlockSchema, type ContentBlock } from '@openmanager/protocol/node'
import type { SessionHistoryMessage } from '@agentpack/runtime/node'
import type { TitleContextMessage } from './context.ts'

/**
 * How many of a thread's newest messages a rename reads. The title context is
 * 8,000 characters, so a long session's older middle would be cut anyway; the
 * first user message is read on top of these, since it opened the subject.
 */
export const TITLE_TRANSCRIPT_RECENT_MESSAGES = 60

type Row = { message_id: string; role: 'user' | 'assistant'; ordinal: number }
type PartRow = { content_json: string }

/** A user message that is a prompt, not a command that ran a provider
 * operation (`/review`, `/compact`): a command says nothing about what the
 * chat is about, and is not the prompt a title is written from. */
const IS_PROMPT_SQL = `NOT EXISTS (
    SELECT 1 FROM turns
    WHERE turns.turn_id = messages.turn_id AND turns.origin IN ('review', 'compact')
  )`
const FIRST_USER_MESSAGE_SQL = `
  SELECT message_id, role, ordinal FROM messages
  WHERE thread_id = ? AND role = 'user' AND ${IS_PROMPT_SQL}
  ORDER BY ordinal
  LIMIT 1`
const RECENT_MESSAGES_SQL = `
  SELECT message_id, role, ordinal FROM messages
  WHERE thread_id = ?
  ORDER BY ordinal DESC
  LIMIT ?`
const PARTS_SQL = `SELECT content_json FROM message_parts WHERE message_id = ? ORDER BY ordinal`
const USER_MESSAGE_COUNT_SQL = `
  SELECT COUNT(*) AS count FROM messages WHERE thread_id = ? AND role = 'user' AND ${IS_PROMPT_SQL}`

/** A thread's conversation as the title model reads it, oldest first. */
export function readTitleTranscript(
  database: DatabaseSync,
  threadId: string,
): TitleContextMessage[] {
  const first = database.prepare(FIRST_USER_MESSAGE_SQL).get(threadId) as Row | undefined
  const recent = database
    .prepare(RECENT_MESSAGES_SQL)
    .all(threadId, TITLE_TRANSCRIPT_RECENT_MESSAGES) as Row[]
  const rows = new Map<string, Row>()
  for (const row of [...(first ? [first] : []), ...recent]) rows.set(row.message_id, row)
  const parts = database.prepare(PARTS_SQL)
  return [...rows.values()]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((row) =>
      titleMessage(
        row.role,
        (parts.all(row.message_id) as PartRow[]).flatMap((part) => {
          const block = ContentBlockSchema.safeParse(JSON.parse(part.content_json))
          return block.success ? [block.data] : []
        }),
      ),
    )
}

/** How many prompts the user has sent in a thread; commands that ran an
 * operation are not prompts. */
export function countUserMessages(database: DatabaseSync, threadId: string): number {
  const row = database.prepare(USER_MESSAGE_COUNT_SQL).get(threadId) as { count: number }
  return row.count
}

/** Text as written; anything attached, by name. */
export function titleMessage(
  role: TitleContextMessage['role'],
  content: readonly ContentBlock[],
): TitleContextMessage {
  const text: string[] = []
  const attachments: string[] = []
  for (const block of content) {
    if (block.type === 'text') text.push(block.text)
    else if (block.type === 'artifact') attachments.push(block.name)
    else if (block.type === 'resource_link') attachments.push(block.name ?? block.uri)
    else if (block.type === 'resource' && block.uri) attachments.push(block.uri)
    else if (block.type === 'image') attachments.push(`image (${block.mimeType})`)
  }
  return {
    role,
    text: text.join('\n'),
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

/** How many of a thread's newest messages a fresh provider session is handed
 * when the provider lost its own copy (`HostDeps.sessionHistory`). The runtime
 * bounds the text again; this bounds the read. */
export const HANDOVER_RECENT_MESSAGES = 200

/** A thread's newest messages, oldest first, with their ids and text: what a
 * provider that lost the conversation is handed. Attachments are named, as
 * the title model reads them. */
export function readSessionHistory(
  database: DatabaseSync,
  threadId: string,
): SessionHistoryMessage[] {
  const recent = database
    .prepare(RECENT_MESSAGES_SQL)
    .all(threadId, HANDOVER_RECENT_MESSAGES) as Row[]
  const parts = database.prepare(PARTS_SQL)
  return recent
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((row) => {
      const message = titleMessage(
        row.role,
        (parts.all(row.message_id) as PartRow[]).flatMap((part) => {
          const block = ContentBlockSchema.safeParse(JSON.parse(part.content_json))
          return block.success ? [block.data] : []
        }),
      )
      const attached = message.attachments?.length
        ? `\n\n(Attached: ${message.attachments.join(', ')})`
        : ''
      return { messageId: row.message_id, role: row.role, text: `${message.text}${attached}` }
    })
}
