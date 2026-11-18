import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { GitPullRequestIcon, NotePencilIcon } from '@phosphor-icons/react'
import type { EnvironmentState } from '@openmanager/environment-client'
import { useEnvironmentState } from '@openmanager/app-core/providers/environment-client'
import { SidePanel, useSidePanel } from '@openmanager/app-core/components/side-panel/SidePanel'
import { PanelDeck, type PanelView } from '@openmanager/app-core/components/side-panel/PanelDeck'
import {
  PullRequestPill,
  PullRequestsPanel,
  pullRequestKey,
  pullRequestsSummary,
} from '@openmanager/app-core/components/pull-requests'
import {
  ScratchpadPanel,
  scratchpadSummary,
} from '@openmanager/app-core/components/scratchpad/ScratchpadPanel'
import {
  usePullRequestDetail,
  useSessionPullRequests,
} from '@openmanager/app-core/lib/pull-requests'
import { useScratchpad } from '@openmanager/app-core/lib/scratchpad'
import { useNow } from '@openmanager/app-core/lib/relative-time'
import { SCRATCHPAD_PATH, type PullRequestSummary } from '@openmanager/protocol'

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

/** The project the open session runs in, when it is a real one ("No project" has no scratchpad). */
const selectProject = (state: EnvironmentState) => {
  const workspaceId = state.activeSessionId
    ? state.sessions[state.activeSessionId]?.workspaceId
    : undefined
  const workspace = workspaceId ? state.workspaces[workspaceId] : undefined
  return workspace && workspace.kind !== 'scratch' ? workspace : null
}

const selectScratchpadSupported = (state: EnvironmentState) =>
  state.connection.capabilities.includes('scratchpad.get')

/**
 * The session view's right-hand panel: a deck holding the pull requests
 * linked to the open session and its project's scratchpad. It is there
 * whenever the session belongs to a real project; on an environment too old
 * for scratchpads it is there only while the session links a pull request,
 * as before. `]` opens it on the overview; the pull request pill (shown
 * while there are any) opens it straight to them.
 */
export function SessionSidePanel() {
  const sessionId = useEnvironmentState(selectRootSessionId)
  const project = useEnvironmentState(selectProject)
  const scratchpadSupported = useEnvironmentState(selectScratchpadSupported)
  const pullRequests = useSessionPullRequests(null, sessionId)
  // Which view the deck shows; null is its overview.
  const [view, setView] = useState<string | null>(null)
  const scratchpad = scratchpadSupported && project !== null
  if (!sessionId || (!scratchpad && pullRequests.length === 0)) return null
  return (
    <SidePanel
      available
      title={scratchpad ? 'Side panel' : 'Pull requests'}
      pill={
        pullRequests.length > 0 ? (
          <Pill pullRequests={pullRequests} view={view} onView={setView} />
        ) : null
      }
    >
      <Content
        key={sessionId}
        sessionId={sessionId}
        pullRequests={pullRequests}
        project={scratchpad ? project : null}
        view={view}
        onView={setView}
      />
    </SidePanel>
  )
}

function Pill({
  pullRequests,
  view,
  onView,
}: {
  pullRequests: readonly PullRequestSummary[]
  view: string | null
  onView: (view: string | null) => void
}) {
  const { open, setOpen, shortcut } = useSidePanel()
  const showing = open && view === PULL_REQUESTS
  return (
    <PullRequestPill
      pullRequests={pullRequests as PullRequestSummary[]}
      open={showing}
      onToggle={() => {
        if (showing) {
          setOpen(false)
          return
        }
        onView(PULL_REQUESTS)
        setOpen(true)
      }}
      shortcut={shortcut}
    />
  )
}

const PULL_REQUESTS = 'prs'
const SCRATCHPAD = 'scratchpad'

function Content({
  sessionId,
  pullRequests,
  project,
  view,
  onView,
}: {
  sessionId: string
  pullRequests: readonly PullRequestSummary[]
  /** The session's project, when it has a scratchpad to show. */
  project: { workspaceId: string; name: string } | null
  view: string | null
  onView: (view: string | null) => void
}) {
  // The collapsed rail stays mounted on desktop: only an open panel is viewing.
  const { open } = useSidePanel()
  // Shut, the panel forgets where it was: `]` opens it on the overview.
  useEffect(() => {
    if (!open) onView(null)
  }, [open, onView])
  const pullRequestsView = usePullRequestsView(sessionId, pullRequests, open)
  const scratchpadView = useScratchpadView(project)
  const views = scratchpadView ? [pullRequestsView, scratchpadView] : [pullRequestsView]
  // A view that is not in the deck (the project lost its scratchpad) reads as the overview.
  const current = views.some((item) => item.id === view) ? view : null
  return (
    <PanelDeck
      views={views}
      current={current}
      onNavigate={onView}
      active={open}
      className="h-full"
    />
  )
}

