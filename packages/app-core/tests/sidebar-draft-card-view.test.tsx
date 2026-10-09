// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cloneElement,
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import type { ProviderId } from '@agentpack/contract'
import { SidebarProvider, useSidebar } from '../src/components/fluid/ui/sidebar'
import { WorkspaceSidebarView } from '../src/components/sidebar/WorkspaceSidebarView'
import type { SidebarDraft, SidebarWorkspace } from '../src/components/sidebar/sidebar-sessions'
import { ThemeProvider } from '../src/providers/theme-provider'
import { DraftDiscardToast } from '../src/components/sidebar/DraftDiscardToast'
import type { PendingDraftDiscard } from '../src/providers/sidebar-provider'
import { noticeAnchorRef, type NoticeAnchor } from '../src/lib/notice-anchors'

// The Fluid popup takes half a minute to open under jsdom, so it stands in
// here as Radix behaves: on close, `onCloseAutoFocus` runs once the popup is
// gone, and focus goes back to the trigger unless it is prevented.
vi.mock('../src/components/fluid/ui/dropdown', async (importOriginal) => {
  const Menu = createContext<{
    open: boolean
    setOpen: (open: boolean) => void
    trigger: { current: HTMLElement | null }
  } | null>(null)
  function DropdownMenu({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: ReactNode
  }) {
    const trigger = useRef<HTMLElement | null>(null)
    return (
      <Menu.Provider value={{ open, setOpen: onOpenChange, trigger }}>{children}</Menu.Provider>
    )
  }
  const DropdownTrigger = forwardRef<HTMLElement, { render: ReactElement }>(({ render }, ref) => {
    const menu = useContext(Menu)!
    return cloneElement(render as ReactElement<{ ref?: unknown }>, {
      ref: (node: HTMLElement | null) => {
        menu.trigger.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      },
    })
  })
  function DropdownContent({
    children,
    onCloseAutoFocus,
  }: {
    children: ReactNode
    onCloseAutoFocus?: (event: Event) => void
  }) {
    const menu = useContext(Menu)!
    const wasOpen = useRef(menu.open)
    useEffect(() => {
      if (wasOpen.current && !menu.open) {
        const event = new Event('focusScope.autoFocusOnUnmount', { cancelable: true })
        onCloseAutoFocus?.(event)
        if (!event.defaultPrevented) menu.trigger.current?.focus()
      }
      wasOpen.current = menu.open
    })
    if (!menu.open) return null
    return (
      <div
        role="menu"
        onKeyDown={(event) => {
          if (event.key === 'Escape') menu.setOpen(false)
        }}
      >
        {children}
      </div>
    )
  }
  return {
    ...(await importOriginal<object>()),
    DropdownMenu,
    DropdownTrigger,
    DropdownContent,
  }
})
vi.mock('../src/components/fluid/ui/menu-item', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MenuItem: ({
    label,
    onSelect,
    onClick,
  }: {
    label: string
    onSelect?: () => void
    onClick?: (event: { detail: number }) => void
  }) => (
    <button
      type="button"
      role="menuitem"
      onClick={(event) => {
        onClick?.(event)
        onSelect?.()
      }}
    >
      {label}
    </button>
  ),
}))

const WORKSPACE: SidebarWorkspace = {
  path: '/workspace/alpha',
  name: 'alpha',
  sessions: [
    {
      externalId: 'settled-1',
      title: 'Put away with a reply started',
      status: 'ready',
      providerId: 'opencode' as ProviderId,
      updatedAt: '2026-10-01T10:00:00.000Z',
      settledAt: '2026-10-01T11:00:00.000Z',
      hasUnsentDraft: true,
    },
    {
      externalId: 'ready-1',
      title: 'Finished and waiting to be put away',
      status: 'ready',
      providerId: 'opencode' as ProviderId,
      updatedAt: '2026-10-01T09:00:00.000Z',
    },
  ],
}
const draft = (draftId: string, preview: string, extra: Partial<SidebarDraft> = {}) => ({
  draftId,
  sessionId: `${draftId}-session`,
  workspaceId: WORKSPACE.path,
  providerId: 'opencode' as ProviderId,
  preview,
  imageCount: 0,
  editedAt: 1,
  ...extra,
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }))
  MotionGlobalConfig.skipAnimations = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  MotionGlobalConfig.skipAnimations = false
})

