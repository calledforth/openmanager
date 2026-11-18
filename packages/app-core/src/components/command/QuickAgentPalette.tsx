import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  ArrowsOutSimpleIcon,
  CaretRightIcon,
  CheckIcon,
  CircleNotchIcon,
  FileDashedIcon,
  FolderPlusIcon,
  ImageIcon,
  PaperclipIcon,
  PlusIcon,
  XIcon,
} from '@phosphor-icons/react'
import {
  hasDraftContent,
  selectDraftContent,
  selectDraftTarget,
  type EnvironmentClient,
} from '@openmanager/environment-client'
import { cn } from '../../lib/utils'
import { useAnchorBox, useNoticeAnchor } from '../../lib/notice-anchors'
import { spring } from '../fluid/lib/springs'
import {
  CommandMenu,
  CommandMenuEmpty,
  CommandMenuInput,
  CommandMenuItem,
  CommandMenuList,
  CommandMenuShortcut,
  matchesShortcut,
  parseShortcut,
  type CommandMenuItemData,
} from '../fluid/ui/command-menu'
import { useHoldFocus } from './pickerRegistry'
import { usePortaledMenu } from '../ui/usePortaledMenu'
import { EnvironmentPicker } from '../chat/EnvironmentPicker'
import { ProviderIcon } from '../providers/ProviderIcon'
import { selectSidebarDrafts, type SidebarDraft } from '../sidebar/sidebar-sessions'
import { DEFAULT_PROVIDER_ID } from '../../providers/draft-provider'
import { formatRelativeTime, useNow } from '../../lib/relative-time'
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
import {
  useSidebarData,
  useSidebarDrafts,
  type EnvironmentChoiceValue,
  type EnvironmentOption,
  type WorkspaceEntry,
} from '../../providers/sidebar-provider'
import { isNoProject } from '../../lib/no-project'
import type { EnvironmentDistro, EnvironmentPlatform } from '@openmanager/protocol'

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
  /** Where it runs, before the project; only on a host with several environments. */
  environment?: ReactNode
  /** The last step of the breadcrumb. @default "New agent" */
  title?: string
  /** The Drafts button, by Expand and Close. */
  drafts?: ReactNode
  /** Alt+] and Alt+[: the next or the previous draft. */
  onStepDraft?: (by: 1 | -1) => void
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
  environment,
  title = 'New agent',
  drafts,
  onStepDraft,
  onExpand,
  children,
}: QuickAgentPaletteViewProps) {
  const reduceMotion = useReducedMotion() ?? false
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onStepDraftRef = useRef(onStepDraft)
  onStepDraftRef.current = onStepDraft

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
            onKeyDown={(event) => {
              // By the key's place, not its character: Alt+[ types a quote on a Mac.
              if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
              if (event.code !== 'BracketRight' && event.code !== 'BracketLeft') return
              if (!onStepDraftRef.current) return
              event.preventDefault()
              onStepDraftRef.current(event.code === 'BracketRight' ? 1 : -1)
            }}
          >
            <header className="flex items-center gap-1 px-3 pt-3">
              <div className="flex min-w-0 flex-1 items-center gap-0.5 text-[13px]">
                {environment ? (
                  <>
                    {environment}
                    <CaretRightIcon
                      aria-hidden
                      weight="bold"
                      className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]"
                    />
                  </>
                ) : null}
                {project}
                <CaretRightIcon
                  aria-hidden
                  weight="bold"
                  className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]"
                />
                <span className="min-w-0 truncate px-1.5 text-[var(--basis-text-strong)]">
                  {title}
                </span>
              </div>
              {drafts}
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
                    Close, keeping it as a draft
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
  /** `message` says `message` and offers `action`; the others say what became of a draft. */
  kind: 'started' | 'saved' | 'message'
  /** The project's name, if it is known. */
  project?: string
  message?: string
  /** The button's words. @default "Open" */
  action?: string
  /** What the button does. Absent, a `message` is only said, with no button. */
  onOpen?: () => void
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
    notice.kind === 'message'
      ? (notice.message ?? '')
      : notice.kind === 'started'
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
      {/* A message is a sentence that has to be read whole: it wraps rather than
          trailing off. A project name is cut short instead. */}
      <span
        className={notice.kind === 'message' ? 'min-w-0 break-words py-1 pr-2' : 'truncate pr-2'}
      >
        {label}
      </span>
      {notice.onOpen ? (
        <button
          type="button"
          onClick={() => {
            notice.onOpen?.()
            onDismiss()
          }}
          className="h-7 shrink-0 rounded-md px-2 font-medium outline-none transition-colors duration-80 hover:bg-hover focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          {notice.action ?? 'Open'}
        </button>
      ) : null}
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
// The host: which draft the card shows, and on which environment.
// ---------------------------------------------------------------------------

