import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { GitPullRequestIcon, NotePencilIcon, SidebarSimpleIcon } from '@phosphor-icons/react'
import type { PullRequestSummary } from '@openmanager/protocol'
import { PullRequestPill } from '../../components/pull-requests/PullRequestPill'
import {
  PullRequestsPanel,
  pullRequestsSummary,
} from '../../components/pull-requests/PullRequestsPanel'
import { pullRequestKey } from '../../components/pull-requests/pull-request-status'
import {
  ScratchpadPanel,
  scratchpadSummary,
  type ScratchpadEdit,
} from '../../components/scratchpad/ScratchpadPanel'
import { Kbd } from '../../components/side-panel/Kbd'
import { PanelDeck, isTypingTarget, type PanelView } from '../../components/side-panel/PanelDeck'
import { Tooltip, TooltipProvider } from '../../components/fluid/ui/tooltip'
import { useNow } from '../../lib/relative-time'
import { DETAILS, FOUR, SUMMARY_OPEN } from '../pull-requests/fixtures'

type Theme = 'neutral' | 'neutral-light' | 'paper' | 'paper-light' | 'dark' | 'light'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

const NOTES = `# Sidebar revamp

Keep the look; change how it is **reached**.

## Now
- [x] PR list first, open one on its own page
- [x] Home view with a key per view (P, S)
- [ ] Scratchpad shared with agents

## Decisions
- Scratchpad is **per project**, not per session
- Agents get it in context; they edit it with the \`scratchpad\` MCP tools
- Keys only answer while the panel shows and nobody is typing

## Links
- Fluid Functionalism: https://www.fluidfunctionalism.com
`

/** What the agent's edit does: ticks the sharing item and adds open questions. */
const agentEdit = (text: string) =>
  text.replace('- [ ] Scratchpad shared with agents', '- [x] Scratchpad shared with agents') +
  AGENT_APPEND

const AGENT_APPEND = `
## Open questions
- Should the panel remember the last view per session?
- Cap the scratchpad at ~8k characters so it stays cheap in context`

/** Storybook's own `custom.css` styles bare headings; put the app's back. */
function StorybookResets() {
  return (
    <style>{`
      [data-deck-scene] :is(h1, h2, h3, h4) { margin: 0; padding-block: 0; border: 0; }
      [data-deck-scene] :is(ul, ol, li, dl, dd):not(.md *) { margin: 0; padding: 0; }
      [data-deck-scene] .md :is(h1, h2, h3, h4) { margin: 1.4em 0 0.5em; font-weight: 600; }
      [data-deck-scene] .md > :first-child { margin-top: 0; }
      [data-deck-scene] .md h1 { font-size: 16px; }
      [data-deck-scene] .md h2 { font-size: 14px; }
      [data-deck-scene] .md :is(h3, h4) { font-size: 13px; }
      /* A phone: the app shows the panel as a full-width sheet, so the story does too. */
      @media (max-width: 720px) {
        [data-deck-scene] > div:first-child:has(+ aside) { display: none; }
        [data-deck-scene] > aside { width: 100% !important; border: 0; }
      }
    `}</style>
  )
}

interface SceneArgs {
  theme: Theme
  panelWidth: number
  pullRequests: readonly PullRequestSummary[]
  initialView: string | null
  initialPr?: string | null
  initialNotes: string
  /** An agent edit lands this many ms after load; null never. */
  agentEditAfterMs: number | null
  /** Start with an agent edit you have not seen. */
  startUnseen?: boolean
  panelOpen?: boolean
}

/**
 * The app around the panel, faked: the chat column with its topbar (title,
 * the pull-request pill, the panel toggle), a short exchange and a resting
 * composer, then the panel at the width the host gives it.
 */
