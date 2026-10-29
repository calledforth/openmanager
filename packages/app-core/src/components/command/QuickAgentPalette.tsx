import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  ArrowsOutSimpleIcon,
  CaretRightIcon,
  CircleNotchIcon,
  FolderPlusIcon,
  PaperclipIcon,
  XIcon,
} from '@phosphor-icons/react'
import {
  hasDraftContent,
  selectDraftContent,
  selectDraftTarget,
} from '@openmanager/environment-client'
import { cn } from '../../lib/utils'
import { useAnchorBox, useNoticeAnchor } from '../../lib/notice-anchors'
import { spring } from '../fluid/lib/springs'
import { CommandMenuShortcut, matchesShortcut, parseShortcut } from '../fluid/ui/command-menu'
import { Tooltip } from '../ui/Tooltip'
import { useMessageInputBinding } from '../chat/MessageInput'
import { ComposerImageStrip, useMessageInputController } from '../chat/MessageInputView'
import { ProviderModelPicker } from '../chat/ProviderModelPicker'
import { ModelSettingsControl } from '../chat/ModelSettingsTiles'
import { SlashCommandPopup } from '../chat/SlashCommandPopup'
import { DraftSyncIndicator } from '../chat/DraftSyncIndicator'
import { ImageViewer } from '../parts/GeneratedImagePart'
import { ACCEPTED_IMAGE_TYPES } from '../../lib/attachments'
import { ProjectPicker } from '../chat/ProjectPicker'
import { DraftPageNavigationContext } from '../../providers/draft-pages'
import { useEnvironmentClient } from '../../providers/environment-client'
import {
  QuickAgentScope,
  mintQuickAgentDraft,
  type QuickAgentDraft,
  type QuickAgentStarted,
} from '../../providers/environment-quick-agent'
import { useSessionState } from '../../providers/session-provider'
import { useSidebarData, type WorkspaceEntry } from '../../providers/sidebar-provider'

/** Opens the palette from anywhere, typing included. */
export const QUICK_AGENT_SHORTCUT = 'mod+shift+o'
/** Opens it outside a text field, as Linear's C makes an issue. */
export const QUICK_AGENT_KEY = 'n'

/** How long a notice stays up, unless pointer or focus holds it. */
const NOTICE_MS = 5_000
/** How long after opening focus is held in the composer (see the view). */
const HOLD_FOCUS_MS = 800

// ---------------------------------------------------------------------------
// Opening it from elsewhere (the command palette's "New agent…").
// ---------------------------------------------------------------------------

const openers: Array<() => void> = []
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const isAvailable = () => openers.length > 0

/** Opens the quick New agent palette; false where none is mounted. */
export function requestQuickAgent(): boolean {
  const open = openers.at(-1)
  if (!open) return false
  open()
  return true
}

/** Whether a quick New agent palette is mounted and can be opened. */
export function useQuickAgentAvailable(): boolean {
  return useSyncExternalStore(subscribe, isAvailable, () => false)
}

function useRegisterQuickAgent(open: () => void, enabled: boolean) {
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (!enabled) return
    const opener = () => openRef.current()
    openers.push(opener)
    notify()
    return () => {
      const at = openers.indexOf(opener)
      if (at !== -1) openers.splice(at, 1)
      notify()
    }
  }, [enabled])
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el?.tagName) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  )
}

/**
 * ⌘⇧O / Ctrl+Shift+O toggles the palette from anywhere; a bare N opens it
 * when no field has the keys and no other dialog is up. Chrome keeps ⌘N and
 * Ctrl+N (new window) for itself, so neither can be the chord.
 */
function useQuickAgentShortcuts(toggle: () => void, open: () => void, enabled: boolean) {
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (!enabled) return
    const chord = parseShortcut(QUICK_AGENT_SHORTCUT)
    const bare = parseShortcut(QUICK_AGENT_KEY)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented || event.isComposing) return
      if (matchesShortcut(event, chord)) {
        event.preventDefault()
        toggleRef.current()
        return
      }
      if (event.shiftKey || !matchesShortcut(event, bare) || isEditable(event.target)) return
      if (document.querySelector('[role="dialog"][data-state="open"]')) return
      event.preventDefault()
      openRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}

