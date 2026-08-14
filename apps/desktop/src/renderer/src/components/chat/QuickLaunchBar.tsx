import { useMemo } from 'react'
import { CaretDownIcon, CheckCircleIcon, FolderIcon } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { SearchableMenu, type SearchableMenuSection } from '../ui/SearchableMenu'
import type { WorkspaceEntry } from '../../providers/sidebar-data-provider'

/** The strip above the composer while quick launch is open.
 *
 * It carries the project and nothing else on purpose: the composer's own
 * settings row already renders model, mode and effort, and those controls
 * repoint at the target project the moment it changes. A second copy up here
 * would be two controls writing one preference.
 */
export function QuickLaunchBar({
  workspaces,
  workspacePath,
  onWorkspaceChange,
  onCancel,
  launchedInto,
}: {
  workspaces: WorkspaceEntry[]
  workspacePath: string | null
  onWorkspaceChange: (path: string) => void
  onCancel: () => void
  /** Name of the project a session was just started in, if any. */
  launchedInto: string | null
}) {
  const sections = useMemo<SearchableMenuSection[]>(
    () => [
      {
        id: 'workspaces',
        options: workspaces.map((workspace) => ({
          id: workspace.path,
          label: workspace.name,
          title: workspace.path,
          keywords: workspace.path,
        })),
      },
    ],
    [workspaces],
  )

  const currentName =
    workspaces.find((workspace) => workspace.path === workspacePath)?.name ??
    workspacePath?.split(/[\\/]/).pop() ??
    'Select a project'

  return (
    <div className="flex w-full items-center gap-1.5 px-1 pb-1.5">
      <span className="shrink-0 text-11-regular text-[var(--basis-text-faint)]">New agent in</span>

      <SearchableMenu
        sections={sections}
        value={workspacePath ?? undefined}
        onSelect={(optionId) => onWorkspaceChange(optionId)}
        searchable={workspaces.length > 6}
        searchPlaceholder="Search projects…"
        emptyText="No projects"
        minWidth={220}
        maxHeight={280}
        aria-label="Select project"
        trigger={({ ref, open, toggle }) => (
          <button
            ref={ref}
            type="button"
            onClick={toggle}
            className={cn(
              'flex max-w-[240px] items-center gap-1 rounded-full border px-2 py-1',
              'text-11-regular text-[var(--basis-text)] transition-colors duration-150',
              'border-[var(--basis-border-muted)] bg-[var(--basis-surface)]',
              'hover:border-[var(--basis-border)] hover:bg-[var(--basis-surface-hover)]',
              open && 'border-[var(--basis-border)] bg-[var(--basis-surface-hover)]',
            )}
          >
            <FolderIcon size={11} className="shrink-0 text-[var(--basis-text-faint)]" />
            <span className="truncate">{currentName}</span>
            <CaretDownIcon
              size={10}
              weight="light"
              className="shrink-0 text-[var(--basis-text-faint)]"
            />
          </button>
        )}
      />

      {/* Confirmation lives here rather than in a toast: the launch is silent by
          design, so the acknowledgement belongs on the control that caused it. */}
      {launchedInto ? (
        <span className="flex min-w-0 items-center gap-1 text-11-regular text-[var(--basis-text-muted)]">
          <CheckCircleIcon size={11} weight="fill" className="shrink-0 text-emerald-500" />
          <span className="truncate">Started in {launchedInto}</span>
        </span>
      ) : null}

      <button
        type="button"
        onClick={onCancel}
        className="ml-auto shrink-0 rounded px-1 py-0.5 text-11-regular text-[var(--basis-text-faint)] transition-colors hover:text-[var(--basis-text)]"
      >
        Esc to cancel
      </button>
    </div>
  )
}