/** The draft the card shows, and where. */
export interface QuickAgentOpen {
  /** The environment it is kept on; null on a host that names none. */
  environmentId: string | null
  draft: QuickAgentDraft
  /** The breadcrumb's last step: a draft picked from the list says what it is. */
  title?: string
}

/**
 * What a host with several environments lends the palette, so it can show
 * the drafts kept on each, move one to another, and open what is elsewhere.
 * Everything that opens goes through the address, wherever it is kept.
 */
export interface QuickAgentEnvironments {
  /** Every environment saved, in order. */
  environments: readonly EnvironmentOption[]
  clientOf: (environmentId: string) => EnvironmentClient | undefined
  carry: NonNullable<EnvironmentChoiceValue['carry']>
  openDraft: (environmentId: string, draftId: string) => void
  openSession: (environmentId: string, sessionId: string) => void
  /** That environment's new session page, in that project. */
  openNewSession: (environmentId: string, workspaceId: string) => void
}

interface QuickAgentHostValue {
  open: QuickAgentOpen | null
  setOpen: Dispatch<SetStateAction<QuickAgentOpen | null>>
  show: (notice: Omit<QuickAgentNoticeData, 'key'>) => void
  /** Closes the card as Escape would; set by the palette that shows it. */
  closer: MutableRefObject<(() => void) | null>
  /** The draft on the page, if one is: it is the page's, not the card's to open. */
  pageDraft: MutableRefObject<{ environmentId: string | null; draftId: string } | null>
  /** Start another: Enter leaves a fresh card, in the same project. */
  startAnother: boolean
  setStartAnother: (next: boolean) => void
  environments: QuickAgentEnvironments | null
}

const QuickAgentHostContext = createContext<QuickAgentHostValue | null>(null)

const START_ANOTHER_KEY = 'openmanager.quick-agent.start-another'

