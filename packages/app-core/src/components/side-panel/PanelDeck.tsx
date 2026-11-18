import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { SquaresFourIcon, type Icon } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { spring } from '../fluid/lib/springs'
import { Tooltip } from '../fluid/ui/tooltip'
import { Kbd } from './Kbd'

// ---------------------------------------------------------------------------
// The right panel as a deck of views, Linear's way: a home that lists what
// the panel can show, each with its own bare key, and a switcher in the
// header that keeps every view one key or one click away.
//
//   <PanelDeck views={[prs, scratchpad]} current={view} onNavigate={setView}
//              active={panelOpen} />
//
// Keys answer only while the panel shows and nobody is typing: a view's key
// (P, S, …) opens it, Esc steps back (a view's own drill-down first, then
// home), and J/K/↑/↓/↵ move through the home list. A view takes keys of its
// own with usePanelKeys(); it sees them before the deck does.
// ---------------------------------------------------------------------------

export type PanelAttention = 'notice' | 'alert'

export interface PanelView {
  id: string
  /** The bare key that opens it, lower case ("p"). */
  shortcut: string
  label: string
  icon: Icon
  /** One line under the label on the home view: what is in it right now. */
  summary?: ReactNode
  /** A dot on the switcher and the home row: something new (notice) or wrong (alert). */
  attention?: PanelAttention | null
  /** Trailing count on the home row. */
  count?: number | null
  content: ReactNode
}

export interface PanelDeckProps {
  views: readonly PanelView[]
  /** The view showing; null is home. */
  current: string | null
  onNavigate: (id: string | null) => void
  /** Whether keys answer: true while the panel is showing. */
  active: boolean
  className?: string
}

type KeyHandler = (event: KeyboardEvent) => boolean

/** A view's key handler, and which view registered it (undefined: no deck). */
interface KeyEntry {
  handler: { current: KeyHandler }
  scope: string | undefined
}

interface DeckContextValue {
  register: (entry: KeyEntry) => () => void
  back: () => void
  active: boolean
}

const DeckContext = createContext<DeckContextValue | null>(null)
/** The view a subtree belongs to, so a view still animating out takes no keys. */
const ViewScopeContext = createContext<string | undefined>(undefined)

/**
 * Keys for the view showing. Return true from the handler to take the key
 * (the deck then does nothing with it). Typing in a field never reaches it.
 */
export function usePanelKeys(handler: KeyHandler) {
  const deck = useContext(DeckContext)
  const scope = useContext(ViewScopeContext)
  const ref = useRef(handler)
  useLayoutEffect(() => {
    ref.current = handler
  })
  const register = deck?.register
  useEffect(() => register?.({ handler: ref, scope }), [register, scope])
}

/**
 * Whether a key press is the panel's to take: no modifier, nobody typing,
 * no other dialog or menu holding the keyboard, and not Enter or Space on a
 * focused control, which belong to that control.
 */
function panelMayTake(event: KeyboardEvent, root: HTMLElement | null): boolean {
  if (event.defaultPrevented || event.isComposing) return false
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  if (isTypingTarget(event.target)) return false
  const target = event.target as HTMLElement | null
  const modal = target?.closest?.('[role="dialog"],[role="menu"],[role="alertdialog"]')
  if (modal && root && !modal.contains(root)) return false
  if (
    (event.key === 'Enter' || event.key === ' ') &&
    target?.closest?.(
      'button,a[href],[role="button"],[role="switch"],[role="radio"],[role="option"]',
    )
  )
    return false
  return true
}

/** Offers a key to the handlers, newest first, keeping only those of `scope`. */
function offer(entries: readonly KeyEntry[], scope: string | undefined, event: KeyboardEvent) {
  for (const entry of [...entries].reverse()) {
    if (entry.scope !== undefined && entry.scope !== scope) continue
    if (entry.handler.current(event)) {
      event.preventDefault()
      return true
    }
  }
  return false
}

/**
 * Panel keys for a single view shown without a deck (the web app's pull
 * request panel): its usePanelKeys handlers answer while `active`.
 */
export function PanelKeys({ active, children }: { active: boolean; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const entries = useRef<KeyEntry[]>([])
  const register = useCallback((entry: KeyEntry) => {
    entries.current.push(entry)
    return () => {
      entries.current = entries.current.filter((item) => item !== entry)
    }
  }, [])
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (panelMayTake(event, rootRef.current)) offer(entries.current, undefined, event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active])
  const value = useMemo<DeckContextValue>(
    () => ({ register, back: () => undefined, active }),
    [register, active],
  )
  return (
    <DeckContext.Provider value={value}>
      <div ref={rootRef} className="contents">
        {children}
      </div>
    </DeckContext.Provider>
  )
}

/** Step back out of the view (to home). For a view's own back button. */
export function usePanelDeck(): { back: () => void; active: boolean } {
  const deck = useContext(DeckContext)
  return { back: deck?.back ?? (() => undefined), active: deck?.active ?? false }
}

