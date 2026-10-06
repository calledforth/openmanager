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
import { SidebarProvider } from '../src/components/fluid/ui/sidebar'
import { WorkspaceSidebarView } from '../src/components/sidebar/WorkspaceSidebarView'
import type { SidebarDraft, SidebarWorkspace } from '../src/components/sidebar/sidebar-sessions'
import { ThemeProvider } from '../src/providers/theme-provider'
import { DraftDiscardToast } from '../src/components/sidebar/DraftDiscardToast'
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
  } = {},
) {
  await act(() =>
    root.render(
      <ThemeProvider>
        <SidebarProvider persist={false}>
          <WorkspaceSidebarView
            workspaces={[WORKSPACE]}
            activeWorkspacePath={null}
            activeSessionId={options.activeSessionId ?? null}
            onCreateSession={() => undefined}
            onSelectSession={() => undefined}
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
