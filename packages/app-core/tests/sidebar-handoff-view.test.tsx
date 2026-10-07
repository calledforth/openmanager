// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import type { ProviderId } from '@agentpack/contract'
import { SidebarProvider } from '../src/components/fluid/ui/sidebar'
import { WorkspaceSidebarView } from '../src/components/sidebar/WorkspaceSidebarView'
import type {
  SidebarDraft,
  SidebarSession,
  SidebarWorkspace,
} from '../src/components/sidebar/sidebar-sessions'
import { ThemeProvider } from '../src/providers/theme-provider'

const session = (externalId: string, title: string, updatedAt: string): SidebarSession => ({
  externalId,
  title,
  status: 'ready',
  providerId: 'opencode' as ProviderId,
  updatedAt,
})
const OLDER = session('older', 'Older work', '2026-10-01T09:00:00.000Z')
const OLDEST = session('oldest', 'Oldest work', '2026-10-01T08:00:00.000Z')
const workspace = (sessions: SidebarSession[]): SidebarWorkspace => ({
  path: '/workspace/alpha',
  name: 'alpha',
  sessions,
})
const draft = (draftId: string, preview: string, editedAt: number): SidebarDraft => ({
  draftId,
  sessionId: `${draftId}-session`,
  workspaceId: '/workspace/alpha',
  providerId: 'opencode' as ProviderId,
  preview,
  imageCount: 0,
  editedAt,
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
  // jsdom never finishes a fold, so a row or label that left would linger.
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

/** Card bodies call this once per render, so it counts the cards that rendered. */
const providerLabel = vi.fn((providerId: ProviderId) => providerId)

async function render({
  sessions,
  drafts,
  activeSessionId = null,
  activeDraftId = null,
}: {
  sessions: SidebarSession[]
  drafts: SidebarDraft[]
  activeSessionId?: string | null
  activeDraftId?: string | null
}) {
  await act(() =>
    root.render(
      <ThemeProvider>
        <SidebarProvider persist={false}>
          <WorkspaceSidebarView
            workspaces={[workspace(sessions)]}
            activeWorkspacePath={null}
            activeSessionId={activeSessionId}
            onCreateSession={() => undefined}
            onSelectSession={() => undefined}
            onSettleSession={() => undefined}
            drafts={drafts}
            activeDraftId={activeDraftId}
            onOpenDraft={() => undefined}
            onDiscardDraft={() => undefined}
            onAddWorkspace={() => undefined}
            providerLabel={providerLabel}
          />
        </SidebarProvider>
      </ThemeProvider>,
    ),
  )
  // Let a leaving row or label finish its (skipped) exit.
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
}

/** The rows of the card list, labels included, as what each one reads. */
const rows = () =>
  [...container.querySelector('[role="list"]')!.children].map((row) =>
    row.getAttribute('role') === 'listitem'
      ? (row.querySelector('.text-\\[14px\\]')?.firstChild?.textContent ?? '')
      : `[${row.textContent}]`,
  )
const rowOf = (text: string) =>
  [...container.querySelectorAll('[role="listitem"]')].find((row) =>
    row.textContent?.includes(text),
  )

describe('sending a draft from the sidebar', () => {
  it('hands its row to the session, which moves down to the top of Active', async () => {
    const drafts = [draft('d2', 'second idea', 2), draft('d1', 'first idea', 1)]
    await render({ sessions: [OLDER, OLDEST], drafts })
    expect(rows()).toEqual([
      '[Drafts]',
      'second idea',
      'first idea',
      '[Active]',
      'Older work',
      'Oldest work',
    ])
    const sent = rowOf('second idea')!

    // The session is listed in the same update that drops the draft, newest.
    const started = session('d2-session', 'second idea', '2026-10-02T00:00:00.000Z')
    await render({ sessions: [started, OLDER, OLDEST], drafts: [drafts[1]!] })
    expect(rows()).toEqual([
      '[Drafts]',
      'first idea',
      '[Active]',
      'second idea',
      'Older work',
      'Oldest work',
    ])
    // The same row, now the session's card: nothing folded away or grew in.
    expect(rowOf('second idea')).toBe(sent)
    expect(sent.textContent).not.toContain('Draft')
  })

  it('settles once the hand-off is over: later updates leave the handed card alone', async () => {
    const drafts = [draft('d2', 'second idea', 2), draft('d1', 'first idea', 1)]
    await render({ sessions: [OLDER], drafts })
    const started = session('d2-session', 'second idea', '2026-10-02T00:00:00.000Z')
    const remaining = [drafts[1]!]
    await render({ sessions: [started, OLDER], drafts: remaining })

    providerLabel.mockClear()
    // Another session's title changes; the drafts are as they were.
    await render({
      sessions: [started, { ...OLDER, title: 'Older work, renamed' }],
      drafts: remaining,
    })
    expect(providerLabel).toHaveBeenCalledTimes(1)
    expect(rows()).toEqual([
      '[Drafts]',
      'first idea',
      '[Active]',
      'second idea',
      'Older work, renamed',
    ])
  })

  it('swaps the Drafts label for Active with the last draft, nothing above the card moving', async () => {
    const only = draft('d1', 'only idea', 1)
    await render({ sessions: [OLDER], drafts: [only] })
    const sent = rowOf('only idea')!

    const started = session('d1-session', 'only idea', '2026-10-02T00:00:00.000Z')
    await render({ sessions: [started, OLDER], drafts: [] })
    // In the commit itself: the Drafts label is out of the flow, fading where
    // it was, and the gap above Active is closed, so the card holds its place.
    const drafts = container.querySelector('[role="list"]')!.firstElementChild as HTMLElement
    expect(drafts.textContent).toBe('Drafts')
    expect(drafts.getAttribute('aria-hidden')).toBe('true')
    expect(drafts.className).toContain('absolute')
    const active = drafts.nextElementSibling as HTMLElement
    expect(active.textContent).toBe('Active')
    expect(active.style.paddingTop).toBe('0px')
    expect(rowOf('only idea')).toBe(sent)

    // Once the room below the card has closed, the faded label goes.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)))
    expect(rows()).toEqual(['[Active]', 'only idea', 'Older work'])
    expect(rowOf('only idea')).toBe(sent)
  })

  it('keeps a selected draft selected as it becomes its session', async () => {
    const only = draft('d1', 'only idea', 1)
    await render({ sessions: [OLDER], drafts: [only], activeDraftId: 'd1' })
    const fill = () => rowOf('only idea')!.querySelector('button')!.parentElement!.className
    expect(fill()).toContain('bg-active')
    // The session is listed before the page moves to it: still selected.
    const started = session('d1-session', 'only idea', '2026-10-02T00:00:00.000Z')
    await render({ sessions: [started, OLDER], drafts: [], activeDraftId: 'd1' })
    expect(fill()).toContain('bg-active')
    await render({ sessions: [started, OLDER], drafts: [], activeSessionId: 'd1-session' })
    expect(fill()).toContain('bg-active')
  })

  it('reads as the draft did until its session is named', async () => {
    const only = draft('d1', 'only idea', 1)
    await render({ sessions: [OLDER], drafts: [only] })
    // Listed from the create answer, before any title arrives.
    const untitled = { ...session('d1-session', '', '2026-10-02T00:00:00.000Z'), title: undefined }
    await render({ sessions: [untitled, OLDER], drafts: [] })
    expect(rowOf('only idea')).toBeDefined()
    expect(rows()).not.toContain('New session')
    const named = session('d1-session', 'Named by the environment', '2026-10-02T00:00:01.000Z')
    await render({ sessions: [named, OLDER], drafts: [] })
    expect(rowOf('Named by the environment')).toBeDefined()
  })

  it('fades the Active label in at its new place, after the Drafts label has gone', async () => {
    const fades: Array<{ keyframes: Keyframe[]; options: KeyframeAnimationOptions }> = []
    const animate = vi.fn(function (keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      fades.push({ keyframes, options })
      return { cancel: () => undefined } as unknown as Animation
    })
    // jsdom has no Web Animations; the label's fade is checked by what it asks for.
    Element.prototype.animate = animate as unknown as Element['animate']
    try {
      const only = draft('d1', 'only idea', 1)
      await render({ sessions: [OLDER], drafts: [only] })
      expect(animate).not.toHaveBeenCalled()
      const started = session('d1-session', 'only idea', '2026-10-02T00:00:00.000Z')
      await render({ sessions: [started, OLDER], drafts: [] })
      expect(fades).toEqual([
        {
          keyframes: [{ opacity: 0 }, { opacity: 1 }],
          options: expect.objectContaining({ delay: expect.any(Number), fill: 'backwards' }),
        },
      ])
    } finally {
      delete (Element.prototype as { animate?: unknown }).animate
    }
  })
})

describe('what a change re-renders', () => {
  const sessions = [
    session('a', 'Session A', '2026-10-01T12:00:00.000Z'),
    session('b', 'Session B', '2026-10-01T11:00:00.000Z'),
    session('c', 'Session C', '2026-10-01T10:00:00.000Z'),
    session('d', 'Session D', '2026-10-01T09:00:00.000Z'),
  ]

  it('moves the selection by re-rendering only the card it leaves and the one it reaches', async () => {
    await render({ sessions, drafts: [], activeSessionId: 'a' })
    providerLabel.mockClear()
    await render({ sessions, drafts: [], activeSessionId: 'c' })
    expect(providerLabel).toHaveBeenCalledTimes(2)
  })

  it('opens a draft without re-rendering any session card', async () => {
    const drafts = [draft('d1', 'an idea', 1)]
    await render({ sessions, drafts, activeSessionId: 'a' })
    providerLabel.mockClear()
    // The page moves from the session to the draft.
    await render({ sessions, drafts, activeSessionId: null, activeDraftId: 'd1' })
    // The draft's card, selected, and the session card it left.
    expect(providerLabel).toHaveBeenCalledTimes(2)
  })

  it('adds a draft without re-rendering the session cards', async () => {
    await render({ sessions, drafts: [] })
    providerLabel.mockClear()
    await render({ sessions, drafts: [draft('d1', 'an idea', 1)] })
    expect(providerLabel).toHaveBeenCalledTimes(1)
  })
})
