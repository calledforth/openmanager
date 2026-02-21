import { useState, useRef, type KeyboardEvent } from 'react'
import { useSessionStore } from '../stores/session-store'
import { cn } from '../lib/utils'

export function MessageInput() {
  const { activeSessionId, activeWorkspacePath, workspaces, sendMessage } = useSessionStore()
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const activeWs = workspaces.find((w) => w.path === activeWorkspacePath)
  const sidecarReady = activeWs?.sidecarStatus === 'connected'
  const disabled = !activeSessionId || !activeWorkspacePath

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    sendMessage(trimmed)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  const placeholder = !activeWorkspacePath
    ? 'Select a workspace...'
    : !activeSessionId
      ? 'Select a session...'
      : !sidecarReady
        ? 'Connecting to workspace...'
        : 'Send a message...'

  return (
    <div className="px-5 py-3.5 border-t border-border flex-shrink-0">
      <div className="flex gap-2 items-end bg-input-background border border-border rounded-lg px-3 py-1">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            handleInput()
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="flex-1 bg-transparent border-none text-foreground py-2 text-sm resize-none outline-none leading-relaxed max-h-40 placeholder:text-muted-foreground disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          className={cn(
            'rounded-md py-1.5 px-3.5 text-[13px] font-medium flex-shrink-0 mb-0.5 transition-colors',
            disabled || !text.trim()
              ? 'bg-muted text-muted-foreground cursor-not-allowed'
              : 'bg-indigo-500 text-white cursor-pointer hover:bg-indigo-600'
          )}
        >
          Send
        </button>
      </div>
    </div>
  )
}
