import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUpIcon,
  PlusIcon,
  CaretDownIcon,
  SquareIcon,
  XIcon,
  CircleNotchIcon,
  FadersHorizontalIcon,
} from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import type { ProviderId, SessionConfigOption } from '@agentpack/contract'
import { SearchableMenu, type SearchableMenuSection } from '../ui/SearchableMenu'
import { Tooltip } from '../ui/Tooltip'
import { usePortaledMenu } from '../ui/usePortaledMenu'
import {
  chatInputShell,
  chatComposerTextarea,
  btnSend,
  COMPOSER_TEXTAREA_MAX_PX,
} from './chatComposerStyles'
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  type DraftImageAttachment,
} from '../../lib/attachments'
import {
  configurableSessionOptions,
  isBooleanSelect,
  sessionConfigSummary,
  type SessionConfigValue,
} from './modelConfig'
import { ContextMeter, type ComposerUsage } from './ContextMeter'
import { SlashCommandPopup } from './SlashCommandPopup'
import {
  applySlashCommand,
  matchSlashCommands,
  slashQueryFromText,
  type SlashCommandItem,
} from './slashCommands'
import { ProviderModelPicker, type ProviderModelGroup } from './ProviderModelPicker'

export type { ProviderModelGroup }

/** Matches the `prefers-reduced-motion` guard globals.css applies to chat animations. */
function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** Mode / misc select. Menu is portaled — avoids overflow-x-auto / overflow-hidden clipping. */
function PillSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  variant = 'filled',
  describeOnHover,
}: {
  value: T
  options: Array<{ id: T; name: string; description?: string }>
  onChange: (id: T) => void
  disabled?: boolean
  variant?: 'filled' | 'ghost'
  /** Show each option's description on hover instead of as a second line.
   * Keeps a six-row mode menu compact — the descriptions exist to disambiguate
   * "dontAsk" from "auto", not to be read every time the menu opens. */
  describeOnHover?: boolean
}) {
  const current = options.find((o) => o.id === value)
  const label = current?.name ?? value?.split('/').pop() ?? '—'
  const ghost = variant === 'ghost'
  const sections = useMemo<SearchableMenuSection[]>(
    () => [
      {
        id: 'options',
        options: options.map((option) => ({
          id: option.id,
          label: option.name,
          ...(option.description
            ? describeOnHover
              ? { title: option.description }
              : { description: option.description }
            : {}),
        })),
      },
    ],
    [describeOnHover, options],
  )

  return (
    <SearchableMenu
      sections={sections}
      value={value}
      onSelect={(optionId) => onChange(optionId as T)}
      searchable={options.length > 6}
      searchPlaceholder="Search…"
      emptyText="No options"
      disabled={disabled}
      minWidth={ghost ? 140 : 180}
      maxHeight={280}
      aria-label="Select option"
      trigger={({ ref, open, toggle, disabled: isDisabled }) => (
        <button
          ref={ref}
          type="button"
          onClick={toggle}
          disabled={isDisabled}
          className={cn(
            'flex max-w-[220px] items-center font-medium transition-colors duration-150',
            ghost
              ? cn(
                  'gap-0.5 border-0 bg-transparent px-0.5 py-0 text-11-regular leading-none text-[var(--basis-text)]',
                  'hover:text-[var(--basis-text-strong)]',
                  open && 'text-[var(--basis-text-strong)]',
                )
              : cn(
                  'gap-1 rounded-full border border-[var(--basis-border-muted)] bg-[var(--basis-surface)] px-2 py-1 text-11-regular text-[var(--basis-text)]',
                  'hover:border-[var(--basis-border)] hover:bg-[var(--basis-surface-hover)]',
                  open && 'border-[var(--basis-border)] bg-[var(--basis-surface-hover)]',
                ),
            isDisabled && 'cursor-default opacity-40',
          )}
        >
          <span className="truncate">{label}</span>
          <CaretDownIcon
            size={ghost ? 9 : 10}
            weight="light"
            className="shrink-0 text-[var(--basis-text-faint)]"
          />
        </button>
      )}
    />
  )
}

