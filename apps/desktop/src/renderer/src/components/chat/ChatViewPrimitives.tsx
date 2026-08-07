import { type ReactNode } from 'react'
import { MessageParts } from '../parts/MessageParts'
import { TurnWorkGroup } from '../parts/TurnWorkGroup'
import {
  partitionSettledTurnParts,
  settledTurnLabel,
  type TurnRuntimeMetadata,
} from '../parts/turn-work-group'
import { TextPart } from '../parts/TextPart'
import { cn } from '../../lib/utils'
import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'
import { chatStreamInner } from './chatComposerStyles'

export { UserMessage } from './UserMessage'

type MessagePart = StreamMessagePart

export function ChatViewPanel({ children }: { children: ReactNode }) {
  return (
    <div data-chat-view className="relative flex min-h-0 flex-1 flex-col">
      <div
        aria-hidden="true"
        className="chat-pane-top-fade pointer-events-none absolute inset-x-0 top-0 z-10 h-8"
      />
      {children}
    </div>
  )
}

export function ChatLoadingSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading conversation"
      className="chat-animate-fade-in space-y-5 py-4"
    >
      <div aria-hidden="true" className="space-y-5">
        <SkeletonMessageShape role="user" />
        <SkeletonMessageShape role="assistant" />
        <SkeletonMessageShape role="user" compact />
        <SkeletonMessageShape role="assistant" compact />
      </div>
    </div>
  )
}

function SkeletonMessageShape({ role, compact = false }: { role: string; compact?: boolean }) {
  const isUser = role === 'user'
  return (
    <div className="w-full py-1">
      <div className={cn('space-y-2', isUser ? 'ml-auto w-[68%] max-w-xl' : 'mr-auto w-[82%]')}>
        <div
          className={cn('chat-skeleton h-3 rounded-full', isUser ? 'ml-auto w-full' : 'w-[88%]')}
        />
        <div
          className={cn(
            'chat-skeleton h-3 rounded-full',
            isUser
              ? compact
                ? 'ml-auto w-[42%]'
                : 'ml-auto w-[72%]'
              : compact
                ? 'w-[48%]'
                : 'w-[66%]',
          )}
        />
        {!compact && !isUser && <div className="chat-skeleton h-3 w-[38%] rounded-full" />}
      </div>
    </div>
  )
}

export function AssistantMessage({
  content,
  isFinal,
  parts,
  runtime,
}: {
  content: string
  isFinal?: boolean
  parts?: MessagePart[]
  runtime?: TurnRuntimeMetadata
}) {
  const hasParts = !!parts && parts.length > 0
  const isStreaming = isFinal === false
  const partition = hasParts && isFinal === true ? partitionSettledTurnParts(parts) : undefined
  const workParts = partition?.workParts ?? []
  const finalParts = partition?.finalParts ?? []
  const hasWorkGroup = workParts.length > 0

  return (
    <div className="py-1">
      <div className={cn(chatStreamInner, isStreaming ? 'opacity-90' : 'opacity-100')}>
        {hasWorkGroup ? (
          <>
            <TurnWorkGroup label={settledTurnLabel(runtime)} parts={workParts} />
            {finalParts.length > 0 && <MessageParts parts={finalParts} isStreaming={false} />}
          </>
        ) : hasParts ? (
          <MessageParts parts={parts} isStreaming={isStreaming} />
        ) : (
          <TextPart text={content} />
        )}
      </div>
    </div>
  )
}
