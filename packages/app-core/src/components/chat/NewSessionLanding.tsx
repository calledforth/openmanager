import { useSessionState } from '../../providers/session-provider'
import { useSidebarData, type WorkspaceEntry } from '../../providers/sidebar-provider'
import { FolderSimpleIcon, FolderPlusIcon, GitBranchIcon } from '@phosphor-icons/react'
import { EnvironmentLabel } from '../sidebar/EnvironmentLabel'
import { ProjectIcon } from '../sidebar/ProjectIcon'
import { ProjectPicker, describeCapabilities } from './ProjectPicker'

/** How many recent projects the landing offers as one-click chips. */
const RECENT_CHIP_LIMIT = 4

export function NewSessionLandingView({
  environmentLabel,
  workspaces,
  recentWorkspaces = [],
  activeWorkspacePath,
  isWorkspacesLoading,
  isStarting,
  draftWithoutProject = false,
  onSelectWorkspace,
  onAddWorkspace,
}: {
  /** Where the session will run; omitted, no environment copy shows. */
  environmentLabel?: string
  workspaces: WorkspaceEntry[]
  /** Most recently active first; the host may omit it. */
  recentWorkspaces?: WorkspaceEntry[]
  activeWorkspacePath: string | null
  isWorkspacesLoading: boolean
  isStarting: boolean
  /** The open draft's project was removed: it waits for another to be picked. */
  draftWithoutProject?: boolean
  onSelectWorkspace: (workspacePath: string) => void
  onAddWorkspace: () => void
}) {
  if (isWorkspacesLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="flex items-center gap-2 text-12-regular text-[var(--basis-text-faint)]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--basis-text-faint)]" />
          Opening your workspace
        </div>
      </div>
    )
  }

  if (workspaces.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--basis-border)] bg-[var(--basis-surface)] text-[var(--basis-text-muted)] shadow-sm">
            <FolderSimpleIcon className="h-4 w-4" />
          </div>
          <div className="text-16-medium text-[var(--basis-text-strong)]">Start with a project</div>
          <div className="mt-1 text-12-regular text-[var(--basis-text-muted)]">
            {environmentLabel
              ? `Add a folder on ${environmentLabel} to open a fresh session.`
              : 'Add a project to open a fresh session.'}
          </div>
          <button
            type="button"
            onClick={onAddWorkspace}
            className="mt-4 inline-flex items-center gap-1.5 rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface)] px-3 py-1.5 text-12-medium text-[var(--basis-text)] shadow-sm transition-default hover:bg-[var(--basis-surface-hover)]"
          >
            <FolderPlusIcon className="h-3.5 w-3.5" />
            Add project
          </button>
        </div>
      </div>
    )
  }

  const activeWorkspace = draftWithoutProject
    ? null
    : (workspaces.find((workspace) => workspace.path === activeWorkspacePath) ?? workspaces[0]!)
  // Chips offer somewhere else to go; the active project is already chosen.
  const recentChips = recentWorkspaces
    .filter((workspace) => !workspace.missing && workspace.path !== activeWorkspace?.path)
    .slice(0, RECENT_CHIP_LIMIT)
  // The draft stays with a project whose folder is gone, so nothing typed is
  // hidden; it is said here, and another project is one pick away.
  const unavailable = draftWithoutProject
    ? 'This draft’s project was removed. Pick another to send it.'
    : activeWorkspace && activeWorkspace.path === activeWorkspacePath && activeWorkspace.missing
      ? `${activeWorkspace.name} is unavailable. Pick another project to send this draft.`
      : null

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="chat-animate-fade-in -mt-14 text-center">
        <div className="inline-flex max-w-[min(520px,86vw)] flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-16-medium text-[var(--basis-text)]">
          <span>Let&apos;s build in</span>
          <ProjectPicker
            workspaces={workspaces}
            recentWorkspaces={recentWorkspaces}
            activeWorkspace={activeWorkspace}
            environmentLabel={environmentLabel}
            onSelect={(workspacePath) => {
              // With nothing open the first project is only what the picker
              // shows, so choosing it must still open it.
              if (draftWithoutProject || workspacePath !== activeWorkspacePath) {
                onSelectWorkspace(workspacePath)
              }
            }}
            onAddWorkspace={onAddWorkspace}
          />
        </div>

        <div className="mt-3 flex items-center justify-center gap-1.5 text-12-regular text-[var(--basis-text-faint)]">
          {environmentLabel && (
            <>
              <EnvironmentLabel label={environmentLabel} className="max-w-[240px]" />
              <span aria-hidden>·</span>
            </>
          )}
          <span>
            {isStarting ? 'Starting session…' : (unavailable ?? 'Start with a message below')}
          </span>
        </div>

        {recentChips.length > 0 && (
          <div
            aria-label="Recent projects"
            className="mt-6 flex max-w-[min(560px,90vw)] flex-wrap items-center justify-center gap-1.5"
          >
            {recentChips.map((workspace) => {
              const summary = describeCapabilities(workspace)
              return (
                <button
                  key={workspace.path}
                  type="button"
                  onClick={() => onSelectWorkspace(workspace.path)}
                  disabled={isStarting}
                  title={workspace.path}
                  className="group inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-[var(--basis-border)] bg-[var(--basis-surface)] py-1 pl-2 pr-2.5 text-12-regular text-[var(--basis-text-muted)] shadow-sm transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)] disabled:opacity-60"
                >
                  <ProjectIcon
                    workspacePath={workspace.path}
                    fallbackIcon={FolderSimpleIcon}
                    className="h-3.5 w-3.5 shrink-0 text-[var(--basis-text-faint)]"
                  />
                  <span className="truncate">{workspace.name}</span>
                  {workspace.capabilities?.git && (
                    <GitBranchIcon
                      weight="light"
                      aria-label="git repository"
                      className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]"
                    />
                  )}
                  {summary && <span className="sr-only">{summary}</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** The landing bound to session state and the sidebar contract. */
export function NewSessionLanding() {
  const {
    activeWorkspacePath,
    pendingDraftSessionStart,
    isSessionDraftOpen,
    isDraftLoading,
    isDraftProjectRemoved,
    setDraftWorkspace,
  } = useSessionState()
  const {
    environment,
    workspaces,
    recentWorkspaces,
    isWorkspacesLoading,
    createSession,
    addWorkspace,
  } = useSidebarData()

  return (
    <NewSessionLandingView
      environmentLabel={environment?.label}
      workspaces={workspaces}
      recentWorkspaces={recentWorkspaces}
      activeWorkspacePath={activeWorkspacePath}
      // A draft named by its address shows once it is known, never a blank
      // page that it would then replace.
      isWorkspacesLoading={isWorkspacesLoading || !!isDraftLoading}
      isStarting={pendingDraftSessionStart}
      draftWithoutProject={!!isDraftProjectRemoved}
      // Where drafts have pages, picking a project moves the open draft with
      // everything in it; elsewhere, or with none open, it opens one there.
      onSelectWorkspace={(workspacePath) =>
        isSessionDraftOpen && setDraftWorkspace
          ? setDraftWorkspace(workspacePath)
          : void createSession(workspacePath)
      }
      onAddWorkspace={() => void addWorkspace()}
    />
  )
}
