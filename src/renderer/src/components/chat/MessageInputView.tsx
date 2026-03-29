import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react'
import { ArrowUp, Plus, ChevronDown, Mic, Check, Square } from 'lucide-react'
import { cn } from '../../lib/utils'

function MiniDropdown({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: string
  options: Array<{ id: string; name: string }>
  onChange: (id: string) => void
  disabled?: boolean
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, close])

  const current = options.find((o) => o.id === value)
  const displayName = current?.name ?? value?.split('/').pop() ?? label ?? '—'

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={cn(
          'flex items-center gap-1 rounded-full border border-border/50 px-2.5 py-1 text-[11px] font-medium transition-all duration-150',
          'text-muted-foreground hover:text-foreground hover:border-border',
          disabled && 'opacity-40 cursor-default',
        )}
      >
        <span className="truncate max-w-[140px]">{displayName}</span>
        <ChevronDown
          className={cn(
            'h-2.5 w-2.5 shrink-0 transition-transform duration-150',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 z-50 min-w-[180px] max-w-[260px] max-h-[220px] overflow-y-auto rounded-lg border border-border/80 bg-popover p-1 shadow-xl shadow-black/40 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/50 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full">
          {options.map((opt) => {
            const isSelected = opt.id === value
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  onChange(opt.id)
                  close()
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors duration-75',
                  isSelected
                    ? 'text-primary bg-primary/10'
                    : 'text-foreground/80 hover:bg-secondary hover:text-foreground',
                )}
              >
                <span className="flex-1 truncate">{opt.name}</span>
                {isSelected && <Check className="h-3 w-3 shrink-0 text-primary" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function MessageInputView({
  disabled,
  pendingDraftSessionStart,
  activeWorkspacePath,
  activeSessionId,
  isSessionDraftOpen,
  openCodeReady,
  modeOptions,
  currentModeId,
  modelOptions,
  currentModelId,
  canChangeSettings,
  agent,
  isStreaming,
  onModeChange,
  onModelChange,
  onSend,
  onAbort,
}: {
  disabled: boolean
  pendingDraftSessionStart: boolean
  activeWorkspacePath: string | null
  activeSessionId: string | null
  isSessionDraftOpen: boolean
  openCodeReady: boolean
  modeOptions: Array<{ id: string; name: string }>
  currentModeId: string
  modelOptions: Array<{ id: string; name: string }>
  currentModelId: string
  canChangeSettings: boolean
  agent?: { name?: string; version?: string } | null
  isStreaming: boolean
  onModeChange: (id: string) => void
  onModelChange: (id: string) => void
  onSend: (text: string) => void
  onAbort: () => void
}) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
    }
  }, [text])

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
        e.preventDefault()
        textareaRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const hasContent = text.trim().length > 0
  const placeholder = !activeWorkspacePath
    ? 'Select a workspace...'
    : pendingDraftSessionStart
      ? 'Starting session...'
      : !activeSessionId && isSessionDraftOpen
        ? 'Ask anything, @ to mention, / for workflows'
        : !activeSessionId
          ? 'Select a session...'
          : !openCodeReady
            ? 'Connecting to OpenCode...'
            : 'Ask anything, @ to mention, / for workflows'

  return (
    <div className="px-4 pb-4 pt-1 shrink-0">
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            'rounded-xl border bg-input-bg transition-all duration-200',
            focused
              ? 'border-[var(--color-input-border-focus)] shadow-lg shadow-black/30'
              : 'border-[var(--color-input-border)]',
          )}
        >
          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 leading-[1.5] text-foreground placeholder:text-muted-foreground/40 focus:outline-none disabled:opacity-50 overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/50 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full"
          />

          {/* Toolbar */}
          <div className="flex items-center justify-between px-2.5 pb-2.5 pt-1">
            {/* Left: actions + selectors */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-all duration-150 hover:bg-surface-hover hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>

              {modeOptions.length > 0 && (
                <MiniDropdown
                  value={currentModeId}
                  options={modeOptions}
                  onChange={onModeChange}
                  disabled={!canChangeSettings}
                  label="Mode"
                />
              )}

              {modelOptions.length > 0 && (
                <MiniDropdown
                  value={currentModelId}
                  options={modelOptions}
                  onChange={onModelChange}
                  disabled={!canChangeSettings}
                  label="Model"
                />
              )}

              {agent?.name && (
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-medium border',
                    currentModeId === 'plan'
                      ? 'bg-orange-500/15 border-orange-500/25 text-orange-400'
                      : 'bg-white/8 border-white/12 text-foreground/70',
                  )}
                >
                  {agent.name}
                  {agent.version ? ` ${agent.version}` : ''}
                </span>
              )}
            </div>

            {/* Right: mic + send/stop */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-all duration-150 hover:bg-surface-hover hover:text-foreground"
              >
                <Mic className="h-3.5 w-3.5" />
              </button>

              {isStreaming ? (
                <button
                  type="button"
                  onClick={onAbort}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-destructive text-white hover:brightness-110 transition-all duration-150"
                >
                  <Square className="h-3 w-3" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={send}
                  disabled={!hasContent || disabled}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full transition-all duration-150',
                    hasContent && !disabled
                      ? currentModeId === 'plan'
                        ? 'bg-orange-500 text-white hover:brightness-110 shadow-md shadow-orange-500/20'
                        : 'bg-foreground text-background hover:brightness-110 shadow-md shadow-black/20'
                      : 'bg-surface-hover text-muted-foreground/30',
                  )}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