function readStartAnother() {
  try {
    return globalThis.localStorage?.getItem(START_ANOTHER_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Holds the card's draft above any one environment's providers, so the card
 * can move between environments while the page stays where it is: the host
 * mounts the palette of the environment the card is on (`useQuickAgentOpen`).
 * The notices are said here, so they outlive the card. Without a host the
 * palette keeps its own, on its one environment.
 */
export function QuickAgentHost({
  environments = null,
  children,
}: {
  environments?: QuickAgentEnvironments | null
  children: ReactNode
}) {
  const [open, setOpen] = useState<QuickAgentOpen | null>(null)
  const [notice, setNotice] = useState<QuickAgentNoticeData | null>(null)
  const [startAnother, setStartAnotherState] = useState(readStartAnother)
  const noticeKey = useRef(0)
  const closer = useRef<(() => void) | null>(null)
  const pageDraft = useRef<{ environmentId: string | null; draftId: string } | null>(null)
  const show = useCallback((next: Omit<QuickAgentNoticeData, 'key'>) => {
    noticeKey.current += 1
    setNotice({ ...next, key: noticeKey.current })
  }, [])
  const setStartAnother = useCallback((next: boolean) => {
    setStartAnotherState(next)
    try {
      globalThis.localStorage?.setItem(START_ANOTHER_KEY, next ? '1' : '0')
    } catch {
      // Kept for this page only.
    }
  }, [])
  const dismissNotice = useCallback(
    (key: number) => setNotice((current) => (current?.key === key ? null : current)),
    [],
  )
  const value = useMemo<QuickAgentHostValue>(
    () => ({
      open,
      setOpen,
      show,
      closer,
      pageDraft,
      startAnother,
      setStartAnother,
      environments,
    }),
    [environments, open, setStartAnother, show, startAnother],
  )
  return (
    <QuickAgentHostContext.Provider value={value}>
      {children}
      <QuickAgentNoticeView notice={notice} onDismiss={dismissNotice} />
    </QuickAgentHostContext.Provider>
  )
}

/** The draft the card shows and its environment; null while it is closed. */
export function useQuickAgentOpen(): QuickAgentOpen | null {
  return useContext(QuickAgentHostContext)?.open ?? null
}

// ---------------------------------------------------------------------------
// The drafts list: every environment's, read live while the card is up.
// ---------------------------------------------------------------------------

interface DraftSource {
  environmentId: string | null
  label?: string
  /** Can be written to now; the one the card is on always can. */
  reachable: boolean
  client: EnvironmentClient
}

interface QuickDraftCard extends SidebarDraft {
  /** Where it is kept: its source's. */
  sourceId: string | null
  projectName?: string
}

interface DraftGroup {
  environmentId: string | null
  label?: string
  reachable: boolean
  drafts: readonly QuickDraftCard[]
}

const NO_GROUPS: readonly DraftGroup[] = []
const NO_SUBSCRIPTION = () => () => undefined

/**
 * Each source's drafts, newest first, as the sidebar lists them, less the
 * ones being sent. Read only while `enabled`, and recomputed for a source
 * only when its drafts, sessions or projects change, not for a streamed token.
 */
function useDraftGroups(sources: readonly DraftSource[], enabled: boolean) {
  const cache = useRef(
    new WeakMap<EnvironmentClient, { inputs: readonly unknown[]; drafts: QuickDraftCard[] }>(),
  )
  const last = useRef(NO_GROUPS)
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled) return () => undefined
      const leave = sources.map((source) => source.client.subscribe(listener))
      return () => {
        for (const stop of leave) stop()
      }
    },
    [enabled, sources],
  )
  const read = useCallback(() => {
    if (!enabled) return NO_GROUPS
    const groups = sources.map((source): DraftGroup => {
      const state = source.client.getState()
      const inputs = [state.drafts, state.draftEdits, state.sessions, state.workspaces]
      let entry = cache.current.get(source.client)
      if (!entry || !entry.inputs.every((input, index) => input === inputs[index])) {
        const drafts = selectSidebarDrafts(state, null, null, DEFAULT_PROVIDER_ID)
          .cards.filter((card) => !card.sending)
          .map((card) => {
            const projectName = card.workspaceId
              ? state.workspaces[card.workspaceId]?.name
              : undefined
            return {
              ...card,
              sourceId: source.environmentId,
              ...(projectName ? { projectName } : {}),
            }
          })
        entry = { inputs, drafts }
        cache.current.set(source.client, entry)
      }
      return {
        environmentId: source.environmentId,
        ...(source.label ? { label: source.label } : {}),
        reachable: source.reachable,
        drafts: entry.drafts,
      }
    })
    const previous = last.current
    const same =
      previous.length === groups.length &&
      groups.every((group, index) => {
        const before = previous[index]!
        return (
          before.environmentId === group.environmentId &&
          before.label === group.label &&
          before.reachable === group.reachable &&
          before.drafts === group.drafts
        )
      })
    if (!same) last.current = groups
    return last.current
  }, [enabled, sources])
  return useSyncExternalStore(enabled ? subscribe : NO_SUBSCRIPTION, read, read)
}

// ---------------------------------------------------------------------------
// Bound to the environment.
// ---------------------------------------------------------------------------

const NO_WORKSPACES: WorkspaceEntry[] = []

/** A project an agent can start in now. */
const hostable = (workspace: WorkspaceEntry | undefined): workspace is WorkspaceEntry =>
  !!workspace && !workspace.missing

/** One of the user's own projects an agent can start in now: not "No project". */
const hostableProject = (workspace: WorkspaceEntry | undefined): workspace is WorkspaceEntry =>
  hostable(workspace) && !isNoProject(workspace)

export interface QuickAgentPaletteProps {
  /**
   * The environment these providers are for, on a host with several: the
   * card shows here only while its draft is kept here.
   */
  environmentId?: string
  /**
   * The page's own palette, which takes the shortcuts and the command
   * palette's New agent. A host mounts others, for a card moved to another
   * environment, with this off. @default true
   */
  primary?: boolean
}

/**
 * Start an agent without leaving the chat you are in: ⌘⇧O (or N outside a
 * field) opens a composer over the page. Enter starts the agent in the
 * background and says so; Escape keeps what was written as a draft, in the
 * sidebar with the rest. It is the page's composer and the page's drafts,
 * only not on a page: images, models and slash commands work as they do
 * there, and ⤢ carries the draft onto its own page.
 *
 * Drafts switches the card to another draft, kept here or, under a
 * `QuickAgentHost` with several environments, on another one; the
 * environment chip moves the card's draft to another environment.
 *
 * Render inside the environment providers. Where the environment keeps no
 * drafts there is nothing to keep an unsent agent in, so it does not mount.
 */