// Red is kept for what is wrong; something merely new is a quiet grey dot.
const ATTENTION_COLOR: Record<PanelAttention, string> = {
  notice: 'var(--basis-text-muted)',
  alert: 'var(--basis-status-error)',
}

/** The row under the switcher every view starts with: its name, then its own controls. */
export function PanelSubheader({
  title,
  meta,
  children,
  className,
}: {
  title?: ReactNode
  /** Muted, after the title: a count, the project. */
  meta?: ReactNode
  /** Right-aligned controls. */
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex h-9 shrink-0 items-center gap-2 px-4', className)}>
      {title ? (
        <h2 className="flex min-w-0 items-center gap-1.5 truncate text-12-medium text-[var(--basis-text-strong)]">
          {title}
          {meta ? (
            <span className="flex min-w-0 items-center gap-1.5 truncate text-12-regular text-[var(--basis-text-muted)]">
              {meta}
            </span>
          ) : null}
        </h2>
      ) : null}
      <span className="flex-1" />
      {children}
    </div>
  )
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  )
}

const HOME_SCOPE = '__home'

export function PanelDeck({ views, current, onNavigate, active, className }: PanelDeckProps) {
  const reduceMotion = useReducedMotion()
  const rootRef = useRef<HTMLElement>(null)
  const entries = useRef<KeyEntry[]>([])
  const shown = views.find((view) => view.id === current) ?? null
  const shownId = shown?.id ?? null

  // Which way the content moves: deeper slides in from the right, back to
  // home from the left, and between views by their order in the switcher.
  const order = (id: string | null) => (id === null ? -1 : views.findIndex((v) => v.id === id))
  const previous = useRef<string | null>(shownId)
  const direction = order(shownId) >= order(previous.current) ? 1 : -1
  useEffect(() => {
    previous.current = shownId
  }, [shownId])

  const [highlight, setHighlight] = useState(0)

  const register = useCallback((entry: KeyEntry) => {
    entries.current.push(entry)
    return () => {
      entries.current = entries.current.filter((item) => item !== entry)
    }
  }, [])
  const back = useCallback(() => onNavigate(null), [onNavigate])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!panelMayTake(event, rootRef.current)) return
      // The view showing first (not one still animating out), newest first.
      if (offer(entries.current, shownId ?? HOME_SCOPE, event)) return
      const key = event.key.toLowerCase()
      const target_ = views.find((view) => view.shortcut.toLowerCase() === key)
      if (target_ && !event.shiftKey) {
        event.preventDefault()
        onNavigate(target_.id)
        return
      }
      if (event.key === 'Escape' && shownId !== null) {
        event.preventDefault()
        onNavigate(null)
        return
      }
      if (shownId !== null || views.length === 0) return
      // Home: move through the cards and open one.
      if (key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((index) => Math.min(views.length - 1, index + 1))
      } else if (key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((index) => Math.max(0, index - 1))
      } else if (event.key === 'Enter') {
        const view = views[Math.min(highlight, views.length - 1)]
        if (view) {
          event.preventDefault()
          onNavigate(view.id)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, views, shownId, onNavigate, highlight])

  const offset = reduceMotion ? 0 : 12
  return (
    <DeckContext.Provider value={{ register, back, active }}>
      <section
        ref={rootRef}
        aria-label="Side panel"
        className={cn('flex h-full min-h-0 min-w-0 flex-col text-[var(--basis-text)]', className)}
      >
        <Switcher views={views} current={shownId} onNavigate={onNavigate} />
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence initial={false} mode="popLayout" custom={direction}>
            <motion.div
              key={shownId ?? '__home'}
              custom={direction}
              variants={{
                enter: (dir: number) => ({ opacity: 0, x: dir * offset }),
                center: { opacity: 1, x: 0 },
                exit: (dir: number) => ({
                  opacity: 0,
                  x: -dir * offset,
                  transition: reduceMotion ? { duration: 0 } : spring.moderate.exit,
                }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={reduceMotion ? { duration: 0 } : spring.moderate}
              className="absolute inset-0 flex min-h-0 flex-col"
            >
              <ViewScopeContext.Provider value={shownId ?? HOME_SCOPE}>
                {shown ? (
                  shown.content
                ) : (
                  <Home
                    views={views}
                    highlight={highlight}
                    onHighlight={setHighlight}
                    onOpen={onNavigate}
                  />
                )}
              </ViewScopeContext.Provider>
            </motion.div>
          </AnimatePresence>
        </div>
      </section>
    </DeckContext.Provider>
  )
}

// ─── Header: the switcher ───────────────────────────────────────────────────

/**
 * Overview and every view as fixed-width icon buttons the height of the
 * topbar, so nothing shifts when you switch; the one showing sits on a
 * filled pill that slides between them. Names and keys are in the tooltips
 * and in each view's own subheader.
 */
function Switcher({
  views,
  current,
  onNavigate,
}: {
  views: readonly PanelView[]
  current: string | null
  onNavigate: (id: string | null) => void
}) {
  const reduceMotion = useReducedMotion()
  const items: {
    id: string | null
    label: string
    icon: Icon
    shortcut: string | null
    attention?: PanelAttention | null
  }[] = [
    { id: null, label: 'Overview', icon: SquaresFourIcon, shortcut: 'Esc' },
    ...views.map((view) => ({
      id: view.id,
      label: view.label,
      icon: view.icon,
      shortcut: view.shortcut.toUpperCase(),
      attention: view.attention,
    })),
  ]
  return (
    <nav aria-label="Panel views" className="flex h-9 shrink-0 items-center gap-0.5 px-2">
      {items.map((item) => {
        const selected = item.id === current
        const ItemIcon = item.icon
        return (
          <Tooltip
            key={item.id ?? '__home'}
            side="bottom"
            content={
              <span className="flex items-center gap-1.5">
                <span>{item.label}</span>
                {item.shortcut ? <Kbd inverted>{item.shortcut}</Kbd> : null}
              </span>
            }
          >
            <button
              type="button"
              aria-current={selected ? 'page' : undefined}
              aria-label={item.label}
              onClick={() => onNavigate(item.id)}
              className={cn(
                'relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md',
                'transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-ring',
                selected
                  ? 'text-[var(--basis-text-strong)]'
                  : 'text-[var(--basis-text)] opacity-70 hover:bg-hover hover:opacity-100',
              )}
            >
              {selected ? (
                <motion.span
                  layoutId="panel-switcher-pill"
                  aria-hidden
                  className="absolute inset-0 rounded-md bg-active"
                  transition={reduceMotion ? { duration: 0 } : spring.moderate}
                />
              ) : null}
              <ItemIcon
                size={16}
                weight={selected ? 'fill' : 'regular'}
                className="relative shrink-0"
                aria-hidden
              />
              {item.attention && !selected ? (
                <span
                  aria-hidden
                  className="absolute top-1 right-1 size-1.5 rounded-full ring-2 ring-[var(--basis-canvas-bg)]"
                  style={{ backgroundColor: ATTENTION_COLOR[item.attention] }}
                />
              ) : null}
            </button>
          </Tooltip>
        )
      })}
    </nav>
  )
}

// ─── Home: the options ──────────────────────────────────────────────────────

/**
 * Home: a card per view, each with what is in it now and its key. The
 * cards are the whole page, so it needs no heading of its own; a dot on a
 * card's icon says something there wants a look.
 */
function Home({
  views,
  highlight,
  onHighlight,
  onOpen,
}: {
  views: readonly PanelView[]
  highlight: number
  onHighlight: (index: number) => void
  onOpen: (id: string) => void
}) {
  const lit = Math.min(highlight, Math.max(0, views.length - 1))
  return (
    <div className="custom-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-1 pb-4">
      <ul aria-label="Open in the panel" className="flex flex-col gap-0.5">
        {views.map((view, index) => {
          const ViewIcon = view.icon
          const highlighted = index === lit
          return (
            <li key={view.id}>
              <button
                type="button"
                onClick={() => onOpen(view.id)}
                onMouseEnter={() => onHighlight(index)}
                onFocus={() => onHighlight(index)}
                data-highlighted={highlighted || undefined}
                className={cn(
                  'group/option flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left',
                  'transition-colors duration-100 ease-out focus-visible:outline-2 focus-visible:outline-ring',
                  highlighted && 'bg-hover',
                )}
              >
                <span className="relative flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-hover text-[var(--basis-text)] group-data-[highlighted]/option:bg-active">
                  <ViewIcon size={16} aria-hidden />
                  {view.attention ? (
                    <span
                      aria-hidden
                      className="absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-[var(--basis-canvas-bg)]"
                      style={{ backgroundColor: ATTENTION_COLOR[view.attention] }}
                    />
                  ) : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-13-medium text-[var(--basis-text-strong)]">
                    {view.label}
                    {view.count != null ? (
                      <span className="text-12-regular text-[var(--basis-text-muted)] tabular-nums">
                        {view.count}
                      </span>
                    ) : null}
                  </span>
                  {view.summary ? (
                    <span className="flex min-w-0 items-center gap-1.5 truncate text-12-regular text-[var(--basis-text-muted)]">
                      {view.summary}
                    </span>
                  ) : null}
                </span>
                <Kbd>{view.shortcut.toUpperCase()}</Kbd>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="flex-1" />
      <ShortcutLegend />
    </div>
  )
}

/** The keys that work everywhere in the panel, quietly, at the foot of home. */
function ShortcutLegend() {
  return (
    <p className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 px-2 text-11-regular text-[var(--basis-text-muted)]">
      <span className="flex items-center gap-1.5">
        <Kbd>]</Kbd> Show or hide
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd>↵</Kbd> Open
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd>Esc</Kbd> Back
      </span>
    </p>
  )
}
