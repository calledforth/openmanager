import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  useSyncExternalStore,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
} from 'react'
import {
  ArrowUpIcon,
  ArrowsOutIcon,
  PlusIcon,
  CaretDownIcon,
  SquareIcon,
  XIcon,
  CircleNotchIcon,
} from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import type { ProviderId, SessionConfigOption } from '@agentpack/contract'
import { ImageViewer } from '../parts/GeneratedImagePart'
import { SearchableMenu, type SearchableMenuSection } from '../ui/SearchableMenu'
import { Tooltip } from '../ui/Tooltip'
import {
  chatInputShell,
  chatComposerTextarea,
  composerChip,
  composerFrame,
  btnSend,
  COMPOSER_TEXTAREA_MAX_PX,
} from './chatComposerStyles'
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  type ArtifactSource,
  type DraftImageAttachment,
  type KeptImage,
  type UploadedImageAttachment,
} from '../../lib/attachments'
import { useArtifactPreviews } from '../../lib/artifact-preview'
import { useComposerDraftStore, type ImageTarget } from './composerDraftStore'
import { DraftSyncIndicator } from './DraftSyncIndicator'
import type { SessionConfigValue } from './modelConfig'
import { ModelSettingsControl, type EffortControl } from './ModelSettingsTiles'
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

/** Lets another surface borrow the composer as its text field. */
export interface ComposerTextOverride {
  value: string
  onChange: (next: string) => void
  placeholder: string
  /** Runs on Enter and on the send button. */
  onSubmit: () => void
  /** Gates the send button the way non-empty text normally does. */
  canSubmit: boolean
  /** Typing is meaningless on a slide with no free-text field (the review). */
  readOnly?: boolean
}

/** Matches the `prefers-reduced-motion` guard globals.css applies to chat animations. */
function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

const NARROW_QUERY = '(max-width: 639px)'

function subscribeNarrow(onChange: () => void) {
  const query = window.matchMedia?.(NARROW_QUERY)
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}

/** A phone-width window, where the composer's long placeholder would wrap. */
function useNarrowScreen() {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia?.(NARROW_QUERY).matches ?? false,
    () => false,
  )
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
            composerChip,
            // A phone's row has room for a short label; the rest truncates.
            'max-w-[220px] gap-1 max-sm:max-w-[7.5rem]',
            ghost ? 'bg-transparent' : 'bg-hover',
            open && 'bg-active text-[var(--basis-text-strong)]',
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

type ComposerDraft = { text: string; attachments: DraftImageAttachment[] }

const NO_ATTACHMENTS: DraftImageAttachment[] = []
const NO_IMAGE_IDS: readonly string[] = []

/**
 * The draft's images with the uploads still on their way, each where it was
 * attached. An image with no slot (attached elsewhere, or before this
 * composer) keeps its place ahead of this composer's.
 */
function inSlotOrder<T extends { id: string }>(
  kept: readonly T[],
  uploading: readonly T[],
  slots: ReadonlyMap<string, number>,
): T[] {
  const slotOf = (item: T) => slots.get(item.id) ?? -1
  const waiting = [...uploading].sort((a, b) => slotOf(a) - slotOf(b))
  const merged: T[] = []
  for (const item of kept) {
    while (waiting.length > 0 && slotOf(waiting[0]!) < slotOf(item)) merged.push(waiting.shift()!)
    merged.push(item)
  }
  return [...merged, ...waiting]
}

/** Where an image in slot `slot` goes among a draft's images, by their slots. */
function slotIndex(images: readonly string[], slot: number, slots: ReadonlyMap<string, number>) {
  const after = images.findIndex((id) => (slots.get(id) ?? -1) > slot)
  return after === -1 ? images.length : after
}

/**
 * Fades the toolbar's edge on the side with more chips to scroll to. On a
 * phone the chips outgrow the row; without the fade the last one is just cut
 * off at the send button, with nothing to say the row scrolls. Written
 * straight to the element's style, so scrolling never renders the composer.
 */
