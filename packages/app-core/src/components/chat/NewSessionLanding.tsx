import { useMemo } from 'react'
import { useSessionState } from '../../providers/session-provider'
import { useSidebarData, type WorkspaceEntry } from '../../providers/sidebar-provider'
import {
  CaretDownIcon,
  ClockCounterClockwiseIcon,
  FolderSimpleIcon,
  FolderPlusIcon,
  GitBranchIcon,
} from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { ProjectIcon } from '../sidebar/ProjectIcon'
import { SearchableMenu, type SearchableMenuSection } from '../ui/SearchableMenu'

/** How many recent projects the landing offers as one-click chips. */
const RECENT_CHIP_LIMIT = 4

/** "git · 2 providers", or nothing when the host reports no capabilities. */
function describeCapabilities(entry: WorkspaceEntry): string | null {
  const capabilities = entry.capabilities
  if (!capabilities) return null
  const parts: string[] = []
  if (capabilities.git) parts.push('git')
  const count = capabilities.providers.length
  if (count === 1) parts.push(capabilities.providers[0]!)
  else if (count > 1) parts.push(`${count} providers`)
  return parts.length > 0 ? parts.join(' · ') : null
}

export function NewSessionLandingView({
  workspaces,
  recentWorkspaces = [],
  activeWorkspacePath,
  isWorkspacesLoading,
  isStarting,
  onSelectWorkspace,
  onAddWorkspace,
}: {
  workspaces: WorkspaceEntry[]
  /** Most recently active first; the host may omit it. */
  recentWorkspaces?: WorkspaceEntry[]
  activeWorkspacePath: string | null
  isWorkspacesLoading: boolean
  isStarting: boolean
  onSelectWorkspace: (workspacePath: string) => void
  onAddWorkspace: () => void
}) {
  const sections = useMemo<SearchableMenuSection[]>(() => {
    const option = (workspace: WorkspaceEntry) => ({
      id: workspace.path,
      label: workspace.name,
      description: describeCapabilities(workspace) ?? undefined,
      icon: (
        <ProjectIcon
          workspacePath={workspace.path}
          fallbackIcon={FolderSimpleIcon}
          className="h-3.5 w-3.5 text-[var(--basis-text-muted)]"
        />
      ),
      keywords: `${workspace.name} ${workspace.path}`,
    })
    const recent = recentWorkspaces.filter((workspace) => !workspace.missing)
    const recentPaths = new Set(recent.map((workspace) => workspace.path))
    const rest = workspaces.filter((workspace) => !recentPaths.has(workspace.path))
    const result: SearchableMenuSection[] = []
    if (recent.length > 0) {
      result.push({
        id: 'recent',
        label: 'Recent',
        icon: <ClockCounterClockwiseIcon weight="light" className="h-3 w-3" />,
        options: recent.map(option),
      })
    }
    if (rest.length > 0) {
      result.push({
        id: 'projects',
        label: recent.length > 0 ? 'All projects' : undefined,
        options: rest.map(option),
      })
    }
    return result
  }, [recentWorkspaces, workspaces])

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
            Add a project to open a fresh session.
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

  const activeWorkspace =
    workspaces.find((workspace) => workspace.path === activeWorkspacePath) ?? workspaces[0]!
  // Chips offer somewhere else to go; the active project is already chosen.
  const recentChips = recentWorkspaces
    .filter((workspace) => !workspace.missing && workspace.path !== activeWorkspace.path)
    .slice(0, RECENT_CHIP_LIMIT)

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="chat-animate-fade-in -mt-14 text-center">
        <div className="inline-flex max-w-[min(520px,86vw)] flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-16-medium text-[var(--basis-text)]">
          <span>Let&apos;s build in</span>
          <SearchableMenu
            sections={sections}
            value={activeWorkspace.path}
            onSelect={(optionId) => {
              if (optionId !== activeWorkspace.path) onSelectWorkspace(optionId)
            }}
            searchable
            searchPlaceholder="Search projects…"
            emptyText="No projects"
            placement="below"
            align="center"
            minWidth={300}
            maxHeight={360}
            variant="island"
            aria-label="Choose a project"
            footer={({ close }) => (
              <button
                type="button"
                onClick={() => {
                  close()
                  onAddWorkspace()
                }}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] text-[var(--basis-text-faint)] transition-colors hover:bg-[var(--basis-surface)]/70 hover:text-[var(--basis-text-muted)]"
              >
                <FolderPlusIcon weight="light" className="h-3 w-3" />
                Add project
              </button>
            )}
            trigger={({ ref, open, toggle }) => (
              <button
                ref={ref}
                type="button"
                onClick={toggle}
                aria-haspopup="listbox"
                aria-expanded={open}
                className={cn(
                  'inline-flex min-w-0 max-w-full items-center gap-1.5 border-0 bg-transparent p-0 text-16-medium text-[var(--basis-text-strong)] transition-colors',
                  'hover:text-[var(--basis-text)]',
                  open && 'text-[var(--basis-text)]',
                )}
              >
                <ProjectIcon
                  workspacePath={activeWorkspace.path}
                  fallbackIcon={FolderSimpleIcon}
                  className="h-4 w-4 text-[var(--basis-text-muted)]"
                />
                <span className="truncate">{activeWorkspace.name}</span>
                <CaretDownIcon
                  weight="light"
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-[var(--basis-text-faint)] transition-transform',
                    open && 'rotate-180',
                  )}
                />
              </button>
            )}
          />
        </div>

        <div className="mt-3 text-12-regular text-[var(--basis-text-faint)]">
          {isStarting ? 'Starting session…' : 'Start with a message below'}
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
  const { activeWorkspacePath, pendingDraftSessionStart } = useSessionState()
  const { workspaces, recentWorkspaces, isWorkspacesLoading, createSession, addWorkspace } =
    useSidebarData()

  return (
    <NewSessionLandingView
      workspaces={workspaces}
      recentWorkspaces={recentWorkspaces}
      activeWorkspacePath={activeWorkspacePath}
      isWorkspacesLoading={isWorkspacesLoading}
      isStarting={pendingDraftSessionStart}
      onSelectWorkspace={(workspacePath) => void createSession(workspacePath)}
      onAddWorkspace={() => void addWorkspace()}
    />
  )
}
