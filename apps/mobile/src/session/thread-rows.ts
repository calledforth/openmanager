/**
 * One transcript row as the phone draws it, read from the shared thread
 * stores the way web's `ResolvedMessage` reads them: a user prompt from its
 * persisted body (or its echo, while the environment has not confirmed it),
 * an assistant turn from its live snapshot until the turn settles and from
 * its persisted body after. Pure, so the thread is tested without a screen.
 */
import type {
  LocalStreamingMessage,
  MessageContentSnapshot,
  MessagePart,
  StreamingMessageSource,
  MessageContentStore,
  UIMessage,
} from '@openmanager/app-core/logic'

export interface ThreadRowView {
  key: string
  role: 'user' | 'assistant'
  content: string
  parts: MessagePart[]
  /** The turn is over (always true for a user prompt). */
  isFinal: boolean
  /** An echo the environment has not confirmed yet. */
  queued: boolean
  /** Why the environment refused this send, once it says. */
  sendError?: string
  /** Images the echo carries, before the environment's copy of the prompt names them. */
  attachments: NonNullable<UIMessage['optimisticAttachments']>
  /** When a settled turn ran, from the environment's stamps, for "Worked for 14s". */
  runtime?: MessageContentSnapshot['runtime']
}

const NO_PARTS: MessagePart[] = []
const NO_ATTACHMENTS: ThreadRowView['attachments'] = []

/** Whether a row reads its persisted body: a settled turn or a confirmed prompt. */
export function readsPersistedContent(message: UIMessage): boolean {
  return !message.isOptimistic && (message.isFinal === true || message.role === 'user')
}

/** The row for `message`, from its persisted body and its live snapshot. Null for a role the phone does not draw. */
export function resolveThreadRow(
  message: UIMessage,
  content: MessageContentSnapshot | null | undefined,
  streaming: LocalStreamingMessage | undefined,
): ThreadRowView | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null
  const key = message.rowKey ?? message.externalId
  if (message.role === 'user') {
    return {
      key,
      role: 'user',
      content: message.optimisticContent ?? content?.content ?? streaming?.content ?? '',
      parts: content?.parts ?? streaming?.parts ?? NO_PARTS,
      isFinal: true,
      queued: message.isOptimistic === true,
      ...(message.sendError ? { sendError: message.sendError } : {}),
      attachments: message.optimisticAttachments ?? NO_ATTACHMENTS,
    }
  }
  const settled = message.isFinal === true
  return {
    key,
    role: 'assistant',
    content: settled ? (content?.content ?? streaming?.content ?? '') : (streaming?.content ?? ''),
    parts: settled
      ? (content?.parts ?? streaming?.parts ?? NO_PARTS)
      : (streaming?.parts ?? NO_PARTS),
    isFinal: settled,
    queued: false,
    attachments: NO_ATTACHMENTS,
    ...(settled && content?.runtime ? { runtime: content.runtime } : {}),
  }
}

/**
 * The turn an assistant row answers, from the row key the shared projection
 * gives a turn's reply (`turn:<turnId>:assistant`); null for any other row.
 */
export function turnIdOf(message: Pick<UIMessage, 'rowKey' | 'role'>): string | null {
  const key = message.rowKey
  if (message.role !== 'assistant' || !key) return null
  const prefix = 'turn:'
  const suffix = ':assistant'
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return null
  const turnId = key.slice(prefix.length, key.length - suffix.length)
  return turnId || null
}

/** Every row of a thread at once, for tests and the live check; the screen reads row by row. */
export function threadRowsOf(
  stores: { streamingStore: StreamingMessageSource; messageContentStore: MessageContentStore },
  messages: readonly UIMessage[],
): ThreadRowView[] {
  return messages.flatMap((message) => {
    const row = resolveThreadRow(
      message,
      readsPersistedContent(message)
        ? stores.messageContentStore.get(message.externalId)
        : undefined,
      stores.streamingStore.get(message.externalId),
    )
    return row ? [row] : []
  })
}