async function render(
  drafts: SidebarDraft[],
  options: {
    activeSessionId?: string | null
    activeDraftId?: string | null
    onDiscardDraft?: () => void
    onSettleSession?: () => void
    workspaces?: SidebarWorkspace[]
  } = {},
) {
  await act(() =>
    root.render(
      <ThemeProvider>
        <SidebarProvider persist={false}>
          <WorkspaceSidebarView
            workspaces={options.workspaces ?? [WORKSPACE]}
            activeWorkspacePath={null}
            activeSessionId={options.activeSessionId ?? null}
            onCreateSession={() => undefined}
            onSelectSession={() => undefined}
            onSettleSession={options.onSettleSession}
            drafts={drafts}
            activeDraftId={options.activeDraftId ?? null}
            onOpenDraft={() => undefined}
            onDiscardDraft={options.onDiscardDraft ?? (() => undefined)}
            onAddWorkspace={() => undefined}
          />
        </SidebarProvider>
      </ThemeProvider>,
    ),
  )
}

const cardButton = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.includes(text) && !button.getAttribute('aria-label'),
  )!
const key = (target: Element, name: string, extra: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...extra }))
  })

describe('a draft card', () => {
  it('takes focus back from its menu, and promises no menu', async () => {
    await render([draft('d1', 'an idea')])
    const card = cardButton('an idea')
    expect(card.hasAttribute('aria-haspopup')).toBe(false)
    act(() => card.focus())
    await key(card, 'F10', { shiftKey: true })
    const item = document.querySelector<HTMLElement>('[role="menuitem"]')!
    act(() => item.focus())
    await key(item, 'Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    // Not the hidden point the menu hung from, where Enter would reopen it.
    expect(document.activeElement).toBe(card)
  })

  it('says whether its menu discarded from the keyboard or the pointer', async () => {
    const onDiscardDraft = vi.fn()
    await render([draft('d1', 'an idea')], { onDiscardDraft })
    const menuDiscard = async (detail: number) => {
      await key(cardButton('an idea'), 'ContextMenu')
      const item = [...document.querySelectorAll('[role="menuitem"]')].find(
        (node) => node.textContent === 'Discard draft',
      )!
      await act(() => {
        item.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }))
      })
    }
    await menuDiscard(0)
    await menuDiscard(1)
    expect(onDiscardDraft.mock.calls).toEqual([
      ['d1', expect.objectContaining({ fromKeyboard: true })],
      ['d1', { fromKeyboard: false, returnFocus: null }],
    ])
  })

  it('offers no discard while it is being sent', async () => {
    await render([draft('d1', 'on its way', { sending: true }), draft('d2', 'still here')])
    const sending = cardButton('on its way').closest('.group\\/card')!
    expect(sending.querySelector('[aria-label="Discard draft"]')).toBeNull()
    await key(cardButton('on its way'), 'ContextMenu')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    const kept = cardButton('still here').closest('.group\\/card')!
    expect(kept.querySelector('[aria-label="Discard draft"]')).not.toBeNull()
  })

  it('keeps its label beside ✕ on a touch screen', async () => {
    await render([draft('d1', 'an idea')])
    const card = cardButton('an idea')
    expect(card.firstElementChild!.className).toContain('pointer-coarse:pr-7')
    const label = [...card.querySelectorAll('span')].find((node) => node.textContent === 'Draft')!
    expect(label.className).not.toContain('pointer-coarse:opacity-0')
  })
})

describe('the double-click guard', () => {
  const click = (target: Element, detail: number, at: number) =>
    act(() => {
      target.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail, clientX: at, clientY: 40 }),
      )
    })

  it('keeps a double click on the last draft from settling the session that slides under it', async () => {
    const onSettleSession = vi.fn()
    await render([draft('d1', 'the last draft')], { onSettleSession })
    const settle = container.querySelector('[aria-label="Settle"]')!
    // Both cards' actions hide while the guard holds.
    const guarded = '[:root[data-draft-discard-guard]_&]:opacity-0'
    expect(settle.closest('.absolute')!.className).toContain(guarded)
    expect(
      container.querySelector('[aria-label="Discard draft"]')!.closest('.absolute')!.className,
    ).toContain(guarded)

    await click(container.querySelector('[aria-label="Discard draft"]')!, 1, 333)
    // The second half of the double click lands on Settle: nothing settles.
    await click(settle, 2, 333)
    expect(onSettleSession).not.toHaveBeenCalled()
    // A keypress is no double click: it still settles.
    await click(settle, 0, 333)
    expect(onSettleSession).toHaveBeenCalledTimes(1)
  })
})

describe('a settled session with unsent text', () => {
  const row = () =>
    [...container.querySelectorAll('li')].find((item) =>
      item.textContent?.includes('Put away with a reply started'),
    )!

  it('shows the pen, with no tint, except while it is open', async () => {
    await render([])
    expect(row().textContent).toContain('Has an unsent draft')
    expect(row().innerHTML).not.toContain('basis-draft-unsent')

    await render([], { activeSessionId: 'settled-1' })
    expect(row().textContent).not.toContain('Has an unsent draft')
  })
})

