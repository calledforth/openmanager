import { memo, useEffect } from 'react'
import { useMessageContent, useStreamingMessage, type UIMessage } from '@openmanager/app-core/logic'

import { readsPersistedContent, resolveThreadRow } from '../../session/thread-rows'
import { AssistantMessage } from './AssistantMessage'
import { UserMessage } from './UserMessage'

/**
 * One transcript row, read from the shared thread stores as web's
 * `ResolvedMessage` reads them, so a streamed token re-renders only the row
 * it lands in. `onStreamUpdate` tells the list a live row changed size.
 */
export const ResolvedMessage = memo(function ResolvedMessage({
  message,
  onStreamUpdate,
}: {
  message: UIMessage
  onStreamUpdate?: () => void
}) {
  const streaming = useStreamingMessage(message.externalId)
  const content = useMessageContent(message.externalId, readsPersistedContent(message))
  const row = resolveThreadRow(message, content, streaming)

  const live = row?.role === 'assistant' && !row.isFinal
  useEffect(() => {
    if (live) onStreamUpdate?.()
  }, [live, onStreamUpdate, streaming])

  if (!row) return null
  if (row.role === 'user') {
    return (
      <UserMessage
        content={row.content}
        parts={row.parts}
        attachments={row.attachments}
        isQueued={row.queued}
        sendError={row.sendError}
      />
    )
  }
  return <AssistantMessage content={row.content} isFinal={row.isFinal} parts={row.parts} />
})
