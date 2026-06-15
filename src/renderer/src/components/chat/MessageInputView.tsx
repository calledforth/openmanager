import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, Plus, ChevronDown, Check, Square, Mic } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  chatInputShell,
  chatComposerTextarea,
  btnSend,
  COMPOSER_TEXTAREA_MAX_PX,
} from './chatComposerStyles'

type MenuCoords = { left: number; bottom: number; width: number }

/** Mode = small pill; model = ghost trigger. Menu is portaled — avoids overflow-x-auto / overflow-hidden clipping. */
function PillSelect({
  value,
  options,
  onChange,
  disabled,
  variant = 'filled',
}: {
  value: string
  options: Array<{ id: string; name: string }>
  onChange: (id: string) => void
  disabled?: boolean
  variant?: 'filled' | 'ghost'
}) {
  const [open, setOpen] = useState(false)
  const [menuCoords, setMenuCoords] = useState<MenuCoords | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])

  const updateMenuCoords = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const width = Math.max(208, rect.width)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    const gap = 6
    setMenuCoords({
      left,
      bottom: window.innerHeight - rect.top + gap,
      width,
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setMenuCoords(null)
      return
    }
    updateMenuCoords()
  }, [open, updateMenuCoords, value, options.length])

  useEffect(() => {
    if (!open) return
    const onResizeOrScroll = () => updateMenuCoords()
    window.addEventListener('resize', onResizeOrScroll)
    window.addEventListener('scroll', onResizeOrScroll, true)
    return () => {
      window.removeEventListener('resize', onResizeOrScroll)
      window.removeEventListener('scroll', onResizeOrScroll, true)
    }
  }, [open, updateMenuCoords])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      close()
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
  const label = current?.name ?? value?.split('/').pop() ?? '—'

  const ghost = variant === 'ghost'

  const menu =
    open &&
    menuCoords &&
    createPortal(
      <div
        ref={menuRef}
        className={cn(
          'fixed z-[200] max-h-[min(280px,calc(100vh-24px))] overflow-y-auto border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)] py-0.5 shadow-lg',
          'rounded-[var(--basis-chat-shell-radius)]',
        )}
        style={{
          left: menuCoords.left,
          bottom: menuCoords.bottom,
          width: menuCoords.width,
        }}
      >
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
                'flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-ui-xs font-medium transition-colors',
                isSelected
                  ? 'bg-[var(--basis-surface-hover)] text-[var(--basis-text-strong)]'
                  : 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
              )}
            >
              <span className="flex-1 truncate">{opt.name}</span>
              {isSelected && (
                <Check className="h-2.5 w-2.5 shrink-0 text-[var(--basis-text)]" />
              )}
            </button>
          )
        })}
      </div>,
      document.body,
    )

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className={cn(
          'flex max-w-[220px] items-center gap-1 font-medium transition-all duration-150',
          ghost
            ? cn(
                'rounded-[var(--basis-chat-shell-radius)] border border-transparent bg-transparent px-1.5 py-0.5 text-ui-2xs text-[var(--basis-text-muted)]',
                'hover:border-[var(--basis-border)] hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
                open && 'border-[var(--basis-border)] bg-[var(--basis-surface-hover)] text-[var(--basis-text)]',
              )
            : cn(
                'rounded-full border border-[var(--basis-border-muted)] bg-[var(--basis-surface-elevated)] px-2 py-1 text-ui-2xs text-[var(--basis-text)]',
                'hover:border-[var(--basis-border)] hover:bg-[var(--basis-surface-hover)]',
                open && 'border-[var(--basis-border)] bg-[var(--basis-surface-hover)]',
              ),
          disabled && 'cursor-default opacity-40',
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={10} className="shrink-0 text-[var(--basis-text-faint)]" />
      </button>
      {menu}
    </div>
  )
}

