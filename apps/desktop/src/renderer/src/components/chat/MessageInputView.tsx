import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
} from 'react'
import {
  ArrowUpIcon,
  PlusIcon,
  CaretDownIcon,
  SquareIcon,
  MicrophoneIcon,
  XIcon,
  CircleNotchIcon,
} from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import type { ProviderId } from '@agentpack/contract'
import { ProviderIcon } from '../providers/ProviderIcon'
import { SearchableMenu, type SearchableMenuSection } from '../ui/SearchableMenu'
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

export type ProviderModelGroup = {
  providerId: ProviderId
  providerName: string
  models: Array<{ id: string; name: string }>
}

/** Mode / misc select. Menu is portaled — avoids overflow-x-auto / overflow-hidden clipping. */
function PillSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  variant = 'filled',
}: {
  value: T
  options: Array<{ id: T; name: string }>
  onChange: (id: T) => void
  disabled?: boolean
  variant?: 'filled' | 'ghost'
}) {
  const current = options.find((o) => o.id === value)
  const label = current?.name ?? value?.split('/').pop() ?? '—'
  const ghost = variant === 'ghost'
  const sections = useMemo<SearchableMenuSection[]>(
    () => [
      {
        id: 'options',
        options: options.map((option) => ({ id: option.id, label: option.name })),
      },
    ],
    [options],
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

/** Single control: provider groups → models. Trigger shows provider SVG + model name. */
function ProviderModelSelect({
  groups,
  currentProviderId,
  currentModelId,
  onChange,
  disabled,
  canChangeProvider,
}: {
  groups: ProviderModelGroup[]
  currentProviderId: ProviderId
  currentModelId: string
  onChange: (providerId: ProviderId, modelId: string) => void
  disabled?: boolean
  canChangeProvider: boolean
}) {
  const visibleGroups = canChangeProvider
    ? groups.filter((group) => group.models.length > 0)
    : groups.filter((group) => group.providerId === currentProviderId && group.models.length > 0)

  const currentGroup = groups.find((group) => group.providerId === currentProviderId)
  const currentModel =
    currentGroup?.models.find((model) => model.id === currentModelId) ??
    currentGroup?.models[0]
  const modelLabel = currentModel?.name ?? currentModelId.split('/').pop() ?? 'Model'
  const selectedId = `${currentProviderId}:${currentModelId}`

  const sections = useMemo<SearchableMenuSection[]>(
    () =>
      visibleGroups.map((group) => ({
        id: group.providerId,
        label: group.providerName,
        icon: <ProviderIcon providerId={group.providerId} className="h-3 w-3" />,
        options: group.models.map((model) => ({
          id: `${group.providerId}:${model.id}`,
          label: model.name,
          keywords: `${group.providerName} ${model.id}`,
        })),
      })),
    [visibleGroups],
  )

  return (
    <SearchableMenu
      sections={sections}
      value={selectedId}
      onSelect={(optionId, sectionId) => {
        const modelId = optionId.slice(sectionId.length + 1)
        onChange(sectionId as ProviderId, modelId)
      }}
      searchable
      searchPlaceholder="Search models…"
      emptyText="No models"
      disabled={disabled}
      minWidth={260}
      maxHeight={320}
      aria-label="Select model"
      trigger={({ ref, open, toggle, disabled: isDisabled }) => (
        <button
          ref={ref}
          type="button"
          onClick={toggle}
          disabled={isDisabled}
          className={cn(
            'flex max-w-[240px] items-center gap-1.5 border-0 bg-transparent px-0.5 py-0 text-11-regular leading-none text-[var(--basis-text)] transition-colors duration-150',
            'hover:text-[var(--basis-text-strong)]',
            open && 'text-[var(--basis-text-strong)]',
            isDisabled && 'cursor-default opacity-40',
          )}
        >
          <ProviderIcon providerId={currentProviderId} />
          <span className="truncate">{modelLabel}</span>
          <CaretDownIcon
            size={9}
            weight="light"
            className="shrink-0 text-[var(--basis-text-faint)]"
          />
        </button>
      )}
    />
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
  modeOptions,
  currentModeId,
  canChangeSettings,
  canChangeProvider,
  showModeControl,
  showModelControl,
  isStreaming,
  draftKey,
  imageUploadEnabled,
  imageSupportMessage,
  onModeChange,
  onProviderModelChange,
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
  modeOptions: Array<{ id: string; name: string }>
  currentModeId: string
  canChangeSettings: boolean
  canChangeProvider: boolean
  showModeControl: boolean
  showModelControl: boolean
  isStreaming: boolean
  draftKey: string
  imageUploadEnabled: boolean
  imageSupportMessage: string | null
  onModeChange: (id: string) => void
  onProviderModelChange: (providerId: ProviderId, modelId: string) => void
  onSend: (text: string, attachments: DraftImageAttachment[]) => Promise<void>
  onAbort: () => void
}) {
  const [drafts, setDrafts] = useState<
    Record<string, { text: string; attachments: DraftImageAttachment[] }>
  >({})
  const [sending, setSending] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
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
    if (attachments.length && !imageUploadEnabled) {
      setAttachmentError(imageSupportMessage ?? 'The selected model cannot read images.')
      return
    }
    setSending(true)
    setAttachmentError(null)
    try {
      await onSend(trimmed, attachments)
      setDrafts((current) => {
        const next = { ...current }
        delete next[draftKey]
        return next
      })
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
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
            : 'Ask anything, @ to mention, / for workflows'

  const isPlan = currentModeId === 'plan'
  const sendActive =
    hasContent && !disabled && !sending && (attachments.length === 0 || imageUploadEnabled)

  return (
    <div className="flex w-full flex-col">
      <div
        className={cn(
          chatInputShell,
          'gap-1 p-1 transition-[border-color,box-shadow]',
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
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || !imageUploadEnabled || sending}
              title={imageSupportMessage ?? 'Attach images'}
              aria-label="Attach images"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <PlusIcon size={12} />
            </button>

            <div className="mx-0.5 h-3.5 w-px shrink-0 bg-[var(--basis-border-muted)]" />

            {showModelControl && (
              <ProviderModelSelect
                groups={providerModelGroups}
                currentProviderId={currentProviderId}
                currentModelId={currentModelId}
                onChange={onProviderModelChange}
                disabled={!canChangeSettings}
                canChangeProvider={canChangeProvider}
              />
            )}

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
                />
              )
            )}

          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]"
            >
              <MicrophoneIcon size={12} />
            </button>
            {isStreaming ? (
              <button
                type="button"
                onClick={onAbort}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-500/90 text-white transition-colors hover:bg-red-500"
              >
                <SquareIcon className="h-3 w-3" />
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
                {sending ? (
                  <CircleNotchIcon size={13} className="animate-spin" />
                ) : (
                  <ArrowUpIcon size={14} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
