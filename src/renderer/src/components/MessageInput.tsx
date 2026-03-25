import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react'
import { ArrowUp, Plus, ChevronDown, Mic, Check } from 'lucide-react'
import { useAppUi } from '../providers/app-ui-provider'
import { useActiveSession } from '../providers/active-session-provider'
import { cn } from '../lib/utils'

/* ── Compact custom dropdown ───────────────────────────────────── */
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
          'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all duration-100',
          'text-foreground/90 bg-secondary/50 hover:text-foreground hover:bg-secondary/80 border border-border/40 shadow-sm',
          disabled && 'opacity-40 cursor-default',
        )}
      >
        <span className="truncate max-w-[140px]">{displayName}</span>
        <ChevronDown
          className={cn(
            'h-2.5 w-2.5 shrink-0 transition-transform duration-100',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 z-50 min-w-[180px] max-w-[260px] max-h-[220px] overflow-y-auto rounded-md border border-border/80 bg-popover p-1 shadow-md shadow-black/20 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/50 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full">
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
                  'flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors duration-75',
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

/* ── Main input ────────────────────────────────────────────────── */
export function MessageInput() {
  const {
    activeSessionId,
    activeWorkspacePath,
    isSessionDraftOpen,
    pendingDraftSessionStart,
    acpSessionState,
    draftSessionState,
    acpAgentInfo,
    setDraftModel,
    setDraftMode,
    setSessionModel,
    setSessionMode,
    openCodeUiStatus,
  } = useAppUi()
  const { sendMessage } = useActiveSession()
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const openCodeReady = openCodeUiStatus === 'connected'
  const disabled =
    !activeWorkspacePath || pendingDraftSessionStart || (!activeSessionId && !isSessionDraftOpen)

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

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    void sendMessage(trimmed)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const hasContent = text.trim().length > 0
  const runtimeState = activeSessionId || !isSessionDraftOpen ? acpSessionState : draftSessionState
  const modelOptions = runtimeState?.models?.availableModels ?? []
  const currentModelId = runtimeState?.models?.currentModelId ?? ''
  const modeOptions = runtimeState?.modes?.availableModes ?? []
  const currentModeId = runtimeState?.modes?.currentModeId ?? ''

  const canChangeSettings = !!activeSessionId || isSessionDraftOpen

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
    <div className="px-4 pb-3 pt-1 shrink-0">
      <div className="mx-auto max-w-2xl">
        <div
          className={cn(
            'rounded-md border transition-all duration-150 bg-card shadow-sm',
            focused
              ? currentModeId === 'plan'
                ? 'border-purple-500/50 ring-1 ring-purple-500/20'
                : 'border-primary/50 ring-1 ring-primary/20'
              : 'border-border/60',
          )}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className="w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1.5 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:outline-none disabled:opacity-50 overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/50 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full"
          />

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-1.5 pb-1.5">
            <div className="flex items-center gap-2">
              {/* Attach */}
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:bg-secondary hover:text-foreground"
              >
                <Plus className="h-4 w-4" />
              </button>

              {/* Mode dropdown */}
              {modeOptions.length > 0 && (
                <MiniDropdown
                  value={currentModeId}
                  options={modeOptions.map((m) => ({ id: m.id, name: m.name }))}
                  onChange={(id) =>
                    activeSessionId ? setSessionMode(activeSessionId, id) : setDraftMode(id)
                  }
                  disabled={!canChangeSettings}
                  label="Mode"
                />
              )}

              {/* Model dropdown */}
              {modelOptions.length > 0 && (
                <MiniDropdown
                  value={currentModelId}
                  options={modelOptions.map((m) => ({ id: m.modelId, name: m.name }))}
                  onChange={(id) =>
                    activeSessionId ? setSessionModel(activeSessionId, id) : setDraftModel(id)
                  }
                  disabled={!canChangeSettings}
                  label="Model"
                />
              )}

              {/* Agent badge */}
              {acpAgentInfo?.name && (
                <span className="rounded-md px-2 py-1 bg-secondary/40 border border-border/40 text-[11px] font-medium text-foreground/80 shadow-sm">
                  {acpAgentInfo.name}
                  {acpAgentInfo.version ? ` ${acpAgentInfo.version}` : ''}
                </span>
              )}
            </div>

            {/* Right actions */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:bg-secondary hover:text-foreground"
              >
                <Mic className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={handleSend}
                disabled={!hasContent || disabled}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-md transition-all duration-100 shadow-sm',
                  hasContent && !disabled
                    ? currentModeId === 'plan'
                      ? 'bg-purple-600 text-white hover:brightness-110'
                      : 'bg-primary text-primary-foreground hover:brightness-110'
                    : 'bg-muted text-muted-foreground/40',
                )}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