function usePullRequestsView(
  sessionId: string,
  pullRequests: readonly PullRequestSummary[],
  open: boolean,
): PanelView {
  const environmentName = useEnvironmentState(selectEnvironmentName)
  // Several open on the list; the one opened from it is shown in full. With
  // a single pull request there is no list, and that one is the page.
  const [openKey, setOpenKey] = useState<string | null>(null)
  const opened =
    pullRequests.find((pr) => pullRequestKey(pr) === openKey) ??
    (pullRequests.length === 1 ? pullRequests[0] : undefined) ??
    null
  const { detail, loading, error } = usePullRequestDetail(
    null,
    sessionId,
    opened?.repository,
    opened?.number,
    { viewing: open },
  )
  const openOnGitHub = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [])
  return {
    id: PULL_REQUESTS,
    shortcut: 'p',
    label: 'Pull requests',
    icon: GitPullRequestIcon,
    count: pullRequests.length || null,
    summary: pullRequestsSummary(pullRequests),
    attention: pullRequests.some((pr) => pr.checks === 'failing') ? 'alert' : null,
    content: (
      <PullRequestsPanel
        pullRequests={pullRequests as PullRequestSummary[]}
        openKey={openKey}
        onOpen={setOpenKey}
        detail={detail ?? null}
        detailLoading={loading}
        detailError={error}
        onOpenOnGitHub={openOnGitHub}
        environmentLabel={environmentName}
        className="h-full"
      />
    ),
  }
}

function useScratchpadView(
  project: { workspaceId: string; name: string } | null,
): PanelView | null {
  const now = useNow()
  const scratchpad = useScratchpad(project?.workspaceId ?? null)
  // The hook's handlers are stable per project; the panel takes them as they are.
  const { onChange, onMarkSeen, onDiscard, onShareWithAgentsChange } = scratchpad
  if (!project || !scratchpad.supported) return null
  return {
    id: SCRATCHPAD,
    shortcut: 's',
    label: 'Scratchpad',
    icon: NotePencilIcon,
    summary: scratchpad.loading
      ? null
      : scratchpad.tooLarge
        ? 'Too large to show here'
        : scratchpadSummary(scratchpad.content, scratchpad.lastEdit, now),
    attention: scratchpad.unseen ? 'notice' : null,
    content: scratchpad.loading ? (
      // Read on every connection; nothing to show until the first answer.
      <div className="h-full" aria-busy />
    ) : scratchpad.tooLarge || (scratchpad.error && scratchpad.content === '') ? (
      <ScratchpadNotice>
        {scratchpad.tooLarge ? (
          <>
            <code>{SCRATCHPAD_PATH}</code> is too large to edit here. Open it in an editor.
          </>
        ) : (
          scratchpad.error
        )}
      </ScratchpadNotice>
    ) : (
      <div className="flex h-full min-h-0 flex-col">
        {/* Why text is not being saved (the file outgrew the panel), above the text kept. */}
        {scratchpad.error ? (
          <div
            role="alert"
            className="mx-2 mb-1 flex shrink-0 items-start gap-2 rounded-lg bg-hover py-1.5 pr-1.5 pl-2.5"
          >
            <p className="min-w-0 flex-1 text-12-regular leading-[1.5] text-[var(--basis-status-error)]">
              {scratchpad.error}
            </p>
            {scratchpad.saveState === 'error' ? (
              <button
                type="button"
                onClick={onDiscard}
                className="h-6 shrink-0 cursor-pointer rounded-md px-2 text-11-medium text-[var(--basis-text-muted)] transition-colors hover:bg-hover hover:text-[var(--basis-text-strong)] focus-visible:outline-2 focus-visible:outline-ring"
              >
                Discard mine
              </button>
            ) : null}
          </div>
        ) : null}
        <ScratchpadPanel
          projectName={project.name}
          content={scratchpad.content}
          onChange={onChange}
          lastEdit={scratchpad.lastEdit}
          unseen={scratchpad.unseen}
          onMarkSeen={onMarkSeen}
          shareWithAgents={scratchpad.shareWithAgents}
          onShareWithAgentsChange={onShareWithAgentsChange}
          saveState={scratchpad.saveState}
          className="min-h-0 flex-1"
        />
      </div>
    ),
  }
}

function ScratchpadNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-8 text-center">
      <p className="text-12-regular leading-[1.5] text-[var(--basis-text-muted)]">{children}</p>
    </div>
  )
}
