import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, FolderPlus, GitBranch, Pencil, Plus, SquarePen, Trash2 } from 'lucide-react'
import type { ProviderId } from '@agentpack/contract'
import { describeUnavailableWorkspace } from '../../lib/workspace-availability'
import { cn } from '../../lib/utils'
import type { IconComponent, IconComponentProps } from '../fluid/lib/icon-context'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupActions,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuActions,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '../fluid/ui/sidebar'
import { SidebarWorkspaceHeader, WorkspaceTile } from '../fluid/sidebar-app/workspace-header'
import { ProviderIcon } from '../providers/ProviderIcon'
import { Tooltip } from '../ui/Tooltip'
import { SessionBusyLoader, sessionBusyTone } from './SessionBusyLoader'
import {
  flattenSidebarSessions,
  isSidebarSessionActive,
  type SidebarWorkspace,
} from './WorkspaceSidebarView'

const SESSION_PREVIEW_LIMIT = 5
const SESSION_PAGE_SIZE = 10

// Fluid rows take an icon component; provider marks need their id bound in.
const providerIcons = new Map<ProviderId, IconComponent>()
function providerIcon(providerId: ProviderId): IconComponent {
  let icon = providerIcons.get(providerId)
  if (!icon) {
    const ProviderRowIcon = ({ size = 16, className }: IconComponentProps) => (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', className)}
        style={{ width: size, height: size }}
      >
        <ProviderIcon providerId={providerId} className="h-3.5 w-3.5 opacity-70" />
      </span>
    )
    icon = ProviderRowIcon
    providerIcons.set(providerId, icon)
  }
  return icon
}

export interface FluidWorkspaceSidebarViewProps {
  environmentLabel?: string
  workspaces: SidebarWorkspace[]
  activeWorkspacePath: string | null
  activeSessionId: string | null
  collapsedWorkspacePaths: string[]
  onToggleWorkspaceCollapse: (path: string) => void
  onCreateSession: (workspacePath: string) => void
  onSelectSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  onRenameSession?: (workspacePath: string, externalId: string, title: string | null) => void
  onDeleteSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  onAddWorkspace: () => void
  /** Rows under the project list, anchored to the sidebar's outer edge. */
  footer?: ReactNode
}

/**
 * The project sidebar on Fluid Functionalism's sidebar: one collapsible
 * group per project, sessions as menu rows with hover actions. Must render
 * inside a Fluid `SidebarProvider`, next to a `SidebarInset`.
 */
export function FluidWorkspaceSidebarView({
  environmentLabel,
  workspaces,
  activeWorkspacePath,
  activeSessionId,
  collapsedWorkspacePaths,
  onToggleWorkspaceCollapse,
  onCreateSession,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onAddWorkspace,
  footer,
}: FluidWorkspaceSidebarViewProps) {
  const collapsedSet = new Set(collapsedWorkspacePaths)
  const present = (path: string | null) =>
    path !== null && workspaces.some((workspace) => workspace.path === path && !workspace.missing)
  const newThreadTarget = present(activeWorkspacePath)
    ? activeWorkspacePath
    : (workspaces.find((workspace) => !workspace.missing)?.path ?? null)
  const name = environmentLabel ?? 'OpenManager'

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarWorkspaceHeader
          name={name}
          tile={<WorkspaceTile>{name.charAt(0).toUpperCase()}</WorkspaceTile>}
        />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              icon={SquarePen}
              disabled={!newThreadTarget}
              onClick={() => {
                if (newThreadTarget) onCreateSession(newThreadTarget)
              }}
            >
              New agent
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton icon={FolderPlus} onClick={onAddWorkspace}>
              Add project
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {workspaces.length === 0 ? (
          <p className="px-4 py-5 text-[13px] text-muted-foreground">No projects yet</p>
        ) : null}
        {workspaces.map((workspace) => (
          <ProjectGroup
            key={workspace.path}
            workspace={workspace}
            environmentLabel={environmentLabel}
            isActiveWorkspace={workspace.path === activeWorkspacePath}
            activeSessionId={activeSessionId}
            isCollapsed={collapsedSet.has(workspace.path)}
            onToggleCollapse={() => onToggleWorkspaceCollapse(workspace.path)}
            onSelectSession={onSelectSession}
            onCreateSession={onCreateSession}
            onRenameSession={onRenameSession}
            onDeleteSession={onDeleteSession}
          />
        ))}
      </SidebarContent>

      {footer ? <SidebarFooter>{footer}</SidebarFooter> : null}
    </Sidebar>
  )
}

