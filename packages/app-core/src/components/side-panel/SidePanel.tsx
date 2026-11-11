import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'
import { Sidebar, SidebarProvider, useOptionalSidebar, useSidebar } from '../fluid/ui/sidebar'

// ---------------------------------------------------------------------------
// A right-hand panel beside the main column: the shared sidebar's second,
// independent instance. Same dynamics as the left rail — drag its inner edge
// to resize, drag past the minimum to collapse, `]` toggles, spring motion,
// and a sheet from the right on narrow screens.
//
//   <SidePanelHost>                    ← wraps the main column (topbar + page)
//     <SidebarInsetTopbar end={<SidePanelPillSlot />} />
//     <Page />
//     <SidePanel available={…} pill={<Pill />}>   ← anywhere inside the host
//       <PanelContent />
//     </SidePanel>
//   </SidePanelHost>
//
// <SidePanel> is a declaration, not a box: its pill renders in the topbar's
// slot and its children in the panel, through portals, so both keep the
// React context of wherever <SidePanel> is placed (a route's providers,
// say). With no <SidePanel> mounted — or only unavailable ones — the panel is
// out of reach: shut, `]` inert, its saved open state kept for next time.
// ---------------------------------------------------------------------------

// Sizing (px). The panel holds a list of linked items above a detail view
// whose rows are a status icon, a title that may wrap to two lines, and a
// trailing meta chip:
// - 400 default: ~45 characters of 13px title per line beside the icon and
//   chip, so most titles fit in two lines; on a 1280px laptop with the 256px
//   left rail the chat keeps ~620px — about the composer's own width.
// - 320 min: narrower and titles go to three-plus lines while branch names
//   truncate to nothing; it is also the narrowest phone width, so nothing
//   inside has to be designed for less.
// - 640 max: wider and the chat beside it (1440 − 256 − 640 ≈ 540px) gets
//   narrower than the panel, which is backwards for a side panel.
export const SIDE_PANEL_WIDTH = 400
export const SIDE_PANEL_MIN_WIDTH = 320
export const SIDE_PANEL_MAX_WIDTH = 640
/** Below this viewport width the panel is a sheet over the page: the left
 *  rail (256) plus the panel's minimum (320) would leave the chat < 450px. */
export const SIDE_PANEL_SHEET_BREAKPOINT = 1024
/** Its own persistence keys, so the left rail's saved state is untouched. */
export const SIDE_PANEL_STATE_COOKIE = 'side_panel_state'
export const SIDE_PANEL_WIDTH_STORAGE_KEY = 'side_panel_width'

interface Claim {
  available: boolean
  title: string
}

interface SidePanelHostValue {
  available: boolean
  pillTarget: HTMLElement | null
  setPillTarget: (node: HTMLElement | null) => void
  panelTarget: HTMLElement | null
  setPanelTarget: React.Dispatch<React.SetStateAction<HTMLElement | null>>
  claim: (id: string, claim: Claim | null) => void
}

const SidePanelHostContext = createContext<SidePanelHostValue | null>(null)

export interface SidePanelHostProps {
  /** The main column: topbar, page, and (anywhere inside) a <SidePanel>. */
  children: ReactNode
  /** Classes for the main column beside the panel. */
  className?: string
}

/** Lays the main column out beside a right-hand panel. Mount it once, around
 *  the page; it stays mounted while the routes inside it change. */
export function SidePanelHost({ children, className }: SidePanelHostProps) {
  const [claims, setClaims] = useState<Record<string, Claim>>({})
  const [pillTarget, setPillTarget] = useState<HTMLElement | null>(null)
  const [panelTarget, setPanelTarget] = useState<HTMLElement | null>(null)
  const claim = useCallback((id: string, next: Claim | null) => {
    setClaims((current) => {
      const previous = current[id]
      if (next === null) {
        if (!previous) return current
        const rest = { ...current }
        delete rest[id]
        return rest
      }
      if (previous && previous.available === next.available && previous.title === next.title)
        return current
      return { ...current, [id]: next }
    })
  }, [])
  // The newest declaration names the sheet; any available one opens reach.
  const live = Object.values(claims)
  const available = live.some((item) => item.available)
  const title = live.at(-1)?.title ?? 'Side panel'
  const value = useMemo<SidePanelHostValue>(
    () => ({ available, pillTarget, setPillTarget, panelTarget, setPanelTarget, claim }),
    [available, pillTarget, panelTarget, claim],
  )
  return (
    <SidePanelHostContext.Provider value={value}>
      <SidebarProvider
        side="right"
        disabled={!available}
        defaultOpen={false}
        stateCookieName={SIDE_PANEL_STATE_COOKIE}
        widthStorageKey={SIDE_PANEL_WIDTH_STORAGE_KEY}
        width={`${SIDE_PANEL_WIDTH}px`}
        minWidth={SIDE_PANEL_MIN_WIDTH}
        maxWidth={SIDE_PANEL_MAX_WIDTH}
        widthMobile="min(26rem, calc(100vw - 3rem))"
        mobileBreakpoint={SIDE_PANEL_SHEET_BREAKPOINT}
        className="min-h-0 flex-1"
      >
        {/* `relative`: overlays the page floats (banners, notices) centre on
            the chat column, not on chat + panel. */}
        <div className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col', className)}>
          {children}
        </div>
        {/* The canvas colour with a hairline at its inner edge, like the left
            rail: one surface, split, rather than a card on the page. */}
        <Sidebar side="right" sheetTitle={title} className="h-full">
          <PanelOutlet />
        </Sidebar>
      </SidebarProvider>
    </SidePanelHostContext.Provider>
  )
}

