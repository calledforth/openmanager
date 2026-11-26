// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PullRequestSummary, Subagent } from '@openmanager/protocol'
import { SubagentRail } from '../src/components/chat/SubagentDock'
import { ThemeProvider } from '../src/providers/theme-provider'
import {
  buildLineage,
  lineageCounts,
  type LineageSession,
} from '../src/components/chat/subagent-lineage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as unknown as typeof window.matchMedia

const record = (patch: Partial<Subagent> & Pick<Subagent, 'subagentId'>): Subagent => ({
  parentSessionId: 'root',
  turnId: 't1',
  depth: 1,
  origin: 'native',
  providerId: 'claude',
  title: patch.subagentId,
  status: 'running',
  background: true,
  promptable: false,
  stoppable: false,
  stats: {},
  startedAt: '2026-11-18T10:00:00.000Z',
  updatedAt: '2026-11-18T10:00:00.000Z',
  ...patch,
})

const session = (sessionId: string, patch: Partial<LineageSession> = {}): LineageSession => ({
  sessionId,
  title: sessionId,
  status: 'idle',
  providerId: 'claude',
  threadIds: [`${sessionId}-thread`],
  ...patch,
})

const pr = (number: number, patch: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  url: `https://github.com/acme/app/pull/${number}`,
  repository: 'acme/app',
  number,
  linkedAt: '2026-11-18T10:00:00.000Z',
  title: `Change ${number}`,
  state: 'open',
  labels: [],
  checks: null,
  reviewDecision: null,
  additions: null,
  deletions: null,
  updatedAt: null,
  syncedAt: null,
  problem: null,
  ...patch,
})

function lineageOf(records: Subagent[]) {
  return buildLineage('root', { root: session('root') }, (threadId) =>
    threadId === 'root-thread' ? records : undefined,
  )
}

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
})

function mount(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<ThemeProvider>{node}</ThemeProvider>))
  return host
}

describe('the chat pane right column', () => {
  const records = [
    record({ subagentId: 'explore', title: 'Explore', status: 'completed' }),
    record({
      subagentId: 'review',
      title: 'Review',
      providerId: 'codex',
      startedAt: '2026-11-18T10:01:00.000Z',
    }),
    record({
      subagentId: 'shot',
      title: 'Screenshot',
      status: 'failed',
      statusReason: 'No browser',
      startedAt: '2026-11-18T10:02:00.000Z',
    }),
  ]

  it('keeps every subagent, finished ones too, in the order they started', () => {
    const view = mount(<SubagentRail lineage={lineageOf(records)} />)
    const titles = [...view.querySelectorAll('[data-lineage-node]')].map((row) =>
      row.getAttribute('data-lineage-node'),
    )
    expect(titles).toEqual(['explore', 'review', 'shot'])
    expect(view.querySelector('section[aria-label="Subagents"] div')?.textContent).toBe(
      'Subagents1 running',
    )
    // No folding of finished ones.
    expect(view.textContent).not.toMatch(/Hide done|\d done$/)
    expect(view.querySelector('[aria-label="Done"]')).not.toBeNull()
    expect(view.querySelector('[aria-label="Failed"]')).not.toBeNull()
    expect(view.querySelector('[aria-label="Session in progress"]')).not.toBeNull()
    // A finished one keeps to one line; its reason is on hover.
    expect(view.textContent).not.toContain('No browser')
  })

  it('lists the pull requests above, merged ones included, and opens one on click', () => {
    const onOpen = vi.fn()
    const view = mount(
      <SubagentRail
        lineage={lineageOf([])}
        pullRequests={[pr(12, { checks: 'failing' }), pr(9, { state: 'merged' })]}
        onOpenPullRequest={onOpen}
      />,
    )
    const rows = [...view.querySelectorAll('section[aria-label="Pull requests"] button')]
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Pull request #12, open, checks failing: Change 12',
      'Pull request #9, merged: Change 9',
    ])
    act(() => (rows[1] as HTMLButtonElement).click())
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ number: 9 }))
    expect(view.querySelector('section[aria-label="Subagents"]')).toBeNull()
  })

  it('stays once shown, even when what it listed goes', () => {
    const view = mount(<SubagentRail key="s" lineage={lineageOf(records)} />)
    expect(view.querySelector('aside')).not.toBeNull()
    act(() =>
      root!.render(
        <ThemeProvider>
          <SubagentRail key="s" lineage={lineageOf([])} />
        </ThemeProvider>,
      ),
    )
    expect(view.querySelector('aside')).not.toBeNull()
  })

  it('shows nothing for a chat with no pull requests and no subagents', () => {
    const view = mount(<SubagentRail lineage={lineageOf([])} />)
    expect(view.querySelector('aside')).toBeNull()
  })
})

describe('lineageCounts', () => {
  it('says how many run and wait while any is live, and how they ended after', () => {
    expect(
      lineageCounts(
        lineageOf([
          record({ subagentId: 'a' }),
          record({ subagentId: 'b', status: 'waiting' }),
          record({ subagentId: 'c', status: 'completed' }),
          record({ subagentId: 'd', status: 'completed' }),
          record({ subagentId: 'e', status: 'cancelled' }),
        ]),
      ),
    ).toBe('1 running · 1 waiting')
    expect(
      lineageCounts(
        lineageOf([
          record({ subagentId: 'c', status: 'completed' }),
          record({ subagentId: 'd', status: 'completed' }),
          record({ subagentId: 'e', status: 'failed' }),
        ]),
      ),
    ).toBe('2 done · 1 failed')
    expect(lineageCounts(lineageOf([]))).toBe('')
  })
})