export function QuickAgentPalette(props: QuickAgentPaletteProps) {
  const client = useEnvironmentClient()
  const host = useContext(QuickAgentHostContext)
  if (!client.drafts) return null
  if (!host) {
    return (
      <QuickAgentHost>
        <QuickAgentPaletteBound {...props} />
      </QuickAgentHost>
    )
  }
  return <QuickAgentPaletteBound {...props} />
}

function QuickAgentPaletteBound({ environmentId, primary = true }: QuickAgentPaletteProps) {
  const client = useEnvironmentClient()
  const sync = client.drafts!
  const host = useContext(QuickAgentHostContext)!
  const { open: opened, setOpen, show, closer, pageDraft, environments: elsewhere } = host
  const here = environmentId ?? null
  const {
    workspaces,
    recentWorkspaces = NO_WORKSPACES,
    activeWorkspacePath,
    environment,
    addWorkspace,
  } = useSidebarData()
  const { selectSession, createSession } = useSessionState()
  const navigation = useContext(DraftPageNavigationContext)
  const pageDrafts = useSidebarDrafts()
  const mine = opened && opened.environmentId === here ? opened : null
  const draft = mine?.draft ?? null

  const live = useRef({
    workspaces,
    recentWorkspaces,
    activeWorkspacePath,
    draft,
    opened,
    startAnother: host.startAnother,
  })
  live.current = {
    workspaces,
    recentWorkspaces,
    activeWorkspacePath,
    draft,
    opened,
    startAnother: host.startAnother,
  }

  // The draft on the page is the page's: the card does not offer it.
  const pageDraftId = primary ? (pageDrafts?.openDraftId ?? null) : undefined
  useEffect(() => {
    if (pageDraftId === undefined) return
    pageDraft.current = pageDraftId ? { environmentId: here, draftId: pageDraftId } : null
  }, [here, pageDraft, pageDraftId])

  const nameOf = useCallback(
    (workspaceId: string | null) =>
      workspaceId
        ? live.current.workspaces.find((workspace) => workspace.path === workspaceId)?.name
        : undefined,
    [],
  )

  /** Where a new agent starts: where you are, else where you last worked. */
  const defaultWorkspace = useCallback(() => {
    const { workspaces, recentWorkspaces, activeWorkspacePath } = live.current
    // "No project" only when you are in it or there is no project at all.
    return (
      (hostable(workspaces.find((workspace) => workspace.path === activeWorkspacePath))
        ? activeWorkspacePath
        : null) ??
      recentWorkspaces.find(hostableProject)?.path ??
      workspaces.find(hostableProject)?.path ??
      workspaces.find(hostable)?.path ??
      null
    )
  }, [])

  const open = useCallback(() => {
    if (live.current.opened) return
    setOpen({ environmentId: here, draft: mintQuickAgentDraft(defaultWorkspace()) })
  }, [defaultWorkspace, here, setOpen])

  // The page's own palette opens drafts and sessions as the page does; one
  // the host mounted for another environment goes through the address.
  const openDraftPage = useCallback(
    (draftId: string) => {
      if (!primary && elsewhere && here) elsewhere.openDraft(here, draftId)
      else navigation?.openDraftPage(draftId)
    },
    [elsewhere, here, navigation, primary],
  )
  const openSession = useCallback(
    (workspaceId: string, sessionId: string) => {
      if (!primary && elsewhere && here) elsewhere.openSession(here, sessionId)
      else selectSession(workspaceId, sessionId)
    },
    [elsewhere, here, primary, selectSession],
  )

  /** Closed without sending: what was written stays, as a draft. */
  const close = useCallback(() => {
    const current = live.current.draft
    if (!current) return
    setOpen(null)
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
      onOpen: () => openDraftPage(current.draftId),
    })
  }, [client, nameOf, openDraftPage, setOpen, show, sync])

  // Whichever palette shows the card closes it for the shortcut.
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!mine) return
    const closeHere = () => closeRef.current()
    closer.current = closeHere
    return () => {
      if (closer.current === closeHere) closer.current = null
    }
  }, [closer, mine])

  const toggle = useCallback(() => {
    if (!live.current.opened) return open()
    // Its palette went with its environment: nothing is left to save from here.
    if (closer.current) closer.current()
    else setOpen(null)
  }, [closer, open, setOpen])

  useQuickAgentShortcuts(toggle, open, primary)
  useRegisterQuickAgent(open, primary)

  const onStarted = useCallback(
    (started: QuickAgentStarted) => {
      // Only the card that sent it: a send that finishes after the card was
      // closed and opened again leaves the new one alone. Start another
      // leaves a fresh card in the same project.
      setOpen((current) =>
        current?.draft.draftId === started.draftId
          ? live.current.startAnother
            ? { environmentId: here, draft: mintQuickAgentDraft(started.workspaceId) }
            : null
          : current,
      )
      show({
        kind: 'started',
        project: nameOf(started.workspaceId),
        onOpen: () => openSession(started.workspaceId, started.sessionId),
      })
    },
    [here, nameOf, openSession, setOpen, show],
  )

  const onWorkspaceChange = useCallback(
    (workspaceId: string) =>
      setOpen((current) =>
        current && current.environmentId === here
          ? { ...current, draft: { ...current.draft, workspaceId } }
          : current,
      ),
    [here, setOpen],
  )

  /** Carry the draft onto its own page, as it stands. */
  const expand = useCallback(() => {
    const current = live.current.draft
    if (!current) return
    setOpen(null)
    const state = client.getState()
    if (hasDraftContent(selectDraftContent(state, current.draftId))) {
      openDraftPage(current.draftId)
      return
    }
    // Nothing written yet: a blank page in the same project.
    if (!current.workspaceId) return
    if (!primary && elsewhere && here) elsewhere.openNewSession(here, current.workspaceId)
    else void createSession(current.workspaceId)
  }, [client, createSession, elsewhere, here, openDraftPage, primary, setOpen])

  // The drafts the card can switch to: this environment's, then the others'.
  const several = !!elsewhere && elsewhere.environments.length > 1 && here !== null
  const sources = useMemo<readonly DraftSource[]>(() => {
    if (!several || !elsewhere) return [{ environmentId: here, reachable: true, client }]
    return elsewhere.environments.flatMap((option): DraftSource[] => {
      const own = option.environmentId === here
      const source = own ? client : elsewhere.clientOf(option.environmentId)
      if (!source?.drafts) return []
      return [
        {
          environmentId: option.environmentId,
          label: option.label,
          reachable: own || option.reachable,
          client: source,
        },
      ]
    })
  }, [client, elsewhere, here, several])
  const groups = useDraftGroups(sources, mine !== null)
  // This environment's first: what is nearest comes first.
  const ordered = useMemo(
    () => [
      ...groups.filter((group) => group.environmentId === here),
      ...groups.filter((group) => group.environmentId !== here),
    ],
    [groups, here],
  )
  const steps = useMemo(() => {
    const page = pageDraft.current
    return ordered.flatMap((group) =>
      group.reachable
        ? group.drafts.filter(
            (card) =>
              !(page && page.environmentId === card.sourceId && page.draftId === card.draftId),
          )
        : [],
    )
    // `pageDraft` is read as the list is built: it moves only with the page.
  }, [ordered, pageDraft])

  const switchTo = useCallback(
    (card: QuickDraftCard) => {
      const current = live.current.draft
      if (current?.draftId === card.draftId && card.sourceId === here) return
      // What was written stays, as it is: saved now, as Escape would.
      if (current && hasDraftContent(selectDraftContent(client.getState(), current.draftId))) {
        void sync.flush()
      }
      setOpen({
        environmentId: card.sourceId,
        draft: { draftId: card.draftId, sessionId: card.sessionId, workspaceId: card.workspaceId },
        ...(card.preview ? { title: card.preview } : {}),
      })
    },
    [client, here, setOpen, sync],
  )

  const newDraft = useCallback(() => {
    const current = live.current.draft
    if (current && hasDraftContent(selectDraftContent(client.getState(), current.draftId))) {
      void sync.flush()
    }
    setOpen({
      environmentId: here,
      draft: mintQuickAgentDraft(current?.workspaceId ?? defaultWorkspace()),
    })
  }, [client, defaultWorkspace, here, setOpen, sync])

  const stepDraft = useCallback(
    (by: 1 | -1) => {
      const current = live.current.draft
      if (steps.length === 0) return
      const at = steps.findIndex(
        (card) => card.draftId === current?.draftId && card.sourceId === here,
      )
      const next =
        at === -1
          ? by === 1
            ? steps[0]
            : steps.at(-1)
          : steps[(at + by + steps.length) % steps.length]
      if (next) switchTo(next)
    },
    [here, steps, switchTo],
  )

  /** Move the card's draft to another environment: its text goes, the page stays. */
  const moveTo = useCallback(
    (environmentId: string) => {
      const current = live.current.draft
      if (!current || !elsewhere || !here || environmentId === here) return
      void sync.flush()
      const next = elsewhere.carry(environmentId, { draftId: current.draftId, environmentId: here })
      if (next) setOpen({ environmentId, draft: next })
    },
    [elsewhere, here, setOpen, sync],
  )

  // "No project" is somewhere to start too, so only its absence leaves nothing.
  const noProjects = workspaces.length === 0
  if (!draft) {
    return (
      <QuickAgentPaletteView open={false} onClose={close} project={null}>
        {null}
      </QuickAgentPaletteView>
    )
  }
  return (
    <QuickAgentScope
      key={draft.draftId}
      draft={draft}
      onWorkspaceChange={onWorkspaceChange}
      onStarted={onStarted}
    >
      <QuickAgentPaletteContent
        draft={draft}
        title={mine?.title}
        noProjects={noProjects}
        workspaces={workspaces}
        recentWorkspaces={recentWorkspaces}
        environmentLabel={environment?.label}
        environmentPlatform={environment?.platform}
        environmentDistro={environment?.distro}
        environmentPicker={
          several && elsewhere && here ? (
            <EnvironmentPicker
              variant="chip"
              environments={elsewhere.environments}
              selectedId={here}
              onSelect={moveTo}
            />
          ) : undefined
        }
        draftsMenu={
          <QuickAgentDraftsMenu
            groups={ordered}
            several={several}
            current={{ environmentId: here, draftId: draft.draftId }}
            pageDraft={pageDraft.current}
            onPick={switchTo}
            onNew={newDraft}
          />
        }
        onStepDraft={stepDraft}
        onClose={close}
        onExpand={navigation || elsewhere ? expand : undefined}
        onAddWorkspace={() => {
          setOpen(null)
          void addWorkspace()
        }}
      />
    </QuickAgentScope>
  )
}