/** Where the declared children render. <Sidebar> renders its children twice
 *  below the sheet breakpoint (the faded-out rail and the sheet), so only the
 *  copy that is showing — the sheet's on a narrow screen, else the rail's —
 *  becomes the portal target. */
function PanelOutlet() {
  const host = useContext(SidePanelHostContext)
  const { isMobile } = useSidebar()
  const [node, setNode] = useState<HTMLElement | null>(null)
  const inSheet = node ? node.closest('[data-mobile="true"]') !== null : false
  const showing = node !== null && inSheet === isMobile
  const setPanelTarget = host?.setPanelTarget
  useLayoutEffect(() => {
    if (!node || !showing || !setPanelTarget) return
    setPanelTarget(node)
    return () => setPanelTarget((current) => (current === node ? null : current))
  }, [node, showing, setPanelTarget])
  return <div ref={setNode} data-side-panel="content" className="flex min-h-0 flex-1 flex-col" />
}

/** The topbar's slot for the declared pill. Renders nothing outside a host. */
export function SidePanelPillSlot({ className }: { className?: string }) {
  const host = useContext(SidePanelHostContext)
  if (!host) return null
  return (
    <div
      ref={host.setPillTarget}
      data-side-panel="pill"
      className={cn('flex shrink-0 items-center empty:hidden', className)}
    />
  )
}

export interface SidePanelProps {
  /** Whether there is anything to show. False keeps the panel shut and `]`
   *  inert (the saved open state is kept). @default true */
  available?: boolean
  /** Rendered in the topbar's pill slot; omit or pass null to show none. It
   *  toggles the panel itself, via useSidePanel(). */
  pill?: ReactNode
  /** Accessible name of the panel's sheet on narrow screens. */
  title?: string
  /** The panel's content. Mounted while the panel can show it. */
  children?: ReactNode
}

/** Declares the side panel's pill and content. Place it anywhere inside a
 *  <SidePanelHost>, typically in the page that has something to show. */
export function SidePanel({
  available = true,
  pill,
  title = 'Side panel',
  children,
}: SidePanelProps) {
  const host = useContext(SidePanelHostContext)
  const id = useId()
  const claim = host?.claim
  useLayoutEffect(() => {
    claim?.(id, { available, title })
  }, [claim, id, available, title])
  useLayoutEffect(() => () => claim?.(id, null), [claim, id])
  if (!host) throw new Error('SidePanel must be rendered inside a SidePanelHost')
  return (
    <>
      {pill != null && host.pillTarget ? createPortal(pill, host.pillTarget) : null}
      {available && host.panelTarget ? createPortal(children, host.panelTarget) : null}
    </>
  )
}

export interface SidePanelControls {
  /** Whether any <SidePanel> currently has something to show. */
  available: boolean
  /** Whether the panel is showing (the sheet below the breakpoint). */
  open: boolean
  toggle: () => void
  setOpen: (open: boolean) => void
  /** The bare key that toggles it ("]"), for tooltips. */
  shortcut: string | null
}

/** The side panel's state and toggle — for its pill, or anything else inside
 *  the host. Throws outside a <SidePanelHost>. */
export function useSidePanel(): SidePanelControls {
  const host = useContext(SidePanelHostContext)
  const sidebar = useOptionalSidebar('right')
  const setShown = useCallback(
    (next: boolean) => {
      if (!sidebar || sidebar.disabled) return
      if (sidebar.isMobile) sidebar.setOpenMobile(next)
      else sidebar.setOpen(next)
    },
    [sidebar],
  )
  if (!host || !sidebar) throw new Error('useSidePanel must be used inside a SidePanelHost')
  const { isMobile, open, openMobile, toggleSidebar, shortcut } = sidebar
  return {
    available: host.available,
    open: isMobile ? openMobile : open,
    toggle: toggleSidebar,
    setOpen: setShown,
    shortcut,
  }
}