describe('an active session with unsent text', () => {
  const withReply: SidebarWorkspace = {
    ...WORKSPACE,
    sessions: [
      ...WORKSPACE.sessions,
      {
        externalId: 'active-unsent',
        title: 'Active with a reply started',
        status: 'ready',
        providerId: 'opencode' as ProviderId,
        updatedAt: '2026-10-01T12:00:00.000Z',
        hasUnsentDraft: true,
      },
    ],
  }
  const fill = (text: string) => cardButton(text).parentElement!.className

  it('takes a draft card’s fill, and the selection fill while it is open', async () => {
    await render([draft('d1', 'a new draft')], { workspaces: [withReply] })
    expect(fill('Active with a reply started')).toContain('bg-(--basis-draft-fill)')
    expect(fill('Active with a reply started')).toContain('hover:bg-(--basis-draft-hover)')
    // The same fill a new-session draft has.
    expect(fill('a new draft')).toContain('bg-(--basis-draft-fill)')
    // A session with nothing unsent keeps the plain card.
    expect(fill('Finished and waiting to be put away')).not.toContain('basis-draft')

    await render([], { workspaces: [withReply], activeSessionId: 'active-unsent' })
    expect(fill('Active with a reply started')).toContain('bg-active')
    expect(fill('Active with a reply started')).not.toContain('basis-draft')
  })
})

describe('the open draft’s card', () => {
  it('takes the selection fill a session card takes', async () => {
    await render([draft('d1', 'open one'), draft('d2', 'waiting')], { activeDraftId: 'd1' })
    const fill = (text: string) => cardButton(text).parentElement!.className
    expect(fill('open one')).toContain('bg-active')
    expect(fill('waiting')).toContain('bg-(--basis-draft-fill)')
    // Still a draft by its label.
    expect(cardButton('open one').textContent).toContain('Draft')
  })
})

