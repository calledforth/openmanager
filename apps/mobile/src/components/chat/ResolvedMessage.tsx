import { memo, useContext, useMemo, useRef } from 'react'
import { View } from 'react-native'
import { useMessageContent, useStreamingMessage, type UIMessage } from '@openmanager/app-core/logic'

import {
  MessageActionsContext,
  MessageRowContext,
  type MessageRowActions,
} from '../../session/message-actions'
import { messageTargetOf } from '../../session/message-text'
import { countRender } from '../../session/render-probe'
import {
  readsPersistedContent,
  resolveThreadRow,
  type ThreadRowView,
} from '../../session/thread-rows'
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
  const row = resolveThreadRow(message, content, streaming)

  // A long press on the row's words opens its actions with what it says
  // then. Read at the press, so the row's words below it never re-render
  // for a context that changes with every token.
  const page = useContext(MessageActionsContext)
  const latest = useRef<ThreadRowView | null>(row)
  latest.current = row
  const actions = useMemo<MessageRowActions | null>(
    () =>
      page && {
        open() {
          const target = latest.current && messageTargetOf(latest.current)
          if (target) page.open(target)
        },
      },
    [page],
  )

  if (!row) return null
  return (
    <MessageRowContext.Provider value={actions}>
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
          />
        )}
      </View>
    </MessageRowContext.Provider>
  )
})
