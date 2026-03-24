import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react'
import { ArrowUp, Plus, ChevronDown, Mic, Check } from 'lucide-react'
import { useAppUi } from '../providers/app-ui-provider'
import { useActiveSession } from '../providers/active-session-provider'
import { useSidebarData } from '../providers/sidebar-data-provider'
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
          'flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-all duration-100',
          'text-muted-foreground hover:text-foreground hover:bg-surface-hover',
          disabled && 'opacity-40 cursor-default',
        )}
      >
        <span className="truncate max-w-[140px]">{displayName}</span>
        <ChevronDown className={cn('h-2.5 w-2.5 shrink-0 transition-transform duration-100', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 z-50 min-w-[180px] max-w-[260px] max-h-[200px] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg shadow-black/30">
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
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors duration-75',
                  isSelected
                    ? 'text-foreground bg-surface-active'
                    : 'text-foreground/70 hover:bg-surface-hover hover:text-foreground',
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
  } = useAppUi()
  const { sendMessage } = useActiveSession()
  const { workspaces } = useSidebarData()
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const activeWs = workspaces.find((w) => w.path === activeWorkspacePath)
  const sidecarReady = activeWs?.sidecarStatus === 'connected'
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
  const runtimeState =
    activeSessionId || !isSessionDraftOpen ? acpSessionState : draftSessionState
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
      : !sidecarReady
        ? 'Connecting to workspace...'
        : 'Ask anything, @ to mention, / for workflows'

  return (
    <div className="px-4 pb-3 pt-1 shrink-0">
      <div className="mx-auto max-w-2xl">
        <div
          className={cn(
            'rounded-xl border transition-all duration-150 bg-card',
            focused ? 'border-muted-foreground/30' : 'border-border',
          )}
        >
          {/* Textarea */}
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
            className="w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1.5 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:outline-none disabled:opacity-50"
          />

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-1.5 pb-1.5">
            <div className="flex items-center gap-0.5">
              {/* Attach */}
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>

              {/* Mode dropdown */}
              {modeOptions.length > 0 && (
                <MiniDropdown
                  value={currentModeId}
                  options={modeOptions.map((m) => ({ id: m.id, name: m.name }))}
                  onChange={(id) =>
                    activeSessionId
                      ? setSessionMode(activeSessionId, id)
                      : setDraftMode(id)
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
                    activeSessionId
                      ? setSessionModel(activeSessionId, id)
                      : setDraftModel(id)
                  }
                  disabled={!canChangeSettings}
                  label="Model"
                />
              )}

              {/* Agent badge */}
              {acpAgentInfo?.name && (
                <span className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground">
                  {acpAgentInfo.name}
                  {acpAgentInfo.version ? ` ${acpAgentInfo.version}` : ''}
                </span>
              )}
            </div>

            {/* Right actions */}
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/40 transition-colors duration-100 hover:bg-surface-hover hover:text-muted-foreground"
              >
                <Mic className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                onClick={handleSend}
                disabled={!hasContent || disabled}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-md transition-all duration-100',
                  hasContent && !disabled
                    ? 'bg-foreground text-background hover:opacity-90'
                    : 'bg-muted/50 text-muted-foreground/20',
                )}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