function ModelConfigMenu({
  options,
  onChange,
  disabled,
}: {
  options: SessionConfigOption[]
  onChange: (configId: string, value: SessionConfigValue) => void
  disabled?: boolean
}) {
  const configurable = configurableSessionOptions(options)
  const { open, toggle, menuCoords, wrapRef, triggerRef, menuRef } = usePortaledMenu({
    placement: 'above',
    minWidth: 280,
    align: 'start',
    deps: [configurable.length],
  })

  if (configurable.length === 0) return null

  return (
    <div ref={wrapRef} className="flex shrink-0">
      <Tooltip content="Edit model settings">
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-label="Edit model settings"
          aria-expanded={open}
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded text-[var(--basis-text-faint)] transition-colors',
            'hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
            open && 'bg-[var(--basis-surface-hover)] text-[var(--basis-text)]',
            disabled && 'cursor-default opacity-40',
          )}
        >
          <FadersHorizontalIcon size={12} weight="regular" />
        </button>
      </Tooltip>
      {open &&
        menuCoords &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[9999] overflow-hidden rounded-xl border border-[var(--basis-border)] bg-[var(--basis-menu-bg,var(--basis-surface))] shadow-[0_12px_34px_rgba(0,0,0,0.18)]"
            style={{
              left: menuCoords.left,
              top: menuCoords.top,
              bottom: menuCoords.bottom,
              width: menuCoords.width,
            }}
            role="dialog"
            aria-label="Model settings"
          >
            <div className="border-b border-[var(--basis-border-muted)] px-3 py-2">
              <div className="text-11-medium text-[var(--basis-text-strong)]">Model settings</div>
              <div className="mt-0.5 text-[10px] leading-4 text-[var(--basis-text-muted)]">
                Applied to prompts in this workspace
              </div>
            </div>
            <div className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto p-1.5">
              {configurable.map((option) => {
                const booleanLike = option.type === 'boolean' || isBooleanSelect(option)
                const checked =
                  option.type === 'boolean'
                    ? option.currentValue
                    : option.currentValue.toLowerCase() === 'true'
                return (
                  <div
                    key={option.id}
                    className="flex min-h-10 items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--basis-surface-hover)]"
                  >
                    <span className="min-w-0">
                      <span className="block text-11-medium text-[var(--basis-text)]">
                        {option.name}
                      </span>
                      {option.description && (
                        <span className="mt-0.5 block text-[10px] leading-3.5 text-[var(--basis-text-muted)]">
                          {option.description}
                        </span>
                      )}
                    </span>
                    {booleanLike ? (
                      <button
                        type="button"
                        role="switch"
                        aria-label={option.name}
                        aria-checked={checked}
                        onClick={() => {
                          if (option.type === 'boolean') {
                            onChange(option.id, !option.currentValue)
                            return
                          }
                          const nextValue = option.options.find(
                            (entry) => entry.value.toLowerCase() === String(!checked),
                          )?.value
                          if (nextValue !== undefined) onChange(option.id, nextValue)
                        }}
                        className={cn(
                          'relative h-[18px] w-8 shrink-0 rounded-full border transition-colors',
                          checked
                            ? 'border-[var(--basis-action-bg)] bg-[var(--basis-action-bg)]'
                            : 'border-[var(--basis-border)] bg-[var(--basis-surface)]',
                        )}
                      >
                        <span
                          className={cn(
                            'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform',
                            checked ? 'translate-x-[15px]' : 'translate-x-0.5',
                          )}
                        />
                      </button>
                    ) : (
                      <select
                        value={option.currentValue}
                        onChange={(event) => onChange(option.id, event.target.value)}
                        className="h-7 max-w-[132px] shrink-0 rounded-md border border-[var(--basis-border)] bg-[var(--basis-surface)] px-2 text-11-regular text-[var(--basis-text)] outline-none hover:bg-[var(--basis-surface-hover)] focus:border-[var(--basis-action-bg)]"
                        aria-label={option.name}
                      >
                        {option.options.map((entry) => (
                          <option key={entry.value} value={entry.value}>
                            {entry.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )
              })}
            </div>
          </div>,
          document.body,
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
  providerReady,
  currentProviderId,
  providerModelGroups,
  currentModelId,
  configOptions,
  modeOptions,
  currentModeId,
  effortLevels,
  currentEffort,
  canChangeSettings,
  canChangeProvider,
  showModeControl,
  showModelControl,
  isStreaming,
  isAwaitingPlanReview = false,
  attachedTop = false,
  draftKey,
  imageUploadEnabled,
  imageSupportMessage,
  slashCommands = [],
  usage = null,
  onModeChange,
  onProviderModelChange,
  onConfigOptionChange,
  onSend,
  onAbort,
}: {
  disabled: boolean
  pendingDraftSessionStart: boolean
  activeWorkspacePath: string | null
  activeSessionId: string | null
  isSessionDraftOpen: boolean
  providerReady: boolean
  currentProviderId: ProviderId
  providerModelGroups: ProviderModelGroup[]
  currentModelId: string
  configOptions: SessionConfigOption[]
  modeOptions: Array<{ id: string; name: string; description?: string }>
  /** Reasoning-effort levels the selected model accepts, cheapest first. Empty
   * hides the pill entirely — a model with no effort control must not show
   * one, and which levels exist is per-model, not per-provider. */
  effortLevels: string[]
  currentEffort: string
  currentModeId: string
  canChangeSettings: boolean
  canChangeProvider: boolean
  showModeControl: boolean
  showModelControl: boolean
  isStreaming: boolean
  isAwaitingPlanReview?: boolean
  /** Flatten top radius/border so an attached strip (todos) can sit flush above. */
  attachedTop?: boolean
  draftKey: string
  imageUploadEnabled: boolean
  imageSupportMessage: string | null
  slashCommands?: SlashCommandItem[]
  usage?: ComposerUsage | null
  onModeChange: (id: string) => void
  onProviderModelChange: (providerId: ProviderId, modelId: string) => void
  onConfigOptionChange: (configId: string, value: SessionConfigValue) => void
  onSend: (text: string, attachments: DraftImageAttachment[]) => Promise<void>
  onAbort: () => void
}) {
  const [drafts, setDrafts] = useState<
    Record<string, { text: string; attachments: DraftImageAttachment[] }>
  >({})
  const [sending, setSending] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lastHeightRef = useRef<number | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const draftsRef = useRef(drafts)
  const draft = drafts[draftKey] ?? { text: '', attachments: [] }
  const text = draft.text
  const attachments = draft.attachments

  useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])

  useEffect(
    () => () => {
      for (const item of Object.values(draftsRef.current)) {
        for (const attachment of item.attachments) URL.revokeObjectURL(attachment.previewUrl)
      }
    },
    [],
  )

  const updateDraft = useCallback(
    (
      update: (current: { text: string; attachments: DraftImageAttachment[] }) => {
        text: string
        attachments: DraftImageAttachment[]
      },
    ) => {
      setDrafts((current) => {
        const active = current[draftKey] ?? { text: '', attachments: [] }
        return { ...current, [draftKey]: update(active) }
      })
    },
    [draftKey],
  )

  const slashQuery = useMemo(() => slashQueryFromText(text), [text])

  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : matchSlashCommands(slashCommands, slashQuery)),
    [slashCommands, slashQuery],
  )

  const slashOpen = slashQuery !== null && !slashDismissed && slashMatches.length > 0 && !disabled

  useEffect(() => {
    setSlashActiveIndex(0)
  }, [slashQuery])

  // Leaving slash context re-arms the picker for the next `/`.
  useEffect(() => {
    if (slashQuery === null) setSlashDismissed(false)
  }, [slashQuery])

  const acceptSlashCommand = useCallback(
    (command: SlashCommandItem) => {
      updateDraft((current) => ({ ...current, text: applySlashCommand(command) }))
      setSlashDismissed(false)
      textareaRef.current?.focus()
    },
    [updateDraft],
  )

  const planOption = modeOptions.find((m) => m.id === 'plan')
  const nonPlanModes = modeOptions.filter((m) => m.id !== 'plan')
  const buildPlanToggle =
    planOption != null && nonPlanModes.length === 1 && modeOptions.length === 2
  const buildModeId = nonPlanModes[0]?.id ?? ''

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const previous = lastHeightRef.current
    // Measuring needs `auto`, which is not animatable — so the transition is
    // always off while measuring and re-armed only for the case worth easing.
    el.style.transition = 'none'
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, COMPOSER_TEXTAREA_MAX_PX)
    // Growing must land instantly: a box lagging behind the caret while you
    // type reads worse than a hard jump. Only the collapse back to one line —
    // what a send does — gets eased, and only there do we pay for the reflow.
    if (previous !== null && next < previous && !prefersReducedMotion()) {
      el.style.height = `${previous}px`
      void el.offsetHeight
      el.style.transition = 'height 120ms ease-out'
    }
    el.style.height = `${next}px`
    lastHeightRef.current = next
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

  const addFiles = useCallback(
    (files: File[]) => {
      if (!imageUploadEnabled) {
        setAttachmentError(imageSupportMessage ?? 'Image uploads are unavailable.')
        return
      }
      let error: string | null = null
      updateDraft((current) => {
        const next = [...current.attachments]
        for (const file of files) {
          if (next.length >= MAX_IMAGE_ATTACHMENTS) {
            error = `You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`
            break
          }
          if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
            error = `${file.name} is not a PNG, JPEG, or WebP image.`
            continue
          }
          if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
            error = `${file.name} must be smaller than 10 MB.`
            continue
          }
          next.push({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) })
        }
        return { ...current, attachments: next }
      })
      setAttachmentError(error)
    },
    [imageSupportMessage, imageUploadEnabled, updateDraft],
  )

  const removeAttachment = (id: string) => {
    updateDraft((current) => {
      const removed = current.attachments.find((attachment) => attachment.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return {
        ...current,
        attachments: current.attachments.filter((attachment) => attachment.id !== id),
      }
    })
    setAttachmentError(null)
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith('image/'),
    )
    if (!files.length) return
    event.preventDefault()
    addFiles(files)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    addFiles(Array.from(event.dataTransfer.files))
  }

  const send = async () => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || disabled || sending) return
    if (isAwaitingPlanReview && attachments.length > 0) {
      setAttachmentError('Remove image attachments before requesting plan changes.')
      return
    }
    if (attachments.length && !imageUploadEnabled) {
      setAttachmentError(imageSupportMessage ?? 'The selected model cannot read images.')
      return
    }
    setSending(true)
    setAttachmentError(null)
    // Clear before awaiting, not after. The transcript pushes its optimistic
    // bubble synchronously, so holding the text here until the round trip
    // settles leaves the same message on screen twice — worst on a fresh
    // session, where the send waits on a provider handshake before the job is
    // even submitted. Restored verbatim if the send fails, so nothing is lost.
    const restore = draft
    setDrafts((current) => {
      const next = { ...current }
      delete next[draftKey]
      return next
    })
    try {
      await onSend(trimmed, attachments)
    } catch (error) {
      setDrafts((current) => {
        // The composer stays live during an in-flight send, so anything typed
        // since must survive the rollback: the failed text goes back in front
        // of it rather than over it. Normally the box is still empty and this
        // restores the message verbatim.
        const active = current[draftKey]
        if (!active) return { ...current, [draftKey]: restore }
        return {
          ...current,
          [draftKey]: {
            text: active.text ? `${restore.text}\n${active.text}` : restore.text,
            attachments: [...restore.attachments, ...active.attachments],
          },
        }
      })
      setAttachmentError(error instanceof Error ? error.message : 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // Must run before Enter-to-send, otherwise accepting a completion would
    // instead submit the half-typed `/name` as a literal prompt.
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashActiveIndex((index) => (index + 1) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashActiveIndex((index) => (index - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const command = slashMatches[slashActiveIndex]
        if (command) {
          e.preventDefault()
          acceptSlashCommand(command)
          return
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const currentProviderName =
    providerModelGroups.find((group) => group.providerId === currentProviderId)?.providerName ??
    currentProviderId
  const hasContent = text.trim().length > 0 || attachments.length > 0
  const placeholder = !activeWorkspacePath
    ? 'Select a workspace...'
    : pendingDraftSessionStart
      ? 'Starting session...'
      : !activeSessionId && isSessionDraftOpen
        ? 'Ask anything, @ to mention, / for workflows'
        : !activeSessionId
          ? 'Select a session...'
          : !providerReady
            ? `Connecting to ${currentProviderName}...`
            : isAwaitingPlanReview
              ? 'Describe what should change in the plan…'
              : 'Ask anything, @ to mention, / for workflows'

  const isPlan = currentModeId === 'plan'
  const sendActive =
    (isAwaitingPlanReview ? text.trim().length > 0 && attachments.length === 0 : hasContent) &&
    !disabled &&
    !sending &&
    (attachments.length === 0 || imageUploadEnabled)
  const configSummary = sessionConfigSummary(configOptions)

  return (
    <div className="flex w-full flex-col">
      {slashOpen && (
        <SlashCommandPopup
          anchorRef={shellRef}
          commands={slashMatches}
          activeIndex={slashActiveIndex}
          onActiveIndexChange={setSlashActiveIndex}
          onSelect={acceptSlashCommand}
          onDismiss={() => setSlashDismissed(true)}
        />
      )}
      <div
        ref={shellRef}
        className={cn(
          chatInputShell,
          'gap-1 p-1 transition-[border-color,box-shadow]',
          attachedTop && 'rounded-t-none',
          isDragging && 'border-[var(--basis-action-bg)]',
        )}
        onDragEnter={(event) => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setIsDragging(false)
        }}
        onDrop={onDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(',')}
          multiple
          className="hidden"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
        {attachments.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-2 pt-1.5 pb-0.5 scrollbar-hide">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-[var(--basis-border)] bg-[var(--basis-surface)] shadow-sm"
              >
                <img
                  src={attachment.previewUrl}
                  alt={attachment.file.name}
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.id)}
                  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white opacity-90 shadow-sm transition hover:bg-black group-hover:opacity-100"
                  aria-label={`Remove ${attachment.file.name}`}
                >
                  <XIcon size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => updateDraft((current) => ({ ...current, text: e.target.value }))}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className={cn(chatComposerTextarea, 'max-h-[156px] overflow-y-auto')}
        />

        {(attachmentError || (attachments.length > 0 && imageSupportMessage)) && (
          <div className="px-2 pb-1 text-[11px] leading-4 text-amber-500" role="alert">
            {attachmentError ?? imageSupportMessage}
          </div>
        )}

        <div className="flex items-center justify-between gap-1.5 px-1 pb-0.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-hide">
            <Tooltip
              content={
                isAwaitingPlanReview
                  ? 'Plan revision feedback currently supports text only'
                  : (imageSupportMessage ?? 'Attach images')
              }
            >
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || !imageUploadEnabled || sending || isAwaitingPlanReview}
                aria-label="Attach images"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)] disabled:cursor-not-allowed disabled:opacity-35"
              >
                <PlusIcon size={12} />
              </button>
            </Tooltip>

            <div className="mx-0.5 h-3.5 w-px shrink-0 bg-[var(--basis-border-muted)]" />

            {showModelControl && (
              <ProviderModelPicker
                groups={providerModelGroups}
                currentProviderId={currentProviderId}
                currentModelId={currentModelId}
                onChange={onProviderModelChange}
                disabled={!canChangeSettings}
                canChangeProvider={canChangeProvider}
                configSummary={configSummary}
              />
            )}

            <ModelConfigMenu
              options={configOptions}
              onChange={onConfigOptionChange}
              disabled={!canChangeSettings}
            />

            {showModeControl && buildPlanToggle ? (
              <PillSelect
                variant="ghost"
                value={isPlan ? 'plan' : buildModeId}
                options={[
                  { id: buildModeId, name: 'Build' },
                  { id: 'plan', name: 'Plan' },
                ]}
                onChange={onModeChange}
                disabled={!canChangeSettings}
              />
            ) : (
              showModeControl &&
              modeOptions.length > 0 && (
                <PillSelect
                  variant="ghost"
                  value={currentModeId}
                  options={modeOptions}
                  onChange={onModeChange}
                  disabled={!canChangeSettings}
                  describeOnHover
                />
              )
            )}

            {effortLevels.length > 0 && (
              <PillSelect
                variant="ghost"
                // Blank until the session says otherwise: the CLI picks its own
                // depth when nothing asked, and inventing "high" here would
                // claim a setting we never sent.
                value={currentEffort}
                options={[
                  { id: '', name: 'Auto effort', description: 'Let Claude choose the depth.' },
                  ...effortLevels.map((level) => ({ id: level, name: level })),
                ]}
                onChange={(level) => onConfigOptionChange('effort', level)}
                disabled={!canChangeSettings}
                describeOnHover
              />
            )}

            {usage && (
              <>
                <div className="mx-0.5 h-3.5 w-px shrink-0 bg-[var(--basis-border-muted)]" />
                <ContextMeter usage={usage} />
              </>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {isAwaitingPlanReview ? (
              <>
                <Tooltip content="Cancel planning">
                  <button
                    type="button"
                    onClick={onAbort}
                    aria-label="Cancel planning"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--basis-text-faint)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                  >
                    <SquareIcon className="h-2.5 w-2.5" weight="fill" />
                  </button>
                </Tooltip>
                <Tooltip content="Request plan changes">
                  <button
                    type="button"
                    onClick={send}
                    disabled={!sendActive}
                    aria-label="Request plan changes"
                    className={cn(
                      btnSend,
                      sendActive && 'theme-btn-plan !h-6 !w-6 !rounded-full !p-0',
                      !sendActive &&
                        '!bg-[var(--basis-surface-hover)] !text-[var(--basis-text-faint)]',
                    )}
                  >
                    {sending ? (
                      <CircleNotchIcon size={13} className="animate-spin" />
                    ) : (
                      <ArrowUpIcon size={14} />
                    )}
                  </button>
                </Tooltip>
              </>
            ) : isStreaming ? (
              <Tooltip content="Stop" shortcut="Esc">
                <button
                  type="button"
                  onClick={onAbort}
                  aria-label="Stop"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--basis-surface-hover)] text-[var(--basis-text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                >
                  <SquareIcon className="h-2.5 w-2.5" weight="fill" />
                </button>
              </Tooltip>
            ) : (
              <Tooltip
                content={sendActive ? (isPlan ? 'Start planning' : 'Send') : undefined}
                shortcut="⏎"
              >
                <button
                  type="button"
                  onClick={send}
                  disabled={!sendActive}
                  aria-label={isPlan ? 'Start planning' : 'Send'}
                  className={cn(
                    btnSend,
                    sendActive && isPlan && 'theme-btn-plan !rounded-full !h-6 !w-6 !p-0',
                    !sendActive &&
                      '!bg-[var(--basis-surface-hover)] !text-[var(--basis-text-faint)]',
                  )}
                >
                  {sending ? (
                    <CircleNotchIcon size={13} className="animate-spin" />
                  ) : (
                    <ArrowUpIcon size={14} />
                  )}
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