// ---------------------------------------------------------------------------
// The shell.
// ---------------------------------------------------------------------------

export interface QuickAgentPaletteViewProps {
  open: boolean
  /** Escape, the ✕ or a click on the page behind. */
  onClose: () => void
  /** The project the agent starts in. */
  project: ReactNode
  /** Opens the draft as a full page; left out, no button shows. */
  onExpand?: () => void
  /** The form: what to do, its images and settings, and its actions. */
  children: ReactNode
}

/**
 * A floating card over the page, after Linear's New issue: the project and
 * "New agent" on top, the form under them.
 *
 * Not a Radix dialog: the form's menus (model, settings, slash commands) are
 * portaled to the body, where a modal dialog's focus trap and pointer lock
 * would shut them out, and its capture-phase Escape would close the card
 * before a menu could take the key. Escape here closes the card only when
 * nothing inside it used the key, and never while one of its menus is open.
 */
export function QuickAgentPaletteView({
  open,
  onClose,
  project,
  onExpand,
  children,
}: QuickAgentPaletteViewProps) {
  const reduceMotion = useReducedMotion() ?? false
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Focus goes into the composer on open, and back where it was on close.
  useLayoutEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const field = () => panelRef.current?.querySelector<HTMLTextAreaElement>('textarea')
    field()?.focus({ preventScroll: true })
    // Opened from the command palette, which hands focus back to the page a
    // moment later as it closes: for that moment, focus that lands back on
    // the page without a pointer press comes back here. Only the page: one of
    // the form's own menus (portaled outside the card, holding its own field)
    // keeps it, or the two would pull focus back and forth.
    const until = performance.now() + HOLD_FOCUS_MS
    let pointerDown = false
    const onPointerDown = () => {
      pointerDown = true
    }
    const onFocusIn = (event: FocusEvent) => {
      if (pointerDown || performance.now() > until) return
      const target = event.target as Element | null
      if (target && panelRef.current?.contains(target)) return
      if (target?.closest?.('[role="dialog"], [role="listbox"], [role="menu"]')) return
      field()?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    // Read before anything handles the key: a menu Escape closes is gone by
    // the time the key comes back up.
    let menuOpen = false
    const onCapture = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      menuOpen = !!panelRef.current?.querySelector('[aria-expanded="true"]')
    }
    const onBubble = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || menuOpen) return
      event.preventDefault()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onCapture, true)
    window.addEventListener('keydown', onBubble)
    return () => {
      window.removeEventListener('keydown', onCapture, true)
      window.removeEventListener('keydown', onBubble)
    }
  }, [open])

  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>
      {open ? (
        <div key="quick-agent" className="fixed inset-0 z-[60]">
          <motion.div
            aria-hidden
            className="absolute inset-0 bg-[var(--float-scrim)]"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1, transition: spring.moderate }}
            exit={{ opacity: 0, transition: spring.moderate.exit }}
            onPointerDown={() => onCloseRef.current()}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-label="New agent"
            data-state="open"
            data-quick-agent=""
            className="absolute left-1/2 top-[max(10dvh,calc(42dvh-180px))] flex w-[calc(100%-2rem)] max-w-[720px] -translate-x-1/2 flex-col rounded-float bg-float shadow-float"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.97, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: spring.moderate }}
            exit={{ opacity: 0, scale: 0.98, y: 4, transition: spring.moderate.exit }}
          >
            <header className="flex items-center gap-1 px-3 pt-3">
              <div className="flex min-w-0 flex-1 items-center gap-0.5 text-[13px]">
                {project}
                <CaretRightIcon
                  aria-hidden
                  weight="bold"
                  className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]"
                />
                <span className="truncate px-1.5 text-[var(--basis-text-strong)]">New agent</span>
              </div>
              {onExpand ? (
                <Tooltip content="Open as a page" side="bottom">
                  <button
                    type="button"
                    aria-label="Open as a page"
                    onClick={onExpand}
                    className={iconButton}
                  >
                    <ArrowsOutSimpleIcon className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              ) : null}
              <Tooltip
                content={
                  <span className="flex items-center gap-2">
                    Close
                    <CommandMenuShortcut keys="Esc" className="ml-0" />
                  </span>
                }
                side="bottom"
              >
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => onCloseRef.current()}
                  className={iconButton}
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </header>
            {children}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}

