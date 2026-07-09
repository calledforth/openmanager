import { memo, useRef } from 'react'

import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'

import { useMessageContent } from '../../data/useMessageContent'
import { useRemoteStreamingMessage } from '../../data/useRemoteStreamingMessage'
import type { SessionMessage } from '../../data/useSessionMessages'
import { AssistantMessage } from './AssistantMessage'
import { UserMessage } from './UserMessage'

// Port of the desktop `ResolvedMessage` (ChatView.tsx). Mobile is never the
// driving client, so the local-streaming branch is dropped: any non-final
// assistant message streams via `useRemoteStreamingMessage`.
//
// The last-known streaming parts/content are cached in refs so the
// isFinal-flips-true transition doesn't flash empty: `listMetadata` flips
// first, the streaming subscription is dropped (its state resets), and
// `getContent` needs a round-trip before the finalized body arrives. Until it
// does, we keep rendering what we last saw.

export const ResolvedMessage = memo(function ResolvedMessage({
  message,
  onStreamUpdate,
}: {
  message: SessionMessage
  onStreamUpdate?: () => void
}) {
  const isStreamingAssistant = message.role === 'assistant' && message.isFinal !== true

  const contentDoc = useMessageContent({
    externalId: message.externalId,
    role: message.role,
    isFinal: message.isFinal,
    isOptimistic: message.isOptimistic,
  })
  const remoteStreaming = useRemoteStreamingMessage(
    message.externalId,
    isStreamingAssistant,
    onStreamUpdate,
  )

  const finalizedParts = (contentDoc?.metadata as { parts?: StreamMessagePart[] } | undefined)
    ?.parts

  const lastStreamingPartsRef = useRef<StreamMessagePart[] | undefined>(undefined)
  const lastStreamingContentRef = useRef('')
  if (remoteStreaming.parts && remoteStreaming.parts.length > 0) {
    lastStreamingPartsRef.current = remoteStreaming.parts
  }
  if (remoteStreaming.content.length > 0) {
    lastStreamingContentRef.current = remoteStreaming.content
  }

  const content =
    message.role === 'assistant'
      ? message.isFinal === true
        ? (contentDoc?.content ?? lastStreamingContentRef.current)
        : remoteStreaming.content
      : (message.optimisticContent ?? contentDoc?.content ?? '')
  const parts =
    message.role === 'assistant' && message.isFinal !== true
      ? remoteStreaming.parts
      : (finalizedParts ?? lastStreamingPartsRef.current)

  if (message.role === 'user') {
    return <UserMessage content={content} isQueued={message.isOptimistic} />
  }

  return <AssistantMessage content={content} isFinal={message.isFinal} parts={parts} />
})
