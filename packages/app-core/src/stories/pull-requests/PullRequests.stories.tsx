import { useLayoutEffect, useState, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { SidebarSimpleIcon } from '@phosphor-icons/react'
import type { PullRequestDetail, PullRequestSummary } from '@openmanager/protocol'
import { PullRequestPill } from '../../components/pull-requests/PullRequestPill'
import { PullRequestsPanel } from '../../components/pull-requests/PullRequestsPanel'
import { PullRequestDetailView } from '../../components/pull-requests/PullRequestDetailView'
import { pullRequestKey } from '../../components/pull-requests/pull-request-status'
import { TooltipProvider } from '../../components/fluid/ui/tooltip'
import {
  DETAILS,
  DETAIL_UNREACHABLE,
  DRAFT_FAILING,
  FOUR,
  MANY_LABELS,
  MERGED,
  OPEN_PASSING,
  SUMMARY_DRAFT,
  SUMMARY_MANY_LABELS,
  SUMMARY_MERGED,
  SUMMARY_NEVER_READ,
  SUMMARY_NOT_FOUND,
  SUMMARY_NOT_SIGNED_IN,
  SUMMARY_OPEN,
  SUMMARY_UNREACHABLE,
} from './fixtures'

type Theme = 'neutral' | 'neutral-light' | 'paper' | 'paper-light' | 'dark' | 'light'

/**
 * Storybook's own `custom.css` gives every h2 a rule and a 2em margin, outside
 * any cascade layer, so it beats the app's layered styles here and nowhere
 * else. These put the app's values back for the story, with the body's
 * headings at the sizes the detail view sets.
 */
function StorybookResets() {
  return (
    <style>{`
      [data-pr-scene] :is(h1, h2, h3, h4) { margin: 0; padding: 0; border: 0; }
      [data-pr-scene] .md :is(h1, h2, h3, h4) { margin: 1.6em 0 0.6em; font-weight: 600; }
      [data-pr-scene] .md > :first-child { margin-top: 0; }
      [data-pr-scene] .md h1 { font-size: 15px; }
      [data-pr-scene] .md h2 { font-size: 14px; }
      [data-pr-scene] .md :is(h3, h4) { font-size: 13px; }
    `}</style>
  )
}

/**
 * The app around the panel, faked: a chat column with its topbar (session
 * title left, the pill right), a couple of messages and a resting composer,
 * then the panel beside it at the width the host gives it.
 */
function Scene({
  theme,
  panelWidth = 400,
  pullRequests,
  panelOpen = true,
  children,
}: {
  theme: Theme
  panelWidth?: number
  pullRequests: readonly PullRequestSummary[]
  panelOpen?: boolean
  children?: ReactNode
}) {
  const [open, setOpen] = useState(panelOpen)
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  return (
    <TooltipProvider>
      <StorybookResets />
      <div
        data-pr-scene
        className="flex h-svh w-full overflow-hidden bg-background text-foreground"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-9 shrink-0 items-center gap-1.5 px-2">
            <span className="flex size-7 items-center justify-center text-[var(--basis-text-muted)]">
              <SidebarSimpleIcon size={16} aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate text-12-medium text-[var(--basis-text)]">
              Link pull requests to sessions
            </span>
            <PullRequestPill
              pullRequests={pullRequests}
              open={open}
              onToggle={() => setOpen((v) => !v)}
            />
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-10 pt-8">
            <div className="self-end rounded-2xl bg-[var(--basis-chat-user-bg)] px-4 py-2.5 text-[14px] leading-relaxed text-[var(--basis-chat-text)]">
              Open a PR for the sync changes and link it here.
            </div>
            <div className="md max-w-[52ch] text-[14px] leading-relaxed text-[var(--basis-chat-text)]">
              <p>
                Done. I pushed <code>feat/pr-linking</code> and opened{' '}
                <a href="https://github.com/calledforth/openmanager/pull/301">#301</a> against{' '}
                <code>main</code>, then linked it to this session. Checks are running; I’ll say when
                they settle.
              </p>
              <p>While that runs I’ll start on the mobile side in a draft.</p>
            </div>
          </div>
          <div className="shrink-0 px-10 pb-6">
            <div className="h-[88px] rounded-float bg-float shadow-float-rest" />
          </div>
        </div>
        {open ? (
          <aside className="h-full shrink-0" style={{ width: panelWidth }}>
            {children}
          </aside>
        ) : null}
      </div>
    </TooltipProvider>
  )
}

/** A panel with the selection held locally and details served from the fixtures. */
function Panel({
  pullRequests,
  details = DETAILS,
  loading = false,
  error = null,
  initialKey,
  environmentLabel = 'Desktop',
}: {
  pullRequests: readonly PullRequestSummary[]
  details?: Record<string, PullRequestDetail>
  loading?: boolean
  error?: string | null
  initialKey?: string
  environmentLabel?: string | null
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(initialKey ?? null)
  const selected =
    pullRequests.find((pr) => pullRequestKey(pr) === selectedKey) ?? pullRequests[0] ?? null
  const detail = selected && !loading ? (details[pullRequestKey(selected)] ?? null) : null
  return (
    <PullRequestsPanel
      pullRequests={pullRequests}
      selectedKey={selectedKey}
      onSelect={setSelectedKey}
      detail={detail}
      detailLoading={loading}
      detailError={error}
      onOpenOnGitHub={(url) => window.open(url, '_blank', 'noopener')}
      environmentLabel={environmentLabel}
    />
  )
}

interface Args {
  theme: Theme
  panelWidth: number
}

const meta = {
  title: 'App/PullRequests',
  args: { theme: 'neutral', panelWidth: 400 },
  argTypes: {
    theme: {
      control: 'select',
      options: ['neutral', 'neutral-light', 'paper', 'paper-light', 'dark', 'light'],
    },
    panelWidth: { control: { type: 'range', min: 320, max: 640, step: 10 } },
  },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<Args>

export default meta
type Story = StoryObj<Args>

export const OnePullRequest: Story = {
  render: (args) => (
    <Scene {...args} pullRequests={[SUMMARY_OPEN]}>
      <Panel pullRequests={[SUMMARY_OPEN]} />
    </Scene>
  ),
}

export const FourPullRequests: Story = {
  render: (args) => (
    <Scene {...args} pullRequests={FOUR}>
      <Panel pullRequests={FOUR} initialKey={pullRequestKey(SUMMARY_OPEN)} />
    </Scene>
  ),
}

export const Merged: Story = {
  render: (args) => (
    <Scene {...args} pullRequests={FOUR}>
      <Panel pullRequests={FOUR} initialKey={pullRequestKey(SUMMARY_MERGED)} />
    </Scene>
  ),
}

export const DraftFailingChecks: Story = {
  render: (args) => (
    <Scene {...args} pullRequests={FOUR}>
      <Panel pullRequests={FOUR} initialKey={pullRequestKey(SUMMARY_DRAFT)} />
    </Scene>
  ),
}

export const ManyLabels: Story = {
  render: (args) => (
    <Scene {...args} pullRequests={[SUMMARY_MANY_LABELS]}>
      <Panel pullRequests={[SUMMARY_MANY_LABELS]} />
    </Scene>
  ),
}

export const Loading: Story = {
  render: (args) => (
    <Scene {...args} pullRequests={[SUMMARY_OPEN]}>
      <Panel pullRequests={[SUMMARY_OPEN]} loading />
    </Scene>
  ),
}

export const NeverRead: Story = {
  render: (args) => (
    <Scene {...args} pullRequests={[SUMMARY_NEVER_READ]}>
      <Panel pullRequests={[SUMMARY_NEVER_READ]} details={{}} />
    </Scene>
  ),
}

export const NotSignedIn: Story = {
  render: (args) => (
    <Scene {...args} pullRequests={[SUMMARY_NOT_SIGNED_IN]}>
      <Panel pullRequests={[SUMMARY_NOT_SIGNED_IN]} details={{}} environmentLabel="Laptop" />
    </Scene>
  ),
}

export const NotFound: Story = {
  render: (args) => (
    <Scene {...args} pullRequests={[SUMMARY_NOT_FOUND]}>
      <Panel pullRequests={[SUMMARY_NOT_FOUND]} details={{}} />
    </Scene>
  ),
}

export const Unreachable: Story = {
  render: (args) => (
    <Scene {...args} pullRequests={[SUMMARY_UNREACHABLE]}>
      <Panel
        pullRequests={[SUMMARY_UNREACHABLE]}
        details={{ [pullRequestKey(SUMMARY_UNREACHABLE)]: DETAIL_UNREACHABLE }}
      />
    </Scene>
  ),
}

export const DetailError: Story = {
  render: (args) => (
    <Scene {...args} pullRequests={[SUMMARY_OPEN]}>
      <Panel pullRequests={[SUMMARY_OPEN]} details={{}} error="pull_request.get timed out" />
    </Scene>
  ),
}

export const PanelClosed: Story = {
  render: (args) => (
    <Scene {...args} pullRequests={FOUR} panelOpen={false}>
      <Panel pullRequests={FOUR} />
    </Scene>
  ),
}

/** The pill by itself in each shape it takes, for a close look. */
export const Pills: Story = {
  render: ({ theme }) => <PillsView theme={theme} />,
}

function PillsView({ theme }: { theme: Theme }) {
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  const rows: [string, PullRequestSummary[]][] = [
    ['One open', [SUMMARY_OPEN]],
    ['One merged', [SUMMARY_MERGED]],
    ['One draft, failing', [SUMMARY_DRAFT]],
    ['Not read yet', [SUMMARY_NEVER_READ]],
    ['Four', FOUR],
    ['Eight', [...FOUR, ...FOUR]],
  ]
  return (
    <TooltipProvider>
      <StorybookResets />
      <div
        data-pr-scene
        className="flex min-h-svh flex-col gap-4 bg-background p-8 text-foreground"
      >
        {rows.map(([label, prs]) => (
          <div key={label} className="flex items-center gap-4">
            <span className="w-40 text-12-regular text-[var(--basis-text-muted)]">{label}</span>
            <PullRequestPill pullRequests={prs} open={false} onToggle={() => undefined} />
            <PullRequestPill pullRequests={prs} open onToggle={() => undefined} />
          </div>
        ))}
      </div>
    </TooltipProvider>
  )
}

/** The detail view alone, at the panel's width, for each state. */
export const DetailStates: Story = {
  render: ({ theme, panelWidth }) => <DetailStatesView theme={theme} panelWidth={panelWidth} />,
}

function DetailStatesView({ theme, panelWidth }: { theme: Theme; panelWidth: number }) {
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  const cases: [PullRequestSummary, PullRequestDetail | null][] = [
    [SUMMARY_OPEN, OPEN_PASSING],
    [SUMMARY_MERGED, MERGED],
    [SUMMARY_DRAFT, DRAFT_FAILING],
    [SUMMARY_MANY_LABELS, MANY_LABELS],
  ]
  return (
    <TooltipProvider>
      <StorybookResets />
      <div
        data-pr-scene
        className="flex min-h-svh items-start gap-8 overflow-x-auto bg-background p-8 text-foreground"
      >
        {cases.map(([summary, detail]) => (
          <div key={summary.number} className="shrink-0" style={{ width: panelWidth - 32 }}>
            <PullRequestDetailView
              summary={summary}
              detail={detail}
              onOpenOnGitHub={() => undefined}
              environmentLabel="Desktop"
            />
          </div>
        ))}
      </div>
    </TooltipProvider>
  )
}