/** Reference: src/App.tsx Build/Plan Mode Switcher */
function BuildPlanToggle({
  isPlan,
  disabled,
  onSelectBuild,
  onSelectPlan,
}: {
  isPlan: boolean
  disabled?: boolean
  onSelectBuild: () => void
  onSelectPlan: () => void
}) {
  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border-muted)] bg-[var(--basis-surface)] p-0.5',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      <div
        className={cn(
          'absolute top-0.5 bottom-0.5 w-[46px] rounded-sm transition-all duration-300 ease-out',
          isPlan ? 'translate-x-[46px] theme-toggle-plan' : 'translate-x-0 theme-toggle-build',
        )}
      />
      <button
        type="button"
        onClick={onSelectBuild}
        className={cn(
          'relative z-10 w-[46px] rounded-sm py-1 text-[11px] font-medium transition-colors duration-300',
          !isPlan ? 'text-[var(--build-text)]' : 'text-[var(--basis-text-muted)] hover:text-[var(--basis-text)]',
        )}
      >
        Build
      </button>
      <button
        type="button"
        onClick={onSelectPlan}
        className={cn(
          'relative z-10 w-[46px] rounded-sm py-1 text-[11px] font-medium transition-colors duration-300',
          isPlan ? 'text-[var(--plan-text)]' : 'text-[var(--basis-text-muted)] hover:text-[var(--basis-text)]',
        )}
      >
        Plan
      </button>
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const planOption = modeOptions.find((m) => m.id === 'plan')
  const nonPlanModes = modeOptions.filter((m) => m.id !== 'plan')
  const buildPlanToggle =
    planOption != null && nonPlanModes.length === 1 && modeOptions.length === 2
  const buildModeId = nonPlanModes[0]?.id ?? ''

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, COMPOSER_TEXTAREA_MAX_PX)}px`
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

  const isPlan = currentModeId === 'plan'
  const sendActive = hasContent && !disabled

  return (
    <div className="flex w-full flex-col">
      <div className={cn(chatInputShell, 'gap-1 p-1')}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className={cn(chatComposerTextarea, 'max-h-[156px] overflow-y-auto')}
        />

        <div className="flex items-center justify-between gap-1.5 px-1 pb-0.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-hide">
            <button
              type="button"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]"
            >
              <Plus size={12} />
            </button>

            <div className="mx-0.5 h-3.5 w-px shrink-0 bg-[var(--basis-border-muted)]" />

            {buildPlanToggle ? (
              <BuildPlanToggle
                isPlan={isPlan}
                disabled={!canChangeSettings}
                onSelectBuild={() => onModeChange(buildModeId)}
                onSelectPlan={() => onModeChange('plan')}
              />
            ) : (
              modeOptions.length > 0 && (
                <PillSelect
                  value={currentModeId}
                  options={modeOptions}
                  onChange={onModeChange}
                  disabled={!canChangeSettings}
                />
              )
            )}

            {modelOptions.length > 0 && (
              <>
                <div className="mx-0.5 h-3.5 w-px shrink-0 bg-[var(--basis-border-muted)]" />
                <PillSelect
                  variant="ghost"
                  value={currentModelId}
                  options={modelOptions}
                  onChange={onModelChange}
                  disabled={!canChangeSettings}
                />
              </>
            )}

            {agent?.name && (
              <span
                className={cn(
                  'ml-0.5 shrink-0 truncate rounded-full border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)] px-1.5 py-px text-ui-2xs text-[var(--basis-text-muted)]',
                  isPlan && 'border-dashed text-[var(--basis-text)]',
                )}
              >
                {agent.name}
                {agent.version ? ` ${agent.version}` : ''}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]"
            >
              <Mic size={12} />
            </button>
            {isStreaming ? (
              <button
                type="button"
                onClick={onAbort}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-500/90 text-white transition-colors hover:bg-red-500"
              >
                <Square className="h-3 w-3" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!sendActive}
                className={cn(
                  btnSend,
                  sendActive && isPlan && 'theme-btn-plan !rounded-full !h-6 !w-6 !p-0',
                  !sendActive && '!bg-[var(--basis-surface-hover)] !text-[var(--basis-text-faint)]',
                )}
              >
                <ArrowUp size={14} strokeWidth={1.9} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
