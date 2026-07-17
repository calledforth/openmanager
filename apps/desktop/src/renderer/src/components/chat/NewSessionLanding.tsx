import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, FolderGit2, FolderPlus } from 'lucide-react'
import { useAppUi } from '../../providers/app-ui-provider'
import { useSidebarData, type WorkspaceEntry } from '../../providers/sidebar-data-provider'
import { cn } from '../../lib/utils'

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
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, open])

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
            <FolderGit2 className="h-4 w-4" strokeWidth={1.6} />
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
            className="mt-4 inline-flex items-center gap-1.5 rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)] px-3 py-1.5 text-12-medium text-[var(--basis-text)] shadow-sm transition-default hover:bg-[var(--basis-surface-hover)]"
          >
            <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
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
        <div className="text-16-medium text-[var(--basis-text)]">Let&apos;s build in</div>

        <div ref={menuRef} className="relative mt-2 inline-flex">
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-haspopup="listbox"
            aria-expanded={open}
            className={cn(
              'group inline-flex max-w-[min(480px,76vw)] items-center gap-2 rounded-xl border px-3 py-1.5 text-20-medium shadow-sm transition-all duration-150',
              'border-[var(--basis-border)] bg-[var(--basis-surface)] text-[var(--basis-text-strong)]',
              'hover:bg-[var(--basis-surface-hover)] hover:shadow-md',
              open && 'bg-[var(--basis-surface-hover)] shadow-md',
            )}
          >
            <FolderGit2
              className="h-4 w-4 shrink-0 text-[var(--basis-text-muted)]"
              strokeWidth={1.6}
            />
            <span className="truncate">{activeWorkspace.name}</span>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-[var(--basis-text-faint)] transition-transform',
                open && 'rotate-180',
              )}
              strokeWidth={1.75}
            />
          </button>

          {open && (
            <div
              role="listbox"
              aria-label="Choose a repository"
              className="absolute left-1/2 top-[calc(100%+8px)] z-40 max-h-64 w-[min(320px,82vw)] -translate-x-1/2 overflow-y-auto rounded-xl border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)] p-1 shadow-xl"
            >
              {workspaces.map((workspace) => {
                const selected = workspace.path === activeWorkspace.path
                return (
                  <button
                    key={workspace.path}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      close()
                      if (!selected) onSelectWorkspace(workspace.path)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-12-regular transition-default',
                      selected
                        ? 'bg-[var(--basis-surface-active)] text-[var(--basis-text-strong)]'
                        : 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
                    )}
                  >
                    <FolderGit2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.6} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{workspace.name}</span>
                      <span className="block truncate text-[10px] text-[var(--basis-text-faint)]">
                        {workspace.path}
                      </span>
                    </span>
                    {selected && <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />}
                  </button>
                )
              })}

              <div className="my-1 h-px bg-[var(--basis-border-muted)]" />
              <button
                type="button"
                onClick={() => {
                  close()
                  onAddWorkspace()
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-12-regular text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]"
              >
                <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.7} />
                Add repository
              </button>
            </div>
          )}
        </div>

        <div className="mt-3 text-12-regular text-[var(--basis-text-faint)]">
          {isStarting ? 'Starting session…' : 'Start with a message below'}
        </div>
      </div>
    </div>
  )
}