function Scene({
  theme,
  panelWidth,
  pullRequests,
  initialView,
  initialPr = null,
  initialNotes,
  agentEditAfterMs,
  startUnseen = false,
  panelOpen = true,
}: SceneArgs) {
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  const now = useNow(5_000)
  const [open, setOpen] = useState(panelOpen)
  const [view, setView] = useState<string | null>(initialView)
  const [prKey, setPrKey] = useState<string | null>(initialPr)

  // The scratchpad, as the environment would hold it.
  const [notes, setNotes] = useState(startUnseen ? agentEdit(initialNotes) : initialNotes)
  const [lastEdit, setLastEdit] = useState<ScratchpadEdit | null>(
    startUnseen
      ? { by: { kind: 'agent', name: 'Claude' }, at: minutesAgo(3) }
      : { by: { kind: 'you' }, at: minutesAgo(42) },
  )
  const [unseen, setUnseen] = useState<(ScratchpadEdit & { before: string }) | null>(
    startUnseen
      ? { by: { kind: 'agent', name: 'Claude' }, at: minutesAgo(3), before: initialNotes }
      : null,
  )
  const [share, setShare] = useState(true)
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved')

  useEffect(() => {
    if (agentEditAfterMs == null) return
    const timer = setTimeout(() => {
      setNotes((before) => {
        const edit = {
          by: { kind: 'agent' as const, name: 'Claude' },
          at: new Date().toISOString(),
        }
        setUnseen((held) => held ?? { ...edit, before })
        setLastEdit(edit)
        return agentEdit(before)
      })
    }, agentEditAfterMs)
    return () => clearTimeout(timer)
  }, [agentEditAfterMs])

  const onNotesChange = useCallback((next: string) => {
    setNotes(next)
    setLastEdit({ by: { kind: 'you' }, at: new Date().toISOString() })
    setUnseen(null)
    setSaveState('saving')
  }, [])
  useEffect(() => {
    if (saveState !== 'saving') return
    const timer = setTimeout(() => setSaveState('saved'), 600)
    return () => clearTimeout(timer)
  }, [saveState, notes])

  // `]` toggles the panel, as the app's SidebarProvider does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ']' || event.metaKey || event.ctrlKey || isTypingTarget(event.target))
        return
      event.preventDefault()
      setOpen((value) => !value)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const opened =
    pullRequests.find((pr) => pullRequestKey(pr) === prKey) ??
    (pullRequests.length === 1 ? pullRequests[0] : null)
  const failing = pullRequests.some((pr) => pr.checks === 'failing')
  const views: PanelView[] = [
    {
      id: 'prs',
      shortcut: 'p',
      label: 'Pull requests',
      icon: GitPullRequestIcon,
      count: pullRequests.length || null,
      summary: pullRequestsSummary(pullRequests),
      attention: failing ? 'alert' : null,
      content: (
        <PullRequestsPanel
          pullRequests={pullRequests}
          openKey={prKey}
          onOpen={setPrKey}
          detail={opened ? (DETAILS[pullRequestKey(opened)] ?? null) : null}
          onOpenOnGitHub={(url) => window.open(url, '_blank', 'noopener')}
          environmentLabel="Desktop"
        />
      ),
    },
    {
      id: 'scratchpad',
      shortcut: 's',
      label: 'Scratchpad',
      icon: NotePencilIcon,
      summary: scratchpadSummary(notes, lastEdit, now),
      attention: unseen ? 'notice' : null,
      content: (
        <ScratchpadPanel
          projectName="openmanager"
          content={notes}
          onChange={onNotesChange}
          lastEdit={lastEdit}
          unseen={unseen}
          onMarkSeen={() => setUnseen(null)}
          shareWithAgents={share}
          onShareWithAgentsChange={setShare}
          saveState={saveState}
        />
      ),
    },
  ]

  return (
    <TooltipProvider>
      <StorybookResets />
      <div
        data-deck-scene
        className="flex h-svh w-full overflow-hidden bg-background text-foreground"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-9 shrink-0 items-center gap-1.5 px-2">
            <span className="flex size-7 items-center justify-center text-[var(--basis-text-muted)]">
              <SidebarSimpleIcon size={16} aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate text-12-medium text-[var(--basis-text)]">
              Revamp the right sidebar
            </span>
            <PullRequestPill
              pullRequests={pullRequests}
              open={open && view === 'prs'}
              onToggle={() => {
                if (open && view === 'prs') setOpen(false)
                else {
                  setOpen(true)
                  setView('prs')
                }
              }}
              shortcut={null}
            />
            <Tooltip
              side="bottom"
              content={
                <span className="flex items-center gap-1.5">
                  {open ? 'Hide panel' : 'Show panel'} <Kbd inverted>]</Kbd>
                </span>
              }
            >
              <button
                type="button"
                aria-label="Toggle panel"
                aria-pressed={open}
                onClick={() => setOpen((value) => !value)}
                className="flex size-7 cursor-pointer items-center justify-center rounded-md text-[var(--basis-text-muted)] hover:bg-hover hover:text-[var(--basis-text-strong)]"
              >
                <SidebarSimpleIcon size={16} className="-scale-x-100" aria-hidden />
              </button>
            </Tooltip>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-10 pt-8">
            <div className="self-end rounded-2xl bg-[var(--basis-chat-user-bg)] px-4 py-2.5 text-[14px] leading-relaxed text-[var(--basis-chat-text)]">
              Note the open questions in the scratchpad, then open the PR.
            </div>
            <div className="md max-w-[52ch] text-[14px] leading-relaxed text-[var(--basis-chat-text)]">
              <p>
                Added two open questions to the project scratchpad and ticked off the sharing item.
                I opened <a href="https://github.com/calledforth/openmanager/pull/301">#301</a> and
                linked it here; checks are running.
              </p>
            </div>
          </div>
          <div className="shrink-0 px-10 pb-6">
            <div className="h-[88px] rounded-float bg-float shadow-float-rest" />
          </div>
        </div>
        {open ? (
          <aside
            className="h-full shrink-0 border-l border-[var(--basis-border-muted)]"
            style={{ width: panelWidth }}
          >
            <PanelDeck views={views} current={view} onNavigate={setView} active={open} />
          </aside>
        ) : null}
      </div>
    </TooltipProvider>
  )
}

