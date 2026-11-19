import type { EnvironmentState } from '@openmanager/environment-client'
import { cn } from '../../lib/utils'
import { useEnvironmentState } from '../../providers/environment-client'
import { useSidebarData } from '../../providers/sidebar-provider'
import { ProjectIcon } from '../sidebar/ProjectIcon'
import { useChildSessionTrail, type ChildSessionTrail } from './SubagentSession'

/**
 * A subagent's parent in the trail, before the subagent's own title: the way
 * back to the session that started it.
 */
export function SessionTrailParent({
  trail,
  className,
}: {
  trail: ChildSessionTrail
  className?: string
}) {
  return (
    <>
      <button
        type="button"
        onClick={trail.openParent}
        title={`Back to ${trail.parentTitle}`}
        data-trail-parent
        className={cn(
          'min-w-0 shrink-[2] cursor-pointer truncate rounded-sm text-left transition-colors hover:text-[var(--basis-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
          className,
        )}
      >
        {trail.parentTitle}
      </button>
      <span aria-hidden className="shrink-0 text-[var(--basis-text-faint)]">
        /
      </span>
    </>
  )
}

/** The subagent's kind (Explore, Plan), set small beside its title. */
export function SessionTrailTag({ children }: { children: string }) {
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-[var(--basis-surface-hover)] px-1.5 text-[11px] leading-none text-[var(--basis-text-muted)]">
      {children}
    </span>
  )
}

const selectActiveTitle = (state: EnvironmentState) =>
  state.activeSessionId ? (state.sessions[state.activeSessionId]?.title ?? null) : null

/**
 * Project / session for the chat pane's topbar, and on a subagent's page
 * project / parent / subagent, the parent a link back. Reads the sidebar
 * contract and the environment, so it only renders inside the environment
 * providers. The title is read on its own: the session list changes far more
 * often than the open session's name, and the topbar has no business
 * rendering for the rest.
 */
export function SessionTrail() {
  const { workspaces, activeWorkspacePath, activeSessionId } = useSidebarData()
  const sessionTitle = useEnvironmentState(selectActiveTitle)
  const child = useChildSessionTrail()
  const project = workspaces.find((workspace) => workspace.path === activeWorkspacePath)
  const title = (activeSessionId && sessionTitle) || 'New session'
  const full = [project?.name, child?.parentTitle, title].filter(Boolean).join(' / ')
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground"
      title={full}
      data-session-trail
    >
      {project ? (
        <>
          <ProjectIcon
            workspacePath={project.path}
            scratch={project.scratch}
            className="h-3.5 w-3.5 shrink-0 opacity-80"
          />
          <span className="min-w-0 shrink truncate">{project.name}</span>
          <span className="shrink-0 text-faint">/</span>
        </>
      ) : null}
      {child ? <SessionTrailParent trail={child} /> : null}
      <span className="min-w-0 truncate text-foreground">{title}</span>
      {child?.agentType ? <SessionTrailTag>{child.agentType}</SessionTrailTag> : null}
    </div>
  )
}
