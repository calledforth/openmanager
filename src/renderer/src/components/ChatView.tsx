import { useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../stores/session-store'
import { MessageParts } from './parts/MessageParts'
import { TextPart } from './parts/TextPart'
import { cn } from '../lib/utils'

export function ChatView() {
  const { activeSessionId, messages, sessions, abortSession } = useSessionStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeSession = sessions.find((s) => s.externalId === activeSessionId)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  if (!activeSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Select or create a session
      </div>
    )
  }

  const chatMessages = messages.filter((m) => m.role !== 'permission')

  return (
    <div data-chat-view className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="px-5 py-2.5 border-b border-border flex justify-between items-center flex-shrink-0">
        <span className="text-sm font-medium text-muted-foreground">
          {activeSession?.title || activeSessionId.slice(0, 12)}
        </span>
        <div className="flex items-center gap-2">
          {activeSession?.status && activeSession.status !== 'idle' && (
            <span
              className={cn(
                'text-[11px]',
                activeSession.status === 'running' || activeSession.status === 'busy'
                  ? 'text-emerald-400'
                  : activeSession.status === 'error'
                    ? 'text-red-400'
                    : 'text-muted-foreground'
              )}
            >
              {activeSession.status}
            </span>
          )}
          {(activeSession?.status === 'running' || activeSession?.status === 'busy') && (
            <button
              type="button"
              onClick={() => abortSession(activeSessionId)}
              className="bg-transparent text-red-400 border border-red-400 rounded px-2 py-0.5 text-[11px] cursor-pointer hover:bg-red-400/10 transition-colors"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden px-5 py-4 min-h-0"
      >
        {chatMessages.length === 0 && (
          <div className="text-muted-foreground/70 text-[13px] text-center mt-10">
            Send a message to start
          </div>
        )}

        {chatMessages.map((msg) => (
          <div key={msg.externalId} className="mb-5 chat-animate-slide-up">
            {msg.role === 'user' ? (
              <UserMessage content={msg.content} />
            ) : (
              <AssistantMessage msg={msg} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function UserMessage({ content }: { content: string }) {
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
    <div className="flex justify-end">
      <div
        className={cn(
          'max-w-[80%] relative bg-input-background border border-border px-3 py-2 rounded-xl text-sm text-foreground leading-relaxed whitespace-pre-wrap break-words transition-all duration-200',
          canExpand ? 'cursor-pointer hover:brightness-110' : ''
        )}
        onClick={() => canExpand && setExpanded(true)}
      >
        <div
          ref={contentRef}
          className={cn(canExpand && 'max-h-[100px] overflow-hidden')}
        >
          {content}
        </div>
        {canExpand && (
          <div
            className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-input-background to-transparent pointer-events-none"
            aria-hidden
          />
        )}
      </div>
    </div>
  )
}

interface AssistantMsg {
  content: string
  isFinal?: boolean
  parts?: Array<{ type: string; id: string; [key: string]: unknown }>
}

function AssistantMessage({ msg }: { msg: AssistantMsg }) {
  const hasParts = msg.parts && msg.parts.length > 0
  const isStreaming = msg.isFinal === false

  return (
    <div className="max-w-full">
      {hasParts ? (
        <div className={isStreaming ? 'opacity-90' : 'opacity-100'}>
          <MessageParts parts={msg.parts!} isStreaming={isStreaming} />
        </div>
      ) : (
        <div className={isStreaming ? 'opacity-90' : 'opacity-100'}>
          <TextPart text={msg.content} />
        </div>
      )}
    </div>
  )
}