const iconButton =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--basis-text-muted)] outline-none transition-colors duration-80 hover:bg-hover hover:text-[var(--basis-text)] focus-visible:ring-1 focus-visible:ring-focus-ring'

// ---------------------------------------------------------------------------
// The notice: what became of the palette's draft.
// ---------------------------------------------------------------------------

export interface QuickAgentNoticeData {
  key: number
  kind: 'started' | 'saved'
  /** The project's name, if it is known. */
  project?: string
  onOpen: () => void
}

/**
 * Says the agent started (or the draft was kept) and offers to open it. It
 * rests just above the page's composer, where the discard notice does, or at
 * the foot of the window without one.
 */
export function QuickAgentNoticeView({
  notice,
  onDismiss,
}: {
  notice: QuickAgentNoticeData | null
  onDismiss: (key: number) => void
}) {
  const showing = notice !== null
  const composer = useAnchorBox(useNoticeAnchor('composer'), showing)
  const [held, setHeld] = useState(false)
  const key = notice?.key
  useEffect(() => {
    if (key === undefined || held) return
    const timer = setTimeout(() => onDismiss(key), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [held, key, onDismiss])
  useEffect(() => setHeld(false), [key])

  if (typeof document === 'undefined') return null
  const placement: CSSProperties = composer
    ? {
        left: composer.left,
        width: composer.width,
        bottom: window.innerHeight - composer.top + 8,
        paddingInline: 16,
      }
    : { left: 0, right: 0, bottom: 16, paddingInline: 12 }
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed z-[500] flex justify-center"
      style={placement}
    >
      <AnimatePresence>
        {notice ? (
          <QuickAgentNotice
            key={notice.key}
            notice={notice}
            onHold={setHeld}
            onDismiss={() => onDismiss(notice.key)}
          />
        ) : null}
      </AnimatePresence>
    </div>,
    document.body,
  )
}

function QuickAgentNotice({
  notice,
  onHold,
  onDismiss,
}: {
  notice: QuickAgentNoticeData
  onHold: (held: boolean) => void
  onDismiss: () => void
}) {
  const reduceMotion = useReducedMotion() ?? false
  const label =
    notice.kind === 'started'
      ? notice.project
        ? `Agent started in ${notice.project}`
        : 'Agent started'
      : notice.project
        ? `Saved to drafts in ${notice.project}`
        : 'Saved to drafts'
  return (
    <motion.div
      className="pointer-events-auto flex max-w-full items-center gap-1 rounded-float bg-float py-1 pl-3 pr-1 text-[13px] text-foreground shadow-float"
      initial={reduceMotion ? false : { opacity: 0, y: 6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: spring.moderate }}
      exit={{ opacity: 0, y: 4, scale: 0.98, transition: spring.moderate.exit }}
      onPointerEnter={() => onHold(true)}
      onPointerLeave={() => onHold(false)}
      onFocus={() => onHold(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHold(false)
      }}
    >
      <span className="truncate pr-2">{label}</span>
      <button
        type="button"
        onClick={() => {
          notice.onOpen()
          onDismiss()
        }}
        className="h-7 shrink-0 rounded-md px-2 font-medium outline-none transition-colors duration-80 hover:bg-hover focus-visible:ring-1 focus-visible:ring-focus-ring"
      >
        Open
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-80 hover:bg-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring"
      >
        <XIcon className="h-3.5 w-3.5" aria-hidden />
      </button>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Bound to the environment.
// ---------------------------------------------------------------------------

const NO_WORKSPACES: WorkspaceEntry[] = []

/** A project an agent can start in now. */
const hostable = (workspace: WorkspaceEntry | undefined): workspace is WorkspaceEntry =>
  !!workspace && !workspace.missing

/**
 * Start an agent without leaving the chat you are in: ⌘⇧O (or N outside a
 * field) opens a composer over the page. Enter starts the agent in the
 * background and says so; Escape keeps what was written as a draft, in the
 * sidebar with the rest. It is the page's composer and the page's drafts,
 * only not on a page: images, models and slash commands work as they do
 * there, and ⤢ carries the draft onto its own page.
 *
 * Render inside the environment providers. Where the environment keeps no
 * drafts there is nothing to keep an unsent agent in, so it does not mount.
 */
export function QuickAgentPalette() {
  const client = useEnvironmentClient()
  const sync = client.drafts
  if (!sync) return null
  return <QuickAgentPaletteBound />
}

function QuickAgentPaletteBound() {
  const client = useEnvironmentClient()
  const sync = client.drafts!
  const {
    workspaces,
    recentWorkspaces = NO_WORKSPACES,
    activeWorkspacePath,
    environment,
    addWorkspace,
  } = useSidebarData()
  const { selectSession, createSession } = useSessionState()
  const navigation = useContext(DraftPageNavigationContext)
  const [draft, setDraft] = useState<QuickAgentDraft | null>(null)
  const [notice, setNotice] = useState<QuickAgentNoticeData | null>(null)
  const noticeKey = useRef(0)

  const live = useRef({ workspaces, recentWorkspaces, activeWorkspacePath, draft })
  live.current = { workspaces, recentWorkspaces, activeWorkspacePath, draft }

  const nameOf = useCallback(
    (workspaceId: string | null) =>
      workspaceId
        ? live.current.workspaces.find((workspace) => workspace.path === workspaceId)?.name
        : undefined,
    [],
  )

  const open = useCallback(() => {
    if (live.current.draft) return
    const { workspaces, recentWorkspaces, activeWorkspacePath } = live.current
    // Where you are, else where you last worked, else the first one there.
    const workspaceId =
      (hostable(workspaces.find((workspace) => workspace.path === activeWorkspacePath))
        ? activeWorkspacePath
        : null) ??
      recentWorkspaces.find(hostable)?.path ??
      workspaces.find(hostable)?.path ??
      null
    setDraft(mintQuickAgentDraft(workspaceId))
  }, [])

  const show = useCallback((next: Omit<QuickAgentNoticeData, 'key'>) => {
    noticeKey.current += 1
    setNotice({ ...next, key: noticeKey.current })
  }, [])

  /** Closed without sending: what was written stays, as a draft. */
  const close = useCallback(() => {
    const current = live.current.draft
    if (!current) return
    setDraft(null)
    const state = client.getState()
    if (!hasDraftContent(selectDraftContent(state, current.draftId))) return
    // Saved now rather than after the pause in typing: the page may be
    // closed next.
    void sync.flush()
    const target = selectDraftTarget(state, current.draftId)
    const workspaceId = target?.type === 'new_session' ? target.workspaceId : current.workspaceId
    show({
      kind: 'saved',
      project: nameOf(workspaceId),
      onOpen: () => navigation?.openDraftPage(current.draftId),
    })
  }, [client, nameOf, navigation, show, sync])

  const toggle = useCallback(() => {
    if (live.current.draft) close()
    else open()
  }, [close, open])

  useQuickAgentShortcuts(toggle, open, true)
  useRegisterQuickAgent(open, true)

  const onStarted = useCallback(
    (started: QuickAgentStarted) => {
      // Only the palette that sent it: a send that finishes after the
      // palette was closed and opened again leaves the new one alone.
      setDraft((current) => (current?.draftId === started.draftId ? null : current))
      show({
        kind: 'started',
        project: nameOf(started.workspaceId),
        onOpen: () => selectSession(started.workspaceId, started.sessionId),
      })
    },
    [nameOf, selectSession, show],
  )

  const onWorkspaceChange = useCallback(
    (workspaceId: string) =>
      setDraft((current) => (current ? { ...current, workspaceId } : current)),
    [],
  )

  /** Carry the draft onto its own page, as it stands. */
  const expand = useCallback(() => {
    const current = live.current.draft
    if (!current) return
    setDraft(null)
    const state = client.getState()
    if (hasDraftContent(selectDraftContent(state, current.draftId)) && navigation) {
      navigation.openDraftPage(current.draftId)
      return
    }
    // Nothing written yet: a blank page in the same project.
    if (current.workspaceId) void createSession(current.workspaceId)
  }, [client, createSession, navigation])

  const dismissNotice = useCallback(
    (key: number) => setNotice((current) => (current?.key === key ? null : current)),
    [],
  )

  const noProjects = workspaces.length === 0
  return (
    <>
      {draft ? (
        <QuickAgentScope
          key={draft.draftId}
          draft={draft}
          onWorkspaceChange={onWorkspaceChange}
          onStarted={onStarted}
        >
          <QuickAgentPaletteContent
            draft={draft}
            noProjects={noProjects}
            workspaces={workspaces}
            recentWorkspaces={recentWorkspaces}
            environmentLabel={environment?.label}
            onClose={close}
            onExpand={navigation ? expand : undefined}
            onAddWorkspace={() => {
              setDraft(null)
              void addWorkspace()
            }}
          />
        </QuickAgentScope>
      ) : (
        <QuickAgentPaletteView open={false} onClose={close} project={null}>
          {null}
        </QuickAgentPaletteView>
      )}
      <QuickAgentNoticeView notice={notice} onDismiss={dismissNotice} />
    </>
  )
}

/** The palette inside its draft's scope, where session state is the draft's. */
function QuickAgentPaletteContent({
  draft,
  noProjects,
  workspaces,
  recentWorkspaces,
  environmentLabel,
  onClose,
  onExpand,
  onAddWorkspace,
}: {
  draft: QuickAgentDraft
  noProjects: boolean
  workspaces: WorkspaceEntry[]
  recentWorkspaces: WorkspaceEntry[]
  environmentLabel?: string
  onClose: () => void
  onExpand?: () => void
  onAddWorkspace: () => void
}) {
  const { activeWorkspacePath, setDraftWorkspace } = useSessionState()
  const activeWorkspace =
    workspaces.find((workspace) => workspace.path === activeWorkspacePath) ?? null
  return (
    <QuickAgentPaletteView
      open
      onClose={onClose}
      onExpand={noProjects ? undefined : onExpand}
      project={
        noProjects ? (
          <span className="px-2 text-[13px] text-[var(--basis-text-muted)]">No projects</span>
        ) : (
          <ProjectPicker
            variant="chip"
            workspaces={workspaces}
            recentWorkspaces={recentWorkspaces}
            activeWorkspace={activeWorkspace}
            environmentLabel={environmentLabel}
            onSelect={(workspacePath) => {
              if (workspacePath !== activeWorkspacePath) setDraftWorkspace?.(workspacePath)
            }}
            onAddWorkspace={onAddWorkspace}
          />
        )
      }
    >
      {noProjects ? (
        <NoProjects onAddWorkspace={onAddWorkspace} />
      ) : (
        <QuickAgentForm key={draft.draftId} />
      )}
    </QuickAgentPaletteView>
  )
}

/** Linear's property chip: a hairline pill, quiet until pointed at. */
const propertyChip =
  'h-7 rounded-md border border-[var(--basis-border-muted)] bg-transparent px-2 text-[12px] text-[var(--basis-text)] hover:bg-hover'

/**
 * The New agent form, after Linear's New issue: the ask, written straight
 * onto the card; its images under it; the model and its settings as property
 * chips; attach and Start along the foot. Its workings are the composer's
 * (`useMessageInputController`), bound to the palette's own draft: the text
 * and images are the draft's as they are written, and Start sends it as the
 * page's composer would.
 */
function QuickAgentForm() {
  const { viewProps } = useMessageInputBinding()
  const {
    imageUploadEnabled,
    imageSupportMessage,
    settingsError,
    sendBlockedReason,
    providerModelGroups,
    currentProviderId,
    currentModelId,
    onProviderModelChange,
    canChangeSettings,
    canChangeProvider,
    showModelControl,
    configOptions,
    onConfigOptionChange,
    pendingDraftSessionStart,
    draftKey,
  } = viewProps
  const {
    slashOpen,
    shellRef,
    slashMatches,
    slashActiveIndex,
    setSlashActiveIndex,
    acceptSlashCommand,
    setSlashDismissed,
    viewingAttachment,
    viewable,
    setViewingAttachment,
    isDragging,
    setIsDragging,
    onDrop,
    fileInputRef,
    addFiles,
    images,
    removeAttachment,
    textareaRef,
    text,
    updateDraft,
    onKeyDown,
    onPaste,
    attachmentError,
    sending,
    focusTextarea,
    effortControl,
    draftStore,
    sendActive,
    send,
  } = useMessageInputController(viewProps)
  const starting = sending || pendingDraftSessionStart
  const notice =
    attachmentError ??
    settingsError ??
    sendBlockedReason ??
    (images.length > 0 ? imageSupportMessage : null)

  return (
    <div
      ref={shellRef}
      className={cn('flex flex-col transition-colors', isDragging && 'bg-active')}
      onDragEnter={(event) => {
        event.preventDefault()
        setIsDragging(true)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false)
      }}
      onDrop={onDrop}
    >
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
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(event) => updateDraft((current) => ({ ...current, text: event.target.value }))}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        readOnly={pendingDraftSessionStart}
        aria-label="What should the agent do?"
        placeholder="What should the agent do?"
        rows={3}
        className="thin-scrollbar mx-5 mt-3 min-h-[84px] resize-none overflow-y-auto bg-transparent text-[15px] leading-6 text-[var(--basis-text-strong)] placeholder:text-[var(--basis-text-faint)] focus:outline-none"
      />
      <ComposerImageStrip
        images={images}
        className="px-5 pt-2"
        onView={(id) => setViewingAttachment(viewable.findIndex((each) => each.id === id))}
        onRemove={removeAttachment}
      />
      {notice ? (
        <p role="alert" className="px-5 pt-2 text-[12px] leading-5 text-amber-500">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 px-5 pb-3 pt-3">
        {showModelControl ? (
          <ProviderModelPicker
            groups={providerModelGroups}
            currentProviderId={currentProviderId}
            currentModelId={currentModelId}
            onChange={onProviderModelChange}
            disabled={!canChangeSettings}
            canChangeProvider={canChangeProvider}
            shortcut="mod+shift+m"
            placement="below"
            onDone={focusTextarea}
            triggerClassName={propertyChip}
          />
        ) : null}
        <div className="[&_button]:h-7 [&_button]:rounded-md [&_button]:border [&_button]:border-[var(--basis-border-muted)] [&_button]:px-2 [&_button]:text-[12px]">
          <ModelSettingsControl
            options={configOptions}
            effort={effortControl}
            onChange={onConfigOptionChange}
            disabled={!canChangeSettings}
          />
        </div>
      </div>
      <footer className="flex items-center gap-2 border-t border-[var(--basis-border-muted)] px-3 py-2.5">
        <Tooltip content={imageSupportMessage ?? 'Attach images'}>
          <button
            type="button"
            aria-label="Attach images"
            onClick={() => fileInputRef.current?.click()}
            disabled={!imageUploadEnabled || starting}
            className={cn(iconButton, 'disabled:opacity-40 disabled:hover:bg-transparent')}
          >
            <PaperclipIcon className="h-4 w-4" />
          </button>
        </Tooltip>
        <DraftSyncIndicator store={draftStore} draftKey={draftKey} />
        <span className="ml-auto hidden items-center gap-1 text-[11px] text-[var(--basis-text-faint)] sm:flex">
          <CommandMenuShortcut keys="Esc" className="ml-0" /> save as draft
        </span>
        <button
          type="button"
          onClick={() => void send()}
          disabled={!sendActive}
          className="ml-2 inline-flex h-8 shrink-0 items-center gap-2 rounded-md bg-[var(--basis-action-bg)] px-3 text-[13px] font-medium text-[var(--basis-action-fg)] transition-colors hover:bg-[var(--basis-action-hover)] disabled:opacity-40 max-sm:ml-auto"
        >
          {starting ? <CircleNotchIcon className="h-3.5 w-3.5 animate-spin" /> : null}
          {starting ? 'Starting…' : 'Start agent'}
          {starting ? null : (
            <kbd
              aria-hidden
              className="rounded bg-[color-mix(in_srgb,currentColor_16%,transparent)] px-1 font-sans text-[11px] leading-4"
            >
              ⏎
            </kbd>
          )}
        </button>
      </footer>
    </div>
  )
}

function NoProjects({ onAddWorkspace }: { onAddWorkspace: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
      <p className="text-[13px] text-[var(--basis-text-muted)]">
        Add a project to start an agent in it.
      </p>
      <button
        type="button"
        onClick={onAddWorkspace}
        className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] text-[var(--basis-text)] transition-colors hover:bg-hover"
      >
        <FolderPlusIcon className="h-3.5 w-3.5" />
        Add project
      </button>
    </div>
  )
}
