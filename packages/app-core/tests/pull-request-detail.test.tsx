// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  pullRequestDetailKey,
  type EnvironmentClient,
  type EnvironmentState,
} from '@openmanager/environment-client'
import type { PullRequestDetail, PullRequestSummary } from '@openmanager/protocol'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import {
  PULL_REQUEST_WATCH_RENEW_MS,
  usePullRequestDetail,
} from '../src/lib/pull-requests/use-pull-requests'

const SUMMARY: PullRequestSummary = {
  url: 'https://github.com/o/r/pull/7',
  repository: 'o/r',
  number: 7,
  linkedAt: '2026-11-10T10:00:00.000Z',
  title: 'A change',
  state: 'open',
  labels: [],
  checks: 'passing',
  reviewDecision: null,
  additions: 1,
  deletions: 1,
  updatedAt: '2026-11-10T10:00:00.000Z',
  syncedAt: '2026-11-10T10:00:00.000Z',
  problem: null,
}

const DETAIL: PullRequestDetail = {
  ...SUMMARY,
  body: '',
  author: null,
  headRef: 'feat',
  baseRef: 'main',
  createdAt: '2026-11-10T09:00:00.000Z',
  mergedAt: null,
  closedAt: null,
  changedFiles: 1,
  commits: 1,
  reviewers: [],
  checkRuns: [],
}

/** Just what the hook reads: one session's summary, a held detail, the ask. */
function fakeClient(held: PullRequestDetail | undefined) {
  const asks: unknown[] = []
  const state = {
    environment: { environmentId: 'env-1', name: 'Env' },
    sessions: { 'session-1': { pullRequests: [SUMMARY] } },
    pullRequestDetails: held ? { [pullRequestDetailKey(SUMMARY)]: held } : {},
  } as unknown as EnvironmentState
  const client = {
    getState: () => state,
    subscribe: () => () => undefined,
    supports: (name: string) => name === 'getPullRequest',
    commands: {
      getPullRequest: async (input: unknown) => {
        asks.push(input)
        return held ?? DETAIL
      },
    },
  } as unknown as EnvironmentClient
  return { client, asks }
}

function Probe({ viewing }: { viewing: boolean }) {
  usePullRequestDetail(null, 'session-1', 'o/r', 7, { viewing })
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('a pull request detail', () => {
  it('asks only while viewed, once on opening even when current, and renews while open', async () => {
    const { client, asks } = fakeClient(DETAIL)
    const render = (viewing: boolean) =>
      act(() =>
        root.render(
          <EnvironmentClientProvider client={client}>
            <Probe viewing={viewing} />
          </EnvironmentClientProvider>,
        ),
      )
    // A collapsed panel stays mounted: it is not viewing, and asks nothing.
    render(false)
    await act(async () => void vi.advanceTimersByTime(PULL_REQUEST_WATCH_RENEW_MS * 2))
    expect(asks).toHaveLength(0)
    // Opened on a current detail: one ask, so the environment knows.
    render(true)
    await act(async () => void (await Promise.resolve()))
    expect(asks).toEqual([{ sessionId: 'session-1', repository: 'o/r', number: 7 }])
    await act(async () => void vi.advanceTimersByTime(PULL_REQUEST_WATCH_RENEW_MS))
    expect(asks).toHaveLength(2)
    // Shut again: the renewals stop.
    render(false)
    await act(async () => void vi.advanceTimersByTime(PULL_REQUEST_WATCH_RENEW_MS * 2))
    expect(asks).toHaveLength(2)
    // And every opening asks again.
    render(true)
    await act(async () => void (await Promise.resolve()))
    expect(asks).toHaveLength(3)
  })
})