/** The palette inside its draft's scope, where session state is the draft's. */
function QuickAgentPaletteContent({
  draft,
  title,
  noProjects,
  workspaces,
  recentWorkspaces,
  environmentLabel,
  environmentPlatform,
  environmentDistro,
  environmentPicker,
  draftsMenu,
  onStepDraft,
  onClose,
  onExpand,
  onAddWorkspace,
}: {
  draft: QuickAgentDraft
  title?: string
  noProjects: boolean
  workspaces: WorkspaceEntry[]
  recentWorkspaces: WorkspaceEntry[]
  environmentLabel?: string
  environmentPlatform?: EnvironmentPlatform
  environmentDistro?: EnvironmentDistro
  environmentPicker?: ReactNode
  draftsMenu?: ReactNode
  onStepDraft?: (by: 1 | -1) => void
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
      environment={environmentPicker}
      {...(title ? { title } : {})}
      drafts={draftsMenu}
      {...(onStepDraft ? { onStepDraft } : {})}
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
            environmentPlatform={environmentPlatform}
            environmentDistro={environmentDistro}
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

// ---------------------------------------------------------------------------
// The Drafts menu, after Linear's: switch the card to another draft.
// ---------------------------------------------------------------------------

const DRAFTS_MENU_WIDTH = 380
const NEW_DRAFT = 'new-draft'
const keyOf = (environmentId: string | null, draftId: string) => `${environmentId ?? ''}:${draftId}`

function QuickAgentDraftsMenu({
  groups,
  several,
  current,
  pageDraft,
  onPick,
  onNew,
}: {
  groups: readonly DraftGroup[]
  /** Headed by environment, on a host with several. */
  several: boolean
  current: { environmentId: string | null; draftId: string }
  pageDraft: { environmentId: string | null; draftId: string } | null
  onPick: (card: QuickDraftCard) => void
  onNew: () => void
}) {
  const [query, setQuery] = useState('')
  const { open, toggle, close, menuCoords, wrapRef, triggerRef, menuRef } = usePortaledMenu({
    placement: 'below',
    minWidth: DRAFTS_MENU_WIDTH,
    align: 'end',
  })
  const now = useNow()
  const searchRef = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (open && menuCoords) searchRef.current?.focus()
  }, [open, menuCoords])
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])
  const releaseFocus = useHoldFocus(open, menuRef, searchRef)

  const listed = useMemo(
    () =>
      groups.map((group) => ({
        ...group,
        drafts: group.drafts.filter(
          (card) =>
            !(
              pageDraft &&
              pageDraft.environmentId === card.sourceId &&
              pageDraft.draftId === card.draftId
            ),
        ),
      })),
    [groups, pageDraft],
  )
  const cards = useMemo(() => {
    const byKey = new Map<string, QuickDraftCard>()
    for (const group of listed) {
      for (const card of group.drafts) byKey.set(keyOf(card.sourceId, card.draftId), card)
    }
    return byKey
  }, [listed])
  const currentKey = keyOf(current.environmentId, current.draftId)
  // The card's own draft is listed (checked) but not counted: it is here already.
  const others = [...cards.keys()].filter((key) => key !== currentKey).length

  const items = useMemo<CommandMenuItemData[]>(
    () => [
      { value: NEW_DRAFT, label: 'New draft', keywords: ['new', 'blank', 'agent'] },
      ...listed.flatMap((group) =>
        group.drafts.map((card) => ({
          value: keyOf(card.sourceId, card.draftId),
          label: card.preview || 'Images only',
          ...(card.projectName ? { description: card.projectName } : {}),
          keywords: [card.projectName, group.label].filter((word): word is string => !!word),
          ...(several && group.label ? { group: `On ${group.label}` } : {}),
          ...(group.reachable ? {} : { disabled: true }),
        })),
      ),
    ],
    [listed, several],
  )

  if (others === 0) return null

  const dismiss = () => {
    releaseFocus()
    close()
    triggerRef.current?.focus()
  }
  const pick = (value: string) => {
    releaseFocus()
    close()
    if (value === NEW_DRAFT) return onNew()
    const card = cards.get(value)
    if (card) onPick(card)
  }

  const menu =
    open &&
    menuCoords &&
    createPortal(
      <div
        ref={menuRef}
        role="dialog"
        aria-label="Switch to a draft"
        className="fixed z-[200] flex max-h-[min(440px,60vh)] flex-col overflow-hidden rounded-float bg-float text-left shadow-float"
        style={{ left: menuCoords.left, top: menuCoords.top, width: menuCoords.width }}
      >
        <CommandMenu
          items={items}
          query={query}
          onQueryChange={setQuery}
          onSelect={(item) => pick(item.value)}
          defaultHighlight={cards.has(currentKey) ? currentKey : NEW_DRAFT}
        >
          {/* No bar at rest: the field holds the keys (arrows, Enter, typing to
              filter) and shows only once something is typed, as a slim line. */}
          <div
            className={
              query
                ? 'border-b border-[var(--basis-border-muted)] [&_[data-slot=command-menu-input]]:h-8 [&_[data-slot=command-menu-input]]:px-3'
                : 'sr-only'
            }
          >
            <CommandMenuInput
              ref={searchRef}
              icon={null}
              aria-label="Switch to a draft"
              placeholder="Filter drafts…"
              className="text-[12.5px]"
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                dismiss()
              }}
            />
          </div>
          <CommandMenuList
            className="gap-0 p-1.5"
            renderItem={(item) =>
              item.value === NEW_DRAFT ? (
                <CommandMenuItem
                  value={item.value}
                  className="h-9 gap-2.5 px-2.5 text-[13px] text-foreground"
                >
                  <PlusIcon aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1">New draft</span>
                </CommandMenuItem>
              ) : (
                <DraftRow
                  item={item}
                  card={cards.get(item.value)}
                  active={item.value === currentKey}
                  now={now}
                />
              )
            }
          >
            <CommandMenuEmpty>No drafts</CommandMenuEmpty>
          </CommandMenuList>
        </CommandMenu>
      </div>,
      document.body,
    )

  return (
    <div ref={wrapRef} className="relative inline-flex shrink-0">
      <Tooltip
        content={
          <span className="flex items-center gap-2">
            Switch draft
            <CommandMenuShortcut keys="alt+]" className="ml-0" />
          </span>
        }
        side="bottom"
      >
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Drafts: ${others} more`}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1.5 text-[12px] text-[var(--basis-text-muted)] outline-none transition-colors duration-80 hover:bg-hover hover:text-[var(--basis-text)] focus-visible:ring-1 focus-visible:ring-focus-ring',
            open && 'bg-hover text-[var(--basis-text)]',
          )}
        >
          <FileDashedIcon aria-hidden className="h-3.5 w-3.5" />
          Drafts
          <span className="min-w-4 rounded bg-[color-mix(in_srgb,var(--basis-text)_8%,transparent)] px-1 text-center font-mono text-[10.5px] leading-4 text-[var(--basis-text)]">
            {others}
          </span>
        </button>
      </Tooltip>
      {menu}
    </div>
  )
}

function DraftRow({
  item,
  card,
  active,
  now,
}: {
  item: CommandMenuItemData
  card: QuickDraftCard | undefined
  active: boolean
  now: number
}) {
  return (
    <CommandMenuItem value={item.value} className="h-auto min-h-11 gap-2.5 px-2.5 py-1.5">
      <span className="flex w-3.5 shrink-0 justify-center">
        {active ? (
          <CheckIcon aria-label="This draft" size={14} weight="bold" className="text-foreground" />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            'truncate text-[13px]',
            card?.preview ? 'text-foreground' : 'italic text-muted-foreground',
          )}
        >
          {item.label}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {card ? <ProviderIcon providerId={card.providerId} className="h-3 w-3" /> : null}
          <span className="truncate">{card?.projectName ?? 'No project'}</span>
          {card && card.imageCount > 0 ? (
            <span className="flex shrink-0 items-center gap-0.5">
              <ImageIcon aria-hidden className="h-3 w-3" />
              {card.imageCount}
            </span>
          ) : null}
          {item.disabled ? <span className="shrink-0">· Not connected</span> : null}
        </span>
      </span>
      {card ? (
        <span className="shrink-0 self-start pt-0.5 text-[11px] text-[var(--basis-text-faint)]">
          {formatRelativeTime(new Date(card.editedAt).toISOString(), now)}
        </span>
      ) : null}
    </CommandMenuItem>
  )
}

/** Linear's property pill: no outline, a faint fill, a little more when pointed at. */
const propertyChip =
  'h-7 rounded-md border-0 bg-[color-mix(in_srgb,var(--basis-text)_5%,transparent)] px-2 text-[12px] text-[var(--basis-text)] hover:bg-[color-mix(in_srgb,var(--basis-text)_9%,transparent)]'

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
      {/* One row under the ask: attach, the model and its settings, then Start.
          No rule above it: the space under the text is the break, as in Linear's. */}
      <footer className="flex flex-wrap items-center gap-1.5 px-3 pb-3 pt-3">
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
        <div className="flex items-center gap-1.5 [&_button]:h-7 [&_button]:rounded-md [&_button]:border-0 [&_button]:bg-[color-mix(in_srgb,var(--basis-text)_5%,transparent)] [&_button]:px-2 [&_button]:text-[12px] [&_button:hover]:bg-[color-mix(in_srgb,var(--basis-text)_9%,transparent)]">
          <ModelSettingsControl
            options={configOptions}
            effort={effortControl}
            onChange={onConfigOptionChange}
            disabled={!canChangeSettings}
          />
        </div>
        <DraftSyncIndicator store={draftStore} draftKey={draftKey} />
        <StartAnotherSwitch />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!sendActive}
          className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-md bg-[var(--basis-action-bg)] pl-2.5 pr-1.5 text-[12px] font-medium text-[var(--basis-action-fg)] transition-colors hover:bg-[var(--basis-action-hover)] disabled:opacity-40"
        >
          {starting ? <CircleNotchIcon className="h-3 w-3 animate-spin" /> : null}
          {starting ? 'Starting…' : 'Start'}
          {starting ? null : (
            <kbd
              aria-hidden
              className="rounded bg-[color-mix(in_srgb,currentColor_16%,transparent)] px-1 font-sans text-[10.5px] leading-4"
            >
              ⏎
            </kbd>
          )}
        </button>
      </footer>
    </div>
  )
}

/** Linear's Create more: Enter starts the agent and leaves a fresh card. */
function StartAnotherSwitch() {
  const host = useContext(QuickAgentHostContext)
  if (!host) return null
  const { startAnother, setStartAnother } = host
  return (
    <Tooltip content="Keep the card open for the next agent">
      <button
        type="button"
        role="switch"
        aria-checked={startAnother}
        onClick={() => setStartAnother(!startAnother)}
        className="ml-auto mr-1 inline-flex h-7 shrink-0 items-center gap-2 rounded-md px-1.5 text-[12px] text-[var(--basis-text-muted)] outline-none transition-colors duration-80 hover:text-[var(--basis-text)] focus-visible:ring-1 focus-visible:ring-focus-ring"
      >
        <span
          aria-hidden
          className={cn(
            'relative h-3.5 w-6 rounded-full transition-colors duration-150',
            startAnother
              ? 'bg-[var(--basis-action-bg)]'
              : 'bg-[color-mix(in_srgb,var(--basis-text)_14%,transparent)]',
          )}
        >
          <span
            className={cn(
              'absolute left-0.5 top-0.5 h-2.5 w-2.5 rounded-full transition-transform duration-150',
              startAnother
                ? 'translate-x-2.5 bg-[var(--basis-action-fg)]'
                : 'bg-[var(--basis-text-muted)]',
            )}
          />
        </span>
        Start another
      </button>
    </Tooltip>
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