describe('the undo notice', () => {
  const PENDING = { draftId: 'd1', key: 1, fromKeyboard: false, returnFocus: null }
  const region = () => document.querySelector<HTMLElement>('body > [role="status"]')!
  const anchored = (top: number) => {
    const element = document.createElement('div')
    element.getBoundingClientRect = () =>
      ({
        left: 300,
        width: 600,
        top,
        right: 900,
        bottom: top + 80,
        height: 80,
        x: 300,
        y: top,
      }) as DOMRect
    return element
  }
  function Anchor({ name, element }: { name: NoticeAnchor; element: HTMLElement }) {
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
      ref.current!.append(element)
      const cleanup = noticeAnchorRef(name)(element)
      return () => {
        cleanup()
        element.remove()
      }
    }, [element, name])
    return <div ref={ref} />
  }
  async function show(sidebarOpen: boolean, anchors: ReactNode) {
    await act(() =>
      root.render(
        <ThemeProvider>
          <SidebarProvider persist={false} defaultOpen={sidebarOpen}>
            {anchors}
            <DraftDiscardToast
              pending={PENDING}
              onUndo={() => undefined}
              onDismiss={() => undefined}
              onHold={() => undefined}
            />
          </SidebarProvider>
        </ThemeProvider>,
      ),
    )
  }

  it('moves above a composer that mounts after it is shown', async () => {
    const composer = anchored(600)
    // A child transcript has no composer: the notice falls back to the foot of the page.
    await show(false, null)
    expect(region().style.bottom).toBe('12px')
    // Back to the session: its composer mounts, and the notice clears it.
    await show(false, <Anchor name="composer" element={composer} />)
    expect(region().style.bottom).toBe(`${window.innerHeight - 600 + 8}px`)
    expect(region().style.left).toBe('300px')
  })

  it('closes the phone’s sidebar sheet before putting focus on Undo', async () => {
    // A phone: the sidebar is a modal sheet that traps focus while it is open,
    // and the notice sits outside it.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }))
    const seen: { sidebar?: ReturnType<typeof useSidebar> } = {}
    function Capture() {
      seen.sidebar = useSidebar()
      return null
    }
    const mountToast = (pending: typeof PENDING | null) =>
      act(() =>
        root.render(
          <ThemeProvider>
            <SidebarProvider persist={false}>
              <Capture />
              <DraftDiscardToast
                pending={pending}
                onUndo={() => undefined}
                onDismiss={() => undefined}
                onHold={() => undefined}
              />
            </SidebarProvider>
          </ThemeProvider>,
        ),
      )
    await mountToast(null)
    expect(seen.sidebar!.isMobile).toBe(true)
    await act(() => seen.sidebar!.setOpenMobile(true))
    await mountToast({ ...PENDING, fromKeyboard: true })
    expect(seen.sidebar!.openMobile).toBe(false)
    const undo = [...region().querySelectorAll('button')].find(
      (node) => node.textContent === 'Undo',
    )
    expect(document.activeElement).toBe(undo)
  })

  it('returns focus to what the user can see on a phone, never the page body', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }))
    const discard: PendingDraftDiscard = { ...PENDING, draftId: 'd1', fromKeyboard: true }
    // The wide screen's sidebar, mounted but hidden below its breakpoint: the
    // card that comes back, its neighbour and the list are all in it.
    function HiddenDesktop() {
      return (
        <div data-sidebar="sidebar" style={{ display: 'none' }}>
          <div data-sidebar="content">
            <div role="list" tabIndex={-1}>
              <button type="button" data-draft-card="d1">
                the draft
              </button>
              <button type="button" id="neighbour">
                the next card
              </button>
            </div>
          </div>
        </div>
      )
    }
    const composerHost = document.createElement('div')
    composerHost.append(document.createElement('textarea'))
    let key = 10
    async function cycle(choice: 'Undo' | 'Dismiss', extra: ReactNode) {
      key += 1
      const at = (pending: PendingDraftDiscard | null) =>
        act(() =>
          root.render(
            <ThemeProvider>
              <SidebarProvider persist={false}>
                <HiddenDesktop />
                {extra}
                <DraftDiscardToast
                  pending={pending}
                  onUndo={() => undefined}
                  onDismiss={() => undefined}
                  onHold={() => undefined}
                />
              </SidebarProvider>
            </ThemeProvider>,
          ),
        )
      // Mounted first, so the phone's breakpoint has been read.
      await at(null)
      await at({ ...discard, key, returnFocus: document.getElementById('neighbour') })
      const control = [...region().querySelectorAll('button')].find(
        (node) => node.textContent === choice || node.getAttribute('aria-label') === choice,
      )!
      expect(document.activeElement).toBe(region().querySelector('button'))
      await act(() => control.click())
      // The host answers: the discard is settled, the notice goes.
      await at(null)
    }

    // The control that opens the sidebar's sheet, as a modal returns focus.
    await cycle(
      'Undo',
      <button type="button" data-sidebar="trigger">
        Open sidebar
      </button>,
    )
    expect(document.activeElement?.getAttribute('data-sidebar')).toBe('trigger')

    // No such control in sight: the composer.
    await cycle('Dismiss', <Anchor name="composer" element={composerHost} />)
    expect(document.activeElement).toBe(composerHost.querySelector('textarea'))
    expect(document.activeElement).not.toBe(document.body)
  })

  it('leaves a replaced notice inert, still bound to its own discard', async () => {
    // Let the exit play (jsdom never finishes it), as a real replacement does.
    MotionGlobalConfig.skipAnimations = false
    const onUndo = vi.fn()
    const onDismiss = vi.fn()
    const toast = (pending: typeof PENDING) =>
      act(() =>
        root.render(
          <ThemeProvider>
            <SidebarProvider persist={false}>
              <DraftDiscardToast
                pending={pending}
                onUndo={onUndo}
                onDismiss={onDismiss}
                onHold={() => undefined}
              />
            </SidebarProvider>
          </ThemeProvider>,
        ),
      )
    await toast({ ...PENDING, draftId: 'a', key: 1 })
    await toast({ ...PENDING, draftId: 'b', key: 2 })
    const notices = [...region().children] as HTMLElement[]
    expect(notices).toHaveLength(2)
    const leaving = notices.find((notice) => notice.hasAttribute('inert'))!
    expect(leaving).toBeDefined()
    expect(leaving.getAttribute('aria-hidden')).toBe('true')
    expect(leaving.className).toContain('pointer-events-none')
    // Reached anyway (a click mid-fade): it names its own discard, not b's.
    const undo = [...leaving.querySelectorAll('button')].find(
      (node) => node.textContent === 'Undo',
    )!
    await act(() => undo.click())
    await act(() => leaving.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click())
    expect(onUndo).toHaveBeenCalledWith(1)
    expect(onDismiss).toHaveBeenCalledWith(1)
  })

  it('falls back to the footer still mounted when another one goes', async () => {
    // The wide screen's footer, then the phone sheet's, mounted beside it.
    const desk = anchored(700)
    const sheet = anchored(500)
    await show(
      true,
      <>
        <Anchor name="sidebar-foot" element={desk} />
        <Anchor name="sidebar-foot" element={sheet} />
      </>,
    )
    expect(region().style.bottom).toBe(`${window.innerHeight - 500 + 4}px`)
    // The sheet closes: the wide screen's footer is the one to clear again.
    await show(
      true,
      <>
        <Anchor name="sidebar-foot" element={desk} />
        {null}
      </>,
    )
    expect(region().style.bottom).toBe(`${window.innerHeight - 700 + 4}px`)
  })

  it('rests just above the sidebar’s foot when docked', async () => {
    await show(true, <Anchor name="sidebar-foot" element={anchored(700)} />)
    expect(region().style.bottom).toBe(`${window.innerHeight - 700 + 4}px`)
  })
})
