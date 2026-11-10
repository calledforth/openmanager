import { useCallback, useEffect, useState } from 'react'
import type { EnvironmentState } from '@openmanager/environment-client'
import { useEnvironmentState } from '@openmanager/app-core/providers/environment-client'
import { SidePanel, useSidePanel } from '@openmanager/app-core/components/side-panel/SidePanel'
import {
  PullRequestPill,
  PullRequestsPanel,
  pullRequestKey,
} from '@openmanager/app-core/components/pull-requests'
import {
  usePullRequestDetail,
  useSessionPullRequests,
} from '@openmanager/app-core/lib/pull-requests'
import type { PullRequestSummary } from '@openmanager/protocol'

/**
 * Links are kept on the root session (a sub-agent's pull request belongs to
 * the chat that started it), so a child session shows its root's list.
 */
const selectRootSessionId = (state: EnvironmentState): string | null => {
  let id = state.activeSessionId
  const seen = new Set<string>()
  while (id && !seen.has(id)) {
    seen.add(id)
    const parent = state.sessions[id]?.parentSessionId
    if (!parent || !state.sessions[parent]) return id
    id = parent
  }
  return id ?? null
}

const selectEnvironmentName = (state: EnvironmentState) => state.environment?.name ?? null

/**
 * The session view's right-hand panel: the pull requests linked to the open
 * session. The pill and the panel only exist while the session links at
 * least one, so `]` does nothing and no pill shows otherwise.
 */
export function SessionSidePanel() {
  const sessionId = useEnvironmentState(selectRootSessionId)
  const pullRequests = useSessionPullRequests(null, sessionId)
  if (!sessionId || pullRequests.length === 0) return null
  return (
    <SidePanel available title="Pull requests" pill={<Pill pullRequests={pullRequests} />}>
      <Content key={sessionId} sessionId={sessionId} pullRequests={pullRequests} />
    </SidePanel>
  )
}

function Pill({ pullRequests }: { pullRequests: readonly PullRequestSummary[] }) {
  const { open, toggle, shortcut } = useSidePanel()
  return (
    <PullRequestPill
      pullRequests={pullRequests as PullRequestSummary[]}
      open={open}
      onToggle={toggle}
      shortcut={shortcut}
    />
  )
}

function Content({
  sessionId,
  pullRequests,
}: {
  sessionId: string
  pullRequests: readonly PullRequestSummary[]
}) {
  const environmentName = useEnvironmentState(selectEnvironmentName)
  // The newest link first: it is usually the one the agent just opened.
  const newest = pullRequests[pullRequests.length - 1]
  const [selectedKey, setSelectedKey] = useState<string | null>(
    newest ? pullRequestKey(newest) : null,
  )
  const selected = pullRequests.find((pr) => pullRequestKey(pr) === selectedKey) ?? newest ?? null
  // A newly linked pull request takes the selection, like a new message
  // takes the chat's attention.
  const newestKey = newest ? pullRequestKey(newest) : null
  useEffect(() => {
    if (newestKey) setSelectedKey(newestKey)
  }, [newestKey])

  const { detail, loading, error } = usePullRequestDetail(
    null,
    sessionId,
    selected?.repository,
    selected?.number,
  )
  const openOnGitHub = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [])

  return (
    <PullRequestsPanel
      pullRequests={pullRequests as PullRequestSummary[]}
      selectedKey={selected ? pullRequestKey(selected) : null}
      onSelect={setSelectedKey}
      detail={detail ?? null}
      detailLoading={loading}
      detailError={error}
      onOpenOnGitHub={openOnGitHub}
      environmentLabel={environmentName}
      className="h-full"
    />
  )
}
