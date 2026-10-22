import { memo } from 'react'
import { View } from 'react-native'
import { useMessageContent, useStreamingMessage, type UIMessage } from '@openmanager/app-core/logic'

import { countRender } from '../../session/render-probe'
import { readsPersistedContent, resolveThreadRow, turnIdOf } from '../../session/thread-rows'
import { useTurnNotices } from '../../session/turn-notices'
import { AssistantMessage } from './AssistantMessage'
import { UserMessage } from './UserMessage'

/**
 * One transcript row, read from the shared thread stores as web's
 * `ResolvedMessage` reads them, so a streamed token re-renders only the row
 * it lands in. The list hands it the same `message` object for as long as
 * the row says the same thing, so the memo holds across list updates.
 */
export const ResolvedMessage = memo(function ResolvedMessage({ message }: { message: UIMessage }) {
  countRender('ResolvedMessage')
  const streaming = useStreamingMessage(message.externalId)
  const content = useMessageContent(message.externalId, readsPersistedContent(message))
  const notices = useTurnNotices(turnIdOf(message))
  const row = resolveThreadRow(message, content, streaming)

  if (!row) return null
  return (
    <View style={{ paddingVertical: 7 }}>
      {row.role === 'user' ? (
        <UserMessage
          content={row.content}
          parts={row.parts}
          attachments={row.attachments}
          isQueued={row.queued}
          sendError={row.sendError}
        />
      ) : (
        <AssistantMessage
          content={row.content}
          isFinal={row.isFinal}
          parts={row.parts}
          runtime={row.runtime}
          notices={notices}
        />
      )}
    </View>
  )
})