const meta = {
  title: 'App/SidePanelDeck',
  component: Scene,
  args: {
    theme: 'neutral',
    panelWidth: 400,
    pullRequests: FOUR,
    initialView: null,
    initialNotes: NOTES,
    agentEditAfterMs: null,
  },
  argTypes: {
    theme: {
      control: 'select',
      options: ['neutral', 'neutral-light', 'paper', 'paper-light', 'dark', 'light'],
    },
    panelWidth: { control: { type: 'range', min: 320, max: 640, step: 10 } },
    pullRequests: { control: false },
  },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Scene>

export default meta
type Story = StoryObj<typeof meta>

/** Opening the panel: what it can show, a key each. */
export const Overview: Story = { args: { startUnseen: true } }

/** The panel shut: `]` or the toggle opens it on the overview. */
export const PanelClosed: Story = { args: { startUnseen: true, panelOpen: false } }

export const OverviewLight: Story = { args: { theme: 'paper-light', startUnseen: true } }

/** P: the list first. */
export const PullRequestList: Story = { args: { initialView: 'prs' } }

/** A row opened: its own page, with back, position, and next/previous. */
export const PullRequestOpen: Story = {
  args: { initialView: 'prs', initialPr: 'calledforth/openmanager#301' },
}

/** One pull request: no list to choose from, so the page is all there is. */
export const OnePullRequest: Story = {
  args: { initialView: 'prs', pullRequests: [SUMMARY_OPEN] },
}

/** S: the project's scratchpad, read. */
export const Scratchpad: Story = { args: { initialView: 'scratchpad' } }

/** An agent edited it since you looked: who, how much, and D to review. */
export const ScratchpadAgentEdited: Story = {
  args: { initialView: 'scratchpad', startUnseen: true },
}

export const ScratchpadEmpty: Story = {
  args: { initialView: 'scratchpad', initialNotes: '' },
}

/** An agent edit lands four seconds in, while you watch. */
export const LiveAgentEdit: Story = {
  args: { initialView: 'scratchpad', agentEditAfterMs: 4000 },
}

export const ScratchpadLight: Story = {
  args: { initialView: 'scratchpad', theme: 'paper-light', startUnseen: true },
}