function ProjectGroup({
  workspace,
  environmentLabel,
  isActiveWorkspace,
  activeSessionId,
  isCollapsed,
  onToggleCollapse,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
}: {
  workspace: SidebarWorkspace
  environmentLabel?: string
  isActiveWorkspace: boolean
  activeSessionId: string | null
  isCollapsed: boolean
  onToggleCollapse: () => void
  onSelectSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  onCreateSession: (workspacePath: string) => void
  onRenameSession?: (workspacePath: string, externalId: string, title: string | null) => void
  onDeleteSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  // Enter and blur both commit, Escape abandons. The ref makes whichever fires
  // first win, so the blur that follows a submit cannot rename a second time.
  const renamingRef = useRef<string | null>(null)
  const startRename = (externalId: string, title: string | null | undefined) => {
    renamingRef.current = externalId
    setEditingId(externalId)
    setDraftTitle(title ?? '')
  }
  const finishRename = (externalId: string, commit: boolean) => {
    if (renamingRef.current !== externalId) return
    renamingRef.current = null
    setEditingId(null)
    if (commit) onRenameSession?.(workspace.path, externalId, draftTitle.trim() || null)
  }
  const focusTitleInput = useCallback((input: HTMLInputElement | null) => {
    input?.focus()
    input?.select()
  }, [])

  const [visibleCount, setVisibleCount] = useState(SESSION_PREVIEW_LIMIT)
  const orderedSessions = useMemo(
    () => flattenSidebarSessions(workspace.sessions),
    [workspace.sessions],
  )
  const visibleSessions = orderedSessions.slice(0, visibleCount)
  const hasMoreSessions = orderedSessions.length > visibleCount
  // A collapsed project still says it has something in flight.
  const busyWhileCollapsed =
    isCollapsed && orderedSessions.some(({ session }) => isSidebarSessionActive(session.status))

  useEffect(() => {
    if (isCollapsed) setVisibleCount(SESSION_PREVIEW_LIMIT)
  }, [isCollapsed])

  useEffect(() => {
    if (isCollapsed || !isActiveWorkspace || !activeSessionId) return
    const activeIndex = orderedSessions.findIndex(
      ({ session }) => session.externalId === activeSessionId,
    )
    if (activeIndex >= 0) setVisibleCount((count) => Math.max(count, activeIndex + 1))
  }, [isCollapsed, isActiveWorkspace, activeSessionId, orderedSessions])

  const unavailable = workspace.missing ? describeUnavailableWorkspace(workspace.availability) : null

  return (
    <SidebarGroup
      collapsible
      open={!isCollapsed}
      onOpenChange={(open) => {
        if (open === isCollapsed) onToggleCollapse()
      }}
    >
      <SidebarGroupLabel>
        <span className={cn(workspace.missing && 'line-through decoration-faint')}>
          {workspace.name}
        </span>
        {busyWhileCollapsed ? <SessionBusyLoader tone="working" className="ml-1.5" /> : null}
      </SidebarGroupLabel>
      <SidebarGroupActions>
        {unavailable ? (
          <Tooltip content={unavailable.reason} side="bottom">
            <span
              className="rounded-sm px-1 text-[10px] leading-none text-faint"
              aria-label={unavailable.reason}
            >
              {unavailable.badge}
            </span>
          </Tooltip>
        ) : (
          <Tooltip content="New agent in this project" side="top">
            <SidebarGroupAction
              aria-label="New agent in this project"
              onClick={() => onCreateSession(workspace.path)}
            >
              <Plus />
            </SidebarGroupAction>
          </Tooltip>
        )}
      </SidebarGroupActions>
      <SidebarMenu>
        {visibleSessions.map(({ session: s, depth, isChild }) => {
          const isActive = isActiveWorkspace && s.externalId === activeSessionId
          const providerId = s.providerId ?? 'opencode'
          // Ready/done only matters for sessions you haven't opened yet —
          // the focused transcript already shows the finished turn.
          const tone = s.status === 'done' && isActive ? null : sessionBusyTone(s.status)
          if (editingId === s.externalId) {
            return (
              <SidebarMenuItem key={s.externalId}>
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    finishRename(s.externalId, true)
                  }}
                >
                  <SidebarInput
                    ref={focusTitleInput}
                    aria-label="Session title"
                    maxLength={512}
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    onBlur={() => finishRename(s.externalId, true)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') finishRename(s.externalId, false)
                    }}
                  />
                </form>
              </SidebarMenuItem>
            )
          }
          return (
            <SidebarMenuItem key={s.externalId}>
              <SidebarMenuButton
                icon={isChild ? GitBranch : providerIcon(providerId)}
                isActive={isActive}
                className={cn(s.workspaceUnavailable && 'text-muted-foreground')}
                style={depth > 0 ? { paddingLeft: 8 + Math.min(depth, 4) * 12 } : undefined}
                onClick={() => onSelectSession(workspace.path, s.externalId, providerId)}
              >
                <span className="truncate">{s.title || 'New session'}</span>
                {/* The header names the environment for sighted users; the
                    row still says it so a row read alone is unambiguous. */}
                {environmentLabel ? <span className="sr-only"> on {environmentLabel}</span> : null}
              </SidebarMenuButton>
              {tone ? (
                <SidebarMenuBadge>
                  <SessionBusyLoader tone={tone} />
                </SidebarMenuBadge>
              ) : null}
              {/* Built as a list so the cluster reserves exactly the actions it shows. */}
              <SidebarMenuActions showOnHover>
                {[
                  onRenameSession ? (
                    <SidebarMenuAction
                      key="rename"
                      aria-label="Rename session"
                      onClick={() => startRename(s.externalId, s.title)}
                    >
                      <Pencil />
                    </SidebarMenuAction>
                  ) : null,
                  <SidebarMenuAction
                    key="delete"
                    aria-label="Delete session"
                    onClick={() => onDeleteSession(workspace.path, s.externalId, providerId)}
                  >
                    <Trash2 />
                  </SidebarMenuAction>,
                ].filter(Boolean)}
              </SidebarMenuActions>
            </SidebarMenuItem>
          )
        })}
        {hasMoreSessions ? (
          <SidebarMenuItem>
            <SidebarMenuButton
              icon={ChevronDown}
              className="text-muted-foreground"
              onClick={() =>
                setVisibleCount((count) =>
                  Math.min(count + SESSION_PAGE_SIZE, orderedSessions.length),
                )
              }
            >
              Show more
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </SidebarGroup>
  )
}
