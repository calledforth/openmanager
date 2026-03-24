import { useState, useRef, useEffect, type KeyboardEvent } from 'react'
import { ArrowUp } from 'lucide-react'
import { useAppUi } from '../providers/app-ui-provider'
import { useActiveSession } from '../providers/active-session-provider'
import { useSidebarData } from '../providers/sidebar-data-provider'
import { cn } from '../lib/utils'

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
  const commandCount = runtimeState?.availableCommands?.length ?? 0

  const placeholder = !activeWorkspacePath
    ? 'Select a workspace...'
    : pendingDraftSessionStart
      ? 'Starting session...'
      : !activeSessionId && isSessionDraftOpen
        ? 'What do you want to build?'
        : !activeSessionId
      ? 'Select a session...'
      : !sidecarReady
        ? 'Connecting to workspace...'
        : 'What do you want to build?'

  return (
    <div className="px-4 pb-3 pt-1 shrink-0">
      <div className="mx-auto max-w-2xl">
        {(modelOptions.length > 0 || modeOptions.length > 0 || acpAgentInfo?.name || commandCount > 0) && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {acpAgentInfo?.name && (
              <span className="rounded border border-border px-2 py-0.5">
                {acpAgentInfo.name}
                {acpAgentInfo.version ? ` ${acpAgentInfo.version}` : ''}
              </span>
            )}

            {modelOptions.length > 0 && (
              <label className="flex items-center gap-1 rounded border border-border px-2 py-0.5">
                <span>Model</span>
                <select
                  className="bg-transparent text-foreground outline-none"
                  value={currentModelId}
                  onChange={(e) =>
                    activeSessionId
                      ? setSessionModel(activeSessionId, e.target.value)
                      : setDraftModel(e.target.value)
                  }
                  disabled={!activeSessionId && !isSessionDraftOpen}
                >
                  {modelOptions.map((model) => (
                    <option key={model.modelId} value={model.modelId} className="bg-background text-foreground">
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {modeOptions.length > 0 && (
              <label className="flex items-center gap-1 rounded border border-border px-2 py-0.5">
                <span>Mode</span>
                <select
                  className="bg-transparent text-foreground outline-none"
                  value={currentModeId}
                  onChange={(e) =>
                    activeSessionId
                      ? setSessionMode(activeSessionId, e.target.value)
                      : setDraftMode(e.target.value)
                  }
                  disabled={!activeSessionId && !isSessionDraftOpen}
                >
                  {modeOptions.map((mode) => (
                    <option key={mode.id} value={mode.id} className="bg-background text-foreground">
                      {mode.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {commandCount > 0 && (
              <span className="rounded border border-border px-2 py-0.5">
                Commands {commandCount}
              </span>
            )}
          </div>
        )}

        <div
          className={cn(
            'flex items-end gap-2 rounded-lg border bg-card transition-all duration-150',
            focused ? 'border-muted-foreground/30' : 'border-border',
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
            className="flex-1 resize-none bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:outline-none disabled:opacity-50"
          />

          <button
            type="button"
            onClick={handleSend}
            disabled={!hasContent || disabled}
            className={cn(
              'm-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-all duration-150',
              hasContent && !disabled
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground/30',
            )}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
