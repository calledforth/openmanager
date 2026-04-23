import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MessageParts } from '../parts/MessageParts'
import { TextPart } from '../parts/TextPart'
import { cn } from '../../lib/utils'
import type { StreamMessagePart } from '../../lib/remote-stream-parts'
import { ReferenceComposerToolbar } from './composer-toolbar'

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

interface MessagePart extends StreamMessagePart {}

export function ChatViewPanel({
  title,
  status,
  isStreaming,
  onAbort,
  children,
}: {
  title: string
  status?: string
  isStreaming: boolean
  onAbort: () => void
  children: ReactNode
}) {
  return (
    <div data-chat-view className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2.5 flex justify-between items-center shrink-0">
        <span className="text-14-medium text-sidebar-primary">{title}</span>
        <div className="flex items-center gap-2">
          {status && status !== 'idle' && (
            <span
              className={cn(
                'text-11-regular',
                status === 'running' || status === 'busy'
                  ? 'text-primary'
                  : status === 'error'
                    ? 'text-destructive'
                    : 'text-muted-foreground',
              )}
            >
              {status}
            </span>
          )}
          {isStreaming && (
            <button
              type="button"
              onClick={onAbort}
              className="rounded-md border border-destructive px-2 py-0.5 text-11-regular text-destructive bg-transparent cursor-pointer transition-default hover:bg-destructive/10"
            >
              Stop
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  )
}

export function UserMessage({ content, runtime }: { content: string; runtime?: RuntimeMetadata }) {
  const [expanded, setExpanded] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const [showGradient, setShowGradient] = useState(false)

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const check = () => setShowGradient(el.scrollHeight > el.clientHeight)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [content])

  const canExpand = showGradient && !expanded

  return (
    <div className="w-full py-1.5">
      <div className="flex w-full flex-col shadow-2xl shadow-black/40">
        <div
          role={canExpand ? 'button' : undefined}
          tabIndex={canExpand ? 0 : undefined}
          onClick={() => canExpand && setExpanded(true)}
          onKeyDown={(e) => {
            if (!canExpand) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setExpanded(true)
            }
          }}
          className={cn(
            'chat-composer-glass relative flex w-full flex-col gap-2 rounded-md border border-white/10 p-2.5 transition-all duration-200',
            canExpand ? 'cursor-pointer hover:border-white/15' : '',
          )}
        >
          <div className="relative min-w-0">
            <div
              ref={contentRef}
              className={cn(
                'chat-user min-w-0 whitespace-pre-wrap break-words text-neutral-200',
                canExpand && !expanded && 'max-h-[100px] overflow-hidden',
              )}
            >
              {content}
            </div>
            {canExpand && !expanded && (
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[rgb(10,10,10)] to-transparent"
                aria-hidden
              />
            )}
          </div>

          <div
            className="mt-0.5"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <ReferenceComposerToolbar />
          </div>
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
    <div className="py-2">
      <div className="text-foreground/90 space-y-0.5">
        {hasParts ? (
          <MessageParts parts={parts} isStreaming={isStreaming} />
        ) : (
          <div className={isStreaming ? 'opacity-80' : 'opacity-100'}>
            <TextPart text={content} />
          </div>
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
        'mt-1 text-11-regular text-muted-foreground tabular-nums',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {parts.join(' • ')}
    </div>
  )
}
