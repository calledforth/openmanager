import { useMemo } from 'react'
import { CaretDownIcon, FolderSimpleIcon, FolderPlusIcon } from '@phosphor-icons/react'
import { useAppUi } from '../../providers/app-ui-provider'
import { useSidebarData, type WorkspaceEntry } from '../../providers/sidebar-data-provider'
import { cn } from '../../lib/utils'
import { SearchableMenu, type SearchableMenuSection } from '../ui/SearchableMenu'

export function NewSessionLanding() {
  const { activeWorkspacePath, pendingDraftSessionStart } = useAppUi()
  const { workspaces, isWorkspacesLoading, createSession, addWorkspace } = useSidebarData()

  return (
    <NewSessionLandingView
      workspaces={workspaces}
      activeWorkspacePath={activeWorkspacePath}
      isWorkspacesLoading={isWorkspacesLoading}
      isStarting={pendingDraftSessionStart}
      onSelectWorkspace={(workspacePath) => void createSession(workspacePath)}
      onAddWorkspace={() => void addWorkspace()}
    />
  )
}

export function NewSessionLandingView({
  workspaces,
  activeWorkspacePath,
  isWorkspacesLoading,
  isStarting,
  onSelectWorkspace,
  onAddWorkspace,
}: {
  workspaces: WorkspaceEntry[]
  activeWorkspacePath: string | null
  isWorkspacesLoading: boolean
  isStarting: boolean
  onSelectWorkspace: (workspacePath: string) => void
  onAddWorkspace: () => void
}) {
  const sections = useMemo<SearchableMenuSection[]>(
    () => [
      {
        id: 'repositories',
        label: 'Repositories',
        options: workspaces.map((workspace) => ({
          id: workspace.path,
          label: workspace.name,
          description: workspace.path,
          icon: <FolderSimpleIcon weight="light" className="h-3.5 w-3.5" />,
          keywords: `${workspace.name} ${workspace.path}`,
        })),
      },
    ],
    [workspaces],
  )

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
          <div className="text-16-medium text-[var(--basis-text-strong)]">
            Start with a repository
          </div>
          <div className="mt-1 text-12-regular text-[var(--basis-text-muted)]">
            Add a project to open a fresh session.
          </div>
          <button
            type="button"
            onClick={onAddWorkspace}
            className="mt-4 inline-flex items-center gap-1.5 rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface)] px-3 py-1.5 text-12-medium text-[var(--basis-text)] shadow-sm transition-default hover:bg-[var(--basis-surface-hover)]"
          >
            <FolderPlusIcon className="h-3.5 w-3.5" />
            Add repository
          </button>
        </div>
      </div>
    )
  }

  const activeWorkspace =
    workspaces.find((workspace) => workspace.path === activeWorkspacePath) ?? workspaces[0]

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
            searchPlaceholder="Search repositories…"
            emptyText="No repositories"
            placement="below"
            align="center"
            minWidth={320}
            maxHeight={360}
            aria-label="Choose a repository"
            footer={({ close }) => (
              <button
                type="button"
                onClick={() => {
                  close()
                  onAddWorkspace()
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-11-regular text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface)] hover:text-[var(--basis-text)]"
              >
                <FolderPlusIcon weight="light" className="h-3.5 w-3.5" />
                Add repository
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
                  'inline-flex min-w-0 max-w-full items-center gap-1 border-0 bg-transparent p-0 text-16-medium text-[var(--basis-text-strong)] transition-colors',
                  'hover:text-[var(--basis-text)]',
                  open && 'text-[var(--basis-text)]',
                )}
              >
                <FolderSimpleIcon
                  weight="light"
                  className="h-4 w-4 shrink-0 text-[var(--basis-text-muted)]"
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
      </div>
    </div>
  )
}
