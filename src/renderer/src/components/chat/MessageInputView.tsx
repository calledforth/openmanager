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

const INPUT_RADIUS = 'rounded-md'

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
          'fixed z-[200] max-h-[min(280px,calc(100vh-24px))] overflow-y-auto border border-white/10 bg-[#1a1a1a] py-0.5 shadow-2xl shadow-black/50',
          INPUT_RADIUS,
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
                'flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-medium transition-colors',
                isSelected
                  ? 'bg-white/10 text-white'
                  : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200',
              )}
            >
              <span className="flex-1 truncate">{opt.name}</span>
              {isSelected && <Check className="h-2.5 w-2.5 shrink-0 text-orange-400" />}
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
                INPUT_RADIUS,
                'border border-transparent bg-transparent px-1.5 py-0.5 text-[10px] text-neutral-400',
                'hover:border-white/10 hover:bg-white/[0.06] hover:text-neutral-200',
                open && 'border-white/10 bg-white/[0.06] text-neutral-200',
              )
            : cn(
                'rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[10px] text-neutral-300',
                'hover:border-white/10 hover:bg-white/[0.07] hover:text-neutral-100',
                open && 'border-white/15 bg-white/[0.08]',
              ),
          disabled && 'cursor-default opacity-40',
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={10} className="shrink-0 text-neutral-500" />
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
        'relative flex shrink-0 items-center rounded border border-white/5 bg-black/50 p-px',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      <div
        className={cn(
          'absolute top-px bottom-px w-[38px] rounded-[2px] transition-all duration-300 ease-out',
          isPlan ? 'translate-x-[38px] bg-orange-500/20' : 'translate-x-0 bg-white/10',
        )}
      />
      <button
        type="button"
        onClick={onSelectBuild}
        className={cn(
          'relative z-10 w-[38px] rounded-[2px] py-0.5 text-[11px] font-medium transition-colors duration-300',
          !isPlan ? 'text-white' : 'text-neutral-500 hover:text-neutral-300',
        )}
      >
        Build
      </button>
      <button
        type="button"
        onClick={onSelectPlan}
        className={cn(
          'relative z-10 w-[38px] rounded-[2px] py-0.5 text-[11px] font-medium transition-colors duration-300',
          isPlan ? 'text-orange-400' : 'text-neutral-500 hover:text-neutral-300',
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
  const [focused, setFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const planOption = modeOptions.find((m) => m.id === 'plan')
  const nonPlanModes = modeOptions.filter((m) => m.id !== 'plan')
  const buildPlanToggle =
    planOption != null && nonPlanModes.length === 1 && modeOptions.length === 2
  const buildModeId = nonPlanModes[0]?.id ?? ''

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

  const isPlan = currentModeId === 'plan'
  const sendActive = hasContent && !disabled

  return (
    <div className="flex w-full flex-col shadow-2xl shadow-black/40">
      <div
        className={cn(
          'chat-composer-glass relative flex flex-col gap-1.5 border p-2 transition-all duration-200',
          INPUT_RADIUS,
          focused ? 'border-white/25' : 'border-white/10',
        )}
      >
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
          className="min-h-[36px] max-h-32 w-full resize-none overflow-y-auto bg-transparent p-1 text-[13px] font-normal leading-relaxed text-neutral-200 placeholder:text-neutral-600 focus:outline-none disabled:opacity-50 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-neutral-600/40 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent"
        />

        <div className="flex items-center justify-between gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-hide">
            <button
              type="button"
              className="flex shrink-0 items-center justify-center rounded border border-transparent p-1 text-neutral-400 transition-all hover:bg-white/10 hover:text-neutral-200"
            >
              <Plus size={12} />
            </button>

            <div className="mx-0.5 h-3.5 w-px shrink-0 bg-white/10" />

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
                <div className="mx-0.5 h-3.5 w-px shrink-0 bg-white/10" />
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
                  'ml-0.5 shrink-0 truncate rounded-full border border-white/10 bg-white/[0.06] px-1.5 py-px text-10-medium text-neutral-400',
                  isPlan && 'border-orange-500/25 text-orange-400',
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
              className="flex items-center justify-center rounded border border-transparent p-1 text-neutral-400 transition-all hover:bg-white/10 hover:text-neutral-200"
            >
              <Mic size={12} />
            </button>
            {isStreaming ? (
              <button
                type="button"
                onClick={onAbort}
                className="shrink-0 rounded bg-red-500/90 p-1 text-white transition-all hover:bg-red-500"
              >
                <Square className="h-3 w-3" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!sendActive}
                className={cn(
                  'ml-0.5 shrink-0 rounded p-1 transition-all',
                  sendActive
                    ? isPlan
                      ? 'bg-orange-500 text-white hover:bg-orange-400'
                      : 'bg-white text-black hover:bg-neutral-200'
                    : 'bg-white/10 text-neutral-500 hover:bg-white/20',
                )}
              >
                <ArrowUp size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
