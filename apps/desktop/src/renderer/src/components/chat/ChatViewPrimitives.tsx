import { type ReactNode } from 'react'
import { MessageParts } from '../parts/MessageParts'
import { TextPart } from '../parts/TextPart'
import { cn } from '../../lib/utils'
import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'
import { ReferenceComposerToolbar } from './composer-toolbar'
import { chatInputShell, chatUserInner, chatStreamInner } from './chatComposerStyles'
import { typographyCaption } from '../../lib/typography'

export interface RuntimeMetadata {
  providerId?: string
  modelId?: string
  modeId?: string
  agentId?: string
  finishReason?: string
  costUsd?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
}

type MessagePart = StreamMessagePart

export function ChatViewPanel({ children }: { children: ReactNode }) {
  return (
    <div data-chat-view className="flex min-h-0 flex-1 flex-col">
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
        <MessageLoadingSkeleton role="user" announce={false} />
        <MessageLoadingSkeleton role="assistant" announce={false} />
        <MessageLoadingSkeleton role="user" announce={false} compact />
        <MessageLoadingSkeleton role="assistant" announce={false} compact />
      </div>
    </div>
  )
}

export function MessageLoadingSkeleton({
  role,
  announce = true,
  compact = false,
}: {
  role: string
  announce?: boolean
  compact?: boolean
}) {
  const isUser = role === 'user'
  return (
    <div
      role={announce ? 'status' : undefined}
      aria-label={announce ? 'Loading message' : undefined}
      aria-hidden={announce ? undefined : true}
      className={cn('w-full py-1', announce && 'chat-animate-fade-in')}
    >
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

export function UserMessage({ content, runtime }: { content: string; runtime?: RuntimeMetadata }) {
  return (
    <div className="w-full py-1">
      <div className={cn(chatInputShell, 'max-w-none')}>
        <div className={chatUserInner}>
          <div className="min-w-0 whitespace-pre-wrap break-words">{content}</div>
        </div>
        <div className="px-1 pb-0.5" onClick={(e) => e.stopPropagation()}>
          <ReferenceComposerToolbar />
        </div>
      </div>
      <MessageRuntimeMeta runtime={runtime} align="right" />
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
  runtime?: RuntimeMetadata
}) {
  const hasParts = !!parts && parts.length > 0
  const isStreaming = isFinal === false

  return (
    <div className="py-1">
      <div className={cn(chatStreamInner, isStreaming ? 'opacity-90' : 'opacity-100')}>
        {hasParts ? (
          <MessageParts parts={parts} isStreaming={isStreaming} />
        ) : (
          <TextPart text={content} />
        )}
      </div>
      <MessageRuntimeMeta runtime={runtime} align="left" />
    </div>
  )
}

export function MessageRuntimeMeta({
  runtime,
  align,
}: {
  runtime?: RuntimeMetadata
  align: 'left' | 'right'
}) {
  if (!runtime) return null
  const parts: string[] = []
  const modelLabel =
    runtime.providerId && runtime.modelId
      ? `${runtime.providerId}/${runtime.modelId}`
      : (runtime.modelId ?? undefined)
  if (modelLabel) parts.push(modelLabel)
  if (runtime.modeId) parts.push(`mode:${runtime.modeId}`)
  if (runtime.agentId) parts.push(`agent:${runtime.agentId}`)
  if (runtime.tokens?.total != null) parts.push(`${runtime.tokens.total} tokens`)
  if (runtime.costUsd != null && runtime.costUsd > 0) parts.push(`$${runtime.costUsd.toFixed(4)}`)
  if (runtime.finishReason) parts.push(runtime.finishReason)
  if (parts.length === 0) return null

  return (
    <div
      className={cn(
        typographyCaption,
        'mt-0.5 tabular-nums text-[var(--basis-text-faint)]',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {parts.join(' • ')}
    </div>
  )
}