function useScrollEdgeFade() {
  const ref = useRef<HTMLDivElement>(null)
  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    const room = el.scrollWidth - el.clientWidth
    const start = room > 1 && el.scrollLeft > 1
    const end = room > 1 && el.scrollLeft < room - 1
    el.style.maskImage =
      start || end
        ? `linear-gradient(to right, ${start ? 'transparent, #000 20px' : '#000'}, ${end ? '#000 calc(100% - 20px), transparent' : '#000'})`
        : ''
  }, [])
  // Set up once: the composer renders on every keystroke, and nothing here
  // needs to run then. The observer follows the chips as they come and go.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    update()
    el.addEventListener('scroll', update, { passive: true })
    if (typeof ResizeObserver === 'undefined') return () => el.removeEventListener('scroll', update)
    // The row, and each chip: a label that changes length changes the overflow.
    const resize = new ResizeObserver(update)
    const observeAll = () => {
      resize.disconnect()
      resize.observe(el)
      for (const child of el.children) resize.observe(child)
    }
    observeAll()
    const chips = new MutationObserver(observeAll)
    chips.observe(el, { childList: true })
    return () => {
      el.removeEventListener('scroll', update)
      resize.disconnect()
      chips.disconnect()
    }
  }, [update])
  return ref
}

/** An image as the composer shows it, whichever way the draft holds it. */
type ComposerImage = {
  id: string
  name: string
  /** Absent while a kept image's bytes load, or when they cannot be read. */
  url?: string
  /** On its way to the environment; the draft names it once it lands. */
  uploading?: boolean
  failed?: boolean
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
  effortOptions,
  effortConfigId = 'effort',
  currentEffort,
  canChangeSettings,
  canChangeProvider,
  showModeControl,
  showModelControl,
  isStreaming,
  isAwaitingPlanReview = false,
  textOverride,
  attachedTop = false,
  draftKey,
  imageUploadEnabled,
  imageSupportMessage,
  settingsError,
  sendBlockedReason = null,
  slashCommands = [],
  usage = null,
  onModeChange,
  onProviderModelChange,
  onConfigOptionChange,
  onSend,
  onAbort,
  uploadImage,
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
  /** The effort control as the provider lists it, with its own labels. Takes
   * over from `effortLevels` when given: OpenCode and Cursor name their
   * levels ("Extra-high"), and only Claude's come as bare ids. */
  effortOptions?: Array<{ id: string; name: string; description?: string }>
  /** The setting the pill writes: `effort` for Claude and OpenCode, and
   * whichever of `effort`/`reasoning`/`reasoning_effort` a Cursor model uses. */
  effortConfigId?: string
  currentEffort: string
  currentModeId: string
  canChangeSettings: boolean
  canChangeProvider: boolean
  showModeControl: boolean
  showModelControl: boolean
  isStreaming: boolean
  isAwaitingPlanReview?: boolean
  /** Takes the composer over as some other feature's text field — today, the
   * free-text answer of a pending question. The draft is owned by the caller,
   * Enter runs `onSubmit` instead of sending, and nothing reaches `onSend`. */
  textOverride?: ComposerTextOverride
  /** Flatten top radius/border so an attached strip (todos) can sit flush above. */
  attachedTop?: boolean
  draftKey: string
  imageUploadEnabled: boolean
  imageSupportMessage: string | null
  /** Last failure from changing the model, mode or a setting. */
  settingsError?: string | null
  /** Why this draft cannot be sent as it stands (its provider or project is
   * unavailable). Send is held, and the reason shown, until it clears. */
  sendBlockedReason?: string | null
  slashCommands?: SlashCommandItem[]
  usage?: ComposerUsage | null
  onModeChange: (id: string) => void
  onProviderModelChange: (providerId: ProviderId, modelId: string) => void
  onConfigOptionChange: (configId: string, value: SessionConfigValue) => void
  /**
   * `attachments` are images still to upload; `kept` are images the draft
   * already holds on the environment, uploaded when they were attached.
   */
  onSend: (text: string, attachments: DraftImageAttachment[], kept?: KeptImage[]) => Promise<void>
  onAbort: () => void
  /**
   * Store one image now, for the open draft. Given, and where the draft store
   * keeps images, an image is uploaded when attached and kept with the draft,
   * so it survives a reload and shows on every device; otherwise images wait
   * here and upload when sent.
   */
  uploadImage?: (image: DraftImageAttachment) => Promise<UploadedImageAttachment>
}) {
  // Text lives in the host's draft store, which reads synchronously, so a
  // restored draft is on screen at first paint — no frame of empty box.
  const draftStore = useComposerDraftStore()
  const readText = useCallback(() => draftStore.getText(draftKey), [draftKey, draftStore])
  const storedText = useSyncExternalStore(draftStore.subscribe, readText, readText)
  // Where the store keeps images, an image is uploaded as it is attached and
  // the draft names it from then on: it is on every device and survives a
  // reload. Here, then, are only the images still uploading. Elsewhere the
  // `File`s wait here, with `blob:` previews, and upload when sent.
  const keepsImages =
    !!uploadImage &&
    !!draftStore.getImages &&
    !!draftStore.setImages &&
    !!draftStore.keepsImages?.(draftKey)
  const readImages = useCallback(
    () => (keepsImages ? draftStore.getImages!(draftKey) : NO_IMAGE_IDS),
    [draftKey, draftStore, keepsImages],
  )
  const storedImages = useSyncExternalStore(draftStore.subscribe, readImages, readImages)
  const [attachmentsByKey, setAttachmentsByKey] = useState<Record<string, DraftImageAttachment[]>>(
    {},
  )
  // This composer's own previews of images it uploaded, so they need not be
  // read back. Released once they are sent, or when it unmounts.
  const keptPreviewsRef = useRef(new Map<string, { url: string; name: string }>())
  // Each image takes its place in the draft when attached, not when its
  // upload finishes: uploads started together land in any order. Slots
  // count up, by upload (pending id) and, once landed, by artifact id.
  const nextSlotRef = useRef(0)
  const slotsRef = useRef(new Map<string, number>())
  // The hold each upload keeps on its draft, by pending id: let go when the
  // upload settles or the image is taken out, whichever comes first.
  const holdsRef = useRef(new Map<string, () => void>())
  const releaseHold = (attachmentId: string) => {
    const release = holdsRef.current.get(attachmentId)
    holdsRef.current.delete(attachmentId)
    release?.()
  }
  // The draft key on screen; null once unmounted.
  const draftKeyRef = useRef<string | null>(draftKey)
  draftKeyRef.current = draftKey
  const [sending, setSending] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [viewingAttachment, setViewingAttachment] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lastHeightRef = useRef<number | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const toolbarRef = useScrollEdgeFade()
  const attachmentsRef = useRef(attachmentsByKey)
  const draft: ComposerDraft = {
    text: storedText,
    attachments: attachmentsByKey[draftKey] ?? NO_ATTACHMENTS,
  }
  // While borrowed, the visible text belongs to the caller — the session draft
  // underneath is left untouched so it comes back intact afterwards.
  const text = textOverride ? textOverride.value : draft.text
  const attachments = draft.attachments
  // A kept image another device attached, or one from before a reload, is
  // read back from the environment; one uploaded here shows its own preview.
  const keptPreviews = keptPreviewsRef.current
  const remoteSources = useMemo(
    () =>
      storedImages.flatMap((artifactId): ArtifactSource[] => {
        if (keptPreviews.has(artifactId)) return []
        const source = draftStore.imageSource?.(draftKey, artifactId)
        return source ? [source] : []
      }),
    [draftKey, draftStore, keptPreviews, storedImages],
  )
  const remotePreviews = useArtifactPreviews(remoteSources)
  const images: ComposerImage[] = keepsImages
    ? inSlotOrder<ComposerImage>(
        storedImages.map((artifactId, index) => {
          const local = keptPreviews.get(artifactId)
          const remote = remotePreviews[remoteSources.findIndex((s) => s.artifactId === artifactId)]
          return {
            id: artifactId,
            name: local?.name ?? `Image ${index + 1}`,
            url: local?.url ?? remote?.url,
            failed: !local && remote?.failed === true,
          }
        }),
        attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.file.name,
          url: attachment.previewUrl,
          uploading: true,
        })),
        slotsRef.current,
      )
    : attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.file.name,
        url: attachment.previewUrl,
      }))
  const uploadingImages = keepsImages && attachments.length > 0
  // A preview belongs to the list it was opened on: once a send clears it or
  // another draft swaps it in, an index left behind would reopen the viewer on
  // whatever image lands there next. Compared by ids, not identity: a draft
  // with no entry yields a fresh empty array on every render.
  const attachmentIds = images.map((image) => image.id).join('\n')
  const [previewedIds, setPreviewedIds] = useState(attachmentIds)
  if (previewedIds !== attachmentIds) {
    setPreviewedIds(attachmentIds)
    setViewingAttachment(null)
  }

  useEffect(() => {
    attachmentsRef.current = attachmentsByKey
  }, [attachmentsByKey])

  useEffect(() => {
    const kept = keptPreviewsRef.current
    return () => {
      for (const item of Object.values(attachmentsRef.current)) {
        for (const attachment of item) URL.revokeObjectURL(attachment.previewUrl)
      }
      for (const { url } of kept.values()) URL.revokeObjectURL(url)
      // Uploads still landing find no composer on screen.
      draftKeyRef.current = null
    }
  }, [])

  // A borrowed composer never writes a draft — its text belongs to the caller
  // — so nothing here can leak a question answer into a session draft.
  //
  // The store saves after a pause, which is what makes the exit paths
  // necessary: a quit, a hidden tab or leaving this draft landing between
  // keystrokes would otherwise wait out the pause. The cleanup flush also
  // covers the unmount when a subagent transcript replaces the composer.
  useEffect(() => {
    const flush = () => draftStore.flush()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      flush()
    }
  }, [draftKey, draftStore])

  const updateDraft = useCallback(
    (
      update: (current: { text: string; attachments: DraftImageAttachment[] }) => {
        text: string
        attachments: DraftImageAttachment[]
      },
    ) => {
      const current: ComposerDraft = {
        text: draftStore.getText(draftKey),
        attachments: attachmentsRef.current[draftKey] ?? NO_ATTACHMENTS,
      }
      const next = update(current)
      if (next.attachments !== current.attachments) {
        // Kept current here as well, so two updates in one event both apply.
        attachmentsRef.current = { ...attachmentsRef.current, [draftKey]: next.attachments }
        setAttachmentsByKey(attachmentsRef.current)
      }
      if (next.text !== current.text) draftStore.setText(draftKey, next.text)
    },
    [draftKey, draftStore],
  )

  const slashQuery = useMemo(() => slashQueryFromText(text), [text])

  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : matchSlashCommands(slashCommands, slashQuery)),
    [slashCommands, slashQuery],
  )

  // A borrowed composer answers a question; `/commands` would go nowhere.
  const slashOpen =
    slashQuery !== null && !slashDismissed && slashMatches.length > 0 && !disabled && !textOverride

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

  const focusTextarea = useCallback(() => textareaRef.current?.focus(), [])

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
      // Paste and drop still reach a held (read-only) box; a launching draft
      // takes nothing more, or it would land in a draft the user has left.
      if (pendingDraftSessionStart) return
      if (!imageUploadEnabled) {
        setAttachmentError(imageSupportMessage ?? 'Image uploads are unavailable.')
        return
      }
      let error: string | null = null
      const added: DraftImageAttachment[] = []
      // Images the draft already keeps count towards the limit too.
      const kept = keepsImages ? draftStore.getImages!(draftKey).length : 0
      updateDraft((current) => {
        const next = [...current.attachments]
        for (const file of files) {
          if (kept + next.length >= MAX_IMAGE_ATTACHMENTS) {
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
          const attachment = {
            id: crypto.randomUUID(),
            file,
            previewUrl: URL.createObjectURL(file),
          }
          next.push(attachment)
          added.push(attachment)
        }
        return { ...current, attachments: next }
      })
      // An image is the draft's first content as much as text is.
      if (attachmentsRef.current[draftKey]?.length) draftStore.claim?.(draftKey)
      setAttachmentError(error)
      if (!keepsImages) return
      // Tied to the draft as it is now: claimed above, so a first image's
      // draft is the page's.
      const target = draftStore.imageTarget?.(draftKey)
      for (const attachment of added) {
        slotsRef.current.set(attachment.id, (nextSlotRef.current += 1))
        // On its way, the image is content: erasing the text meanwhile does
        // not delete the draft it is for. Released once it has landed (or
        // not) or is taken out, so a draft left with nothing is deleted
        // then, as ever.
        const release = draftStore.holdImage?.(draftKey)
        if (release) holdsRef.current.set(attachment.id, release)
        void keepImage(draftKey, attachment, target).finally(() => releaseHold(attachment.id))
      }
    },
    // keepImage reads only refs and stable props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      draftKey,
      draftStore,
      imageSupportMessage,
      imageUploadEnabled,
      keepsImages,
      pendingDraftSessionStart,
      updateDraft,
    ],
  )

  /** The images still uploading for a draft, which need not be the one on screen now. */
  const setUploading = (key: string, next: DraftImageAttachment[]) => {
    attachmentsRef.current = { ...attachmentsRef.current, [key]: next }
    setAttachmentsByKey(attachmentsRef.current)
  }

  /**
   * Upload an image just attached, then name it, in its slot, in the draft it
   * was attached to, wherever the user is by then. Only that draft: one that
   * was deleted, sent or set aside meanwhile is not brought back by it. An
   * image that lands nowhere (that, or removed while it uploaded) is left
   * for the environment to expire: no draft names it.
   */
  const keepImage = async (
    key: string,
    attachment: DraftImageAttachment,
    target: ImageTarget | undefined,
  ) => {
    const slot = slotsRef.current.get(attachment.id) ?? (nextSlotRef.current += 1)
    const stillWanted = () =>
      (attachmentsRef.current[key] ?? NO_ATTACHMENTS).some((each) => each.id === attachment.id)
    const settle = () => {
      slotsRef.current.delete(attachment.id)
      setUploading(
        key,
        (attachmentsRef.current[key] ?? NO_ATTACHMENTS).filter((each) => each.id !== attachment.id),
      )
    }
    const fail = (reason: string) => {
      settle()
      URL.revokeObjectURL(attachment.previewUrl)
      if (draftKeyRef.current === key) {
        setAttachmentError(`${attachment.file.name} was not attached. ${reason}`)
      }
    }
    let stored: UploadedImageAttachment
    try {
      stored = await uploadImage!(attachment)
    } catch (error) {
      if (stillWanted()) fail(error instanceof Error ? error.message : 'The upload failed.')
      return
    }
    if (!stillWanted()) {
      settle()
      URL.revokeObjectURL(attachment.previewUrl)
      return
    }
    if (target && draftStore.imageTargetLive && !draftStore.imageTargetLive(target)) {
      fail('Its draft was sent or deleted meanwhile.')
      return
    }
    // In its slot: uploads started together finish in any order.
    const images = draftStore.getImages!(key).filter((id) => id !== stored.id)
    const at = slotIndex(images, slot, slotsRef.current)
    slotsRef.current.set(stored.id, slot)
    // Its own preview first, so naming it never sends for the bytes; and
    // named before the upload is dropped from the list, so the image never
    // blinks out between the two.
    keptPreviewsRef.current.set(stored.id, {
      url: attachment.previewUrl,
      name: attachment.file.name,
    })
    if (!draftStore.setImages!(key, [...images.slice(0, at), stored.id, ...images.slice(at)])) {
      slotsRef.current.delete(stored.id)
      keptPreviewsRef.current.delete(stored.id)
      fail('Its draft is gone.')
      return
    }
    settle()
  }

  /** Let go of what this composer kept for images that are sent or removed. */
  const forgetSent = (artifactIds: readonly string[]) => {
    for (const artifactId of artifactIds) {
      slotsRef.current.delete(artifactId)
      const local = keptPreviewsRef.current.get(artifactId)
      if (!local) continue
      keptPreviewsRef.current.delete(artifactId)
      URL.revokeObjectURL(local.url)
    }
  }

  const removeAttachment = (id: string) => {
    if (keepsImages && storedImages.includes(id)) {
      // Unnamed, the environment lets it go: at once if the draft is
      // discarded, else when held images expire.
      draftStore.setImages!(
        draftKey,
        draftStore.getImages!(draftKey).filter((artifactId) => artifactId !== id),
      )
      forgetSent([id])
      setAttachmentError(null)
      return
    }
    updateDraft((current) => {
      const removed = current.attachments.find((attachment) => attachment.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return {
        ...current,
        attachments: current.attachments.filter((attachment) => attachment.id !== id),
      }
    })
    // Taken out on its way: it no longer keeps the draft from being empty.
    releaseHold(id)
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
    if (textOverride) {
      if (textOverride.canSubmit) textOverride.onSubmit()
      return
    }
    const trimmed = text.trim()
    if (
      (!trimmed && images.length === 0) ||
      disabled ||
      sending ||
      pendingDraftSessionStart ||
      sendBlockedReason ||
      // The draft names an image only once it has landed.
      uploadingImages
    )
      return
    if (isAwaitingPlanReview && images.length > 0) {
      setAttachmentError('Remove image attachments before requesting plan changes.')
      return
    }
    if (images.length && !imageUploadEnabled) {
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
    const restoreImages = storedImages
    const kept: KeptImage[] = images
      .filter((image) => !image.uploading && restoreImages.includes(image.id))
      .map((image) => ({
        artifactId: image.id,
        name: image.name,
        ...(image.url ? { previewUrl: image.url } : {}),
      }))
    updateDraft(() => ({ text: '', attachments: NO_ATTACHMENTS }))
    if (restoreImages.length > 0) draftStore.setImages?.(draftKey, NO_IMAGE_IDS)
    const release = draftStore.beginSend?.(
      draftKey,
      restore.text,
      keepsImages ? restoreImages : undefined,
    )
    try {
      await onSend(trimmed, keepsImages ? NO_ATTACHMENTS : attachments, kept)
      release?.()
      // Sent: the transcript reads them from the session now. A failed send
      // keeps them, for the draft it puts back.
      forgetSent(restoreImages)
    } catch (error) {
      release?.()
      // The composer stays live during an in-flight send, so anything typed
      // since must survive the rollback: the failed text goes back in front
      // of it rather than over it. Normally the box is still empty and this
      // restores the message verbatim.
      updateDraft((active) =>
        !active.text && active.attachments.length === 0
          ? restore
          : {
              text: active.text ? `${restore.text}\n${active.text}` : restore.text,
              attachments: [...restore.attachments, ...active.attachments],
            },
      )
      if (restoreImages.length > 0) {
        const active = draftStore.getImages?.(draftKey) ?? NO_IMAGE_IDS
        draftStore.setImages?.(draftKey, [
          ...restoreImages,
          ...active.filter((artifactId) => !restoreImages.includes(artifactId)),
        ])
      }
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
  const hasContent = text.trim().length > 0 || images.length > 0
  // Only an image whose bytes are here can be opened large.
  const viewable = images.filter((image): image is ComposerImage & { url: string } => !!image.url)
  const narrow = useNarrowScreen()
  // On a phone the full hint runs to two lines; the box says just the ask.
  const askPlaceholder = narrow ? 'Ask anything…' : 'Ask anything, @ to mention, / for workflows'
  const placeholder = textOverride
    ? textOverride.placeholder
    : !activeWorkspacePath
      ? 'Select a workspace...'
      : // A launching draft keeps its placeholder; the pill above says what
        // is happening, so the box does not change twice in a second.
        !activeSessionId && isSessionDraftOpen
        ? askPlaceholder
        : !activeSessionId
          ? 'Select a session...'
          : !providerReady
            ? `Connecting to ${currentProviderName}...`
            : isAwaitingPlanReview
              ? 'Describe what should change in the plan…'
              : askPlaceholder

  const isPlan = currentModeId === 'plan'
  const sendActive = textOverride
    ? textOverride.canSubmit
    : (isAwaitingPlanReview ? text.trim().length > 0 && images.length === 0 : hasContent) &&
      !disabled &&
      !sending &&
      !pendingDraftSessionStart &&
      !sendBlockedReason &&
      !uploadingImages &&
      (images.length === 0 || imageUploadEnabled)
  const effortChoices = effortOptions ?? effortLevels.map((level) => ({ id: level, name: level }))
  // Blank until the session says otherwise: the CLI picks its own depth when
  // nothing asked, and inventing "high" here would claim a setting never sent.
  const effortControl: EffortControl | undefined =
    effortChoices.length > 0
      ? {
          choices: effortChoices,
          current: currentEffort,
          onChange: (level) => onConfigOptionChange(effortConfigId, level),
        }
      : undefined

  return (
    // Attached under a question card or the todo list, the composer is part of
    // a stack that MessageInput frames; on its own it is the card.
    <div className={cn('flex w-full flex-col', !attachedTop && composerFrame)}>
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
      {viewingAttachment !== null && viewingAttachment < viewable.length && (
        <ImageViewer
          images={viewable.map((image) => ({ id: image.id, url: image.url, name: image.name }))}
          index={viewingAttachment}
          onIndexChange={setViewingAttachment}
          onClose={() => setViewingAttachment(null)}
        />
      )}
      <div
        ref={shellRef}
        className={cn(
          chatInputShell,
          'gap-1 p-1 transition-colors',
          attachedTop && 'rounded-t-none',
          // A drop target reads by fill, like every other state here.
          isDragging && 'bg-active',
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
        {images.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-2 pt-1.5 pb-0.5 scrollbar-hide">
            {images.map((image) => (
              <div
                key={image.id}
                aria-busy={image.uploading || undefined}
                className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-[var(--basis-border)] bg-[var(--basis-surface)] shadow-sm"
              >
                <button
                  type="button"
                  disabled={!image.url}
                  onClick={() =>
                    setViewingAttachment(viewable.findIndex((each) => each.id === image.id))
                  }
                  aria-label={
                    image.failed ? `${image.name} could not be loaded` : `Preview ${image.name}`
                  }
                  className="block h-full w-full cursor-zoom-in disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--basis-text-muted)]"
                >
                  {image.url ? (
                    <img
                      src={image.url}
                      alt={image.name}
                      className={cn(
                        'h-full w-full object-cover transition-[transform,opacity] duration-200 group-hover:scale-[1.03]',
                        image.uploading && 'opacity-60',
                      )}
                    />
                  ) : (
                    // Read back from the environment, or not there to read.
                    <span
                      className={cn(
                        'flex h-full w-full items-center justify-center text-[10px] text-[var(--basis-text-muted)]',
                        !image.failed && 'animate-pulse bg-[var(--basis-border)]',
                      )}
                    >
                      {image.failed ? 'Unavailable' : null}
                    </span>
                  )}
                  {image.uploading ? (
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-white">
                      <CircleNotchIcon className="h-4 w-4 animate-spin drop-shadow" />
                    </span>
                  ) : image.url ? (
                    <span className="pointer-events-none absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded border border-white/15 bg-black/55 text-white/75 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <ArrowsOutIcon className="h-2.5 w-2.5" />
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={() => removeAttachment(image.id)}
                  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white opacity-90 shadow-sm transition hover:bg-black group-hover:opacity-100"
                  aria-label={`Remove ${image.name}`}
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
          onChange={(e) =>
            textOverride
              ? textOverride.onChange(e.target.value)
              : updateDraft((current) => ({ ...current, text: e.target.value }))
          }
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          disabled={disabled}
          // Held, not disabled, while a draft launches: what it said is
          // already in the transcript, and dimming the box would flicker.
          readOnly={textOverride?.readOnly || pendingDraftSessionStart}
          rows={1}
          className={cn(chatComposerTextarea, 'max-h-[156px] overflow-y-auto')}
        />

        {(attachmentError || (images.length > 0 && imageSupportMessage)) && (
          <div className="px-2 pb-1 text-[11px] leading-4 text-amber-500" role="alert">
            {attachmentError ?? imageSupportMessage}
          </div>
        )}
        {settingsError && (
          <div className="px-2 pb-1 text-[11px] leading-4 text-amber-500" role="alert">
            {settingsError}
          </div>
        )}
        {sendBlockedReason && !textOverride && (
          <div className="px-2 pb-1 text-[11px] leading-4 text-amber-500" role="status">
            {sendBlockedReason}
          </div>
        )}

        <div className="flex items-center justify-between gap-1.5 px-1 pb-0.5">
          <div
            ref={toolbarRef}
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-hide"
          >
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
                disabled={
                  disabled ||
                  !imageUploadEnabled ||
                  sending ||
                  pendingDraftSessionStart ||
                  isAwaitingPlanReview
                }
                aria-label="Attach images"
                className={cn(
                  composerChip,
                  'w-6 justify-center px-0 text-[var(--basis-text-muted)] hover:text-[var(--basis-text)]',
                )}
              >
                <PlusIcon size={12} />
              </button>
            </Tooltip>

            {showModelControl && (
              <ProviderModelPicker
                groups={providerModelGroups}
                currentProviderId={currentProviderId}
                currentModelId={currentModelId}
                onChange={onProviderModelChange}
                disabled={!canChangeSettings}
                canChangeProvider={canChangeProvider}
                shortcut="mod+shift+m"
                onDone={focusTextarea}
              />
            )}

            <ModelSettingsControl
              options={configOptions}
              effort={effortControl}
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

            {usage && (
              <span className="ml-1 flex shrink-0 items-center">
                <ContextMeter usage={usage} />
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {/* A borrowed composer's text is the caller's, not the draft's. */}
            {!textOverride && <DraftSyncIndicator store={draftStore} draftKey={draftKey} />}
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
