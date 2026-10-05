import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CaretDownIcon, CheckIcon, FolderPlusIcon, FolderSimpleIcon } from '@phosphor-icons/react'
import type { WorkspaceEntry } from '../../providers/sidebar-provider'
import { cn } from '../../lib/utils'
import {
  CommandMenu,
  CommandMenuEmpty,
  CommandMenuInput,
  CommandMenuItem,
  CommandMenuList,
  CommandMenuShortcut,
  defaultCommandMenuFilter,
  matchesShortcut,
  parseShortcut,
  type CommandMenuItemData,
} from '../fluid/ui/command-menu'
import { EnvironmentLabel } from '../sidebar/EnvironmentLabel'
import { ProjectIcon } from '../sidebar/ProjectIcon'
import { Tooltip } from '../ui/Tooltip'
import { usePortaledMenu } from '../ui/usePortaledMenu'
import { useHoldFocus, useRegisterPicker } from '../command/pickerRegistry'

const MENU_WIDTH = 360
/** The "Add project" row's value; no workspace path can collide with it. */
const ADD_PROJECT = '\u0000add-project'
const SHORTCUT = 'mod+shift+p'

/** "git · 2 providers", or nothing when the host reports no capabilities. */
export function describeCapabilities(entry: WorkspaceEntry): string | null {
  const capabilities = entry.capabilities
  if (!capabilities) return null
  const parts: string[] = []
  if (capabilities.git) parts.push('git')
  const count = capabilities.providers.length
  if (count === 1) parts.push(capabilities.providers[0]!)
  else if (count > 1) parts.push(`${count} providers`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** "Add project" stays listed whatever is typed: it is the way out when
 *  nothing matches. */
function filterProjects(item: CommandMenuItemData, query: string) {
  return item.value === ADD_PROJECT || defaultCommandMenuFilter(item, query)
}

/**
 * The landing's "Let's build in <project>" control: a command menu under the
 * project name. Recent projects first, then the rest, then "Add project";
 * the active project is highlighted on open. ⌘⇧P / Ctrl+Shift+P opens it.
 */
export function ProjectPicker({
  workspaces,
  recentWorkspaces,
  activeWorkspace,
  environmentLabel,
  onSelect,
  onAddWorkspace,
}: {
  workspaces: WorkspaceEntry[]
  recentWorkspaces: WorkspaceEntry[]
  /** Null when the open draft has no project: the picker asks for one. */
  activeWorkspace: WorkspaceEntry | null
  environmentLabel?: string
  onSelect: (workspacePath: string) => void
  onAddWorkspace: () => void
}) {
  const [query, setQuery] = useState('')
  const { open, setOpen, toggle, close, menuCoords, wrapRef, triggerRef, menuRef } =
    usePortaledMenu({ placement: 'below', minWidth: MENU_WIDTH, align: 'center' })

  const byPath = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.path, workspace])),
    [workspaces],
  )

  const items = useMemo<CommandMenuItemData[]>(() => {
    const recent = recentWorkspaces.filter((workspace) => !workspace.missing)
    const recentPaths = new Set(recent.map((workspace) => workspace.path))
    const rest = workspaces.filter((workspace) => !recentPaths.has(workspace.path))
    const row = (workspace: WorkspaceEntry, group?: string): CommandMenuItemData => {
      const description = describeCapabilities(workspace)
      return {
        value: workspace.path,
        label: workspace.name,
        ...(description ? { description } : {}),
        keywords: [workspace.path],
        ...(group ? { group } : {}),
      }
    }
    return [
      ...recent.map((workspace) => row(workspace, 'Recent')),
      ...rest.map((workspace) => row(workspace, recent.length > 0 ? 'All projects' : undefined)),
      { value: ADD_PROJECT, label: 'Add project…', keywords: ['new', 'folder'] },
    ]
  }, [recentWorkspaces, workspaces])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const searchRef = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (open && menuCoords) searchRef.current?.focus()
  }, [open, menuCoords])

  const releaseFocus = useHoldFocus(open, menuRef, searchRef)
  // The command palette's "Switch project…".
  useRegisterPicker('project', () => setOpen(true))

  const dismiss = useCallback(() => {
    releaseFocus()
    close()
    triggerRef.current?.focus()
  }, [releaseFocus, close, triggerRef])

  const openRef = useRef(open)
  openRef.current = open
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss
  useEffect(() => {
    const parsed = parseShortcut(SHORTCUT)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented || !matchesShortcut(event, parsed)) return
      event.preventDefault()
      if (openRef.current) dismissRef.current()
      else setOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setOpen])

  const pick = (value: string) => {
    releaseFocus()
    close()
    if (value === ADD_PROJECT) onAddWorkspace()
    else onSelect(value)
  }

  const menu =
    open &&
    menuCoords &&
    createPortal(
      <div
        ref={menuRef}
        role="dialog"
        aria-label="Choose a project"
        className="fixed z-[200] flex max-h-[min(400px,60vh)] flex-col overflow-hidden rounded-float bg-float text-left shadow-float"
        style={{ left: menuCoords.left, top: menuCoords.top, width: MENU_WIDTH }}
      >
        <CommandMenu
          items={items}
          query={query}
          onQueryChange={setQuery}
          filter={filterProjects}
          onSelect={(item) => pick(item.value)}
          defaultHighlight={activeWorkspace?.path}
        >
          <CommandMenuInput
            ref={searchRef}
            placeholder="Search projects…"
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              dismiss()
            }}
          />
          <CommandMenuList
            className="gap-0 px-1.5 pb-1.5 pt-0.5"
            renderItem={(item) =>
              item.value === ADD_PROJECT ? (
                <CommandMenuItem
                  value={item.value}
                  className="mt-1 h-9 gap-2.5 px-2.5 text-[13px] text-foreground before:absolute before:inset-x-1 before:-top-0.5 before:h-px before:bg-[var(--basis-border-muted)]"
                >
                  <FolderPlusIcon weight="light" className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </CommandMenuItem>
              ) : (
                <ProjectRow
                  item={item}
                  workspace={byPath.get(item.value)}
                  active={item.value === activeWorkspace?.path}
                />
              )
            }
          >
            <CommandMenuEmpty>No projects</CommandMenuEmpty>
          </CommandMenuList>
          {environmentLabel && (
            <div className="flex h-8 shrink-0 items-center px-3 text-[11px] text-muted-foreground">
              <EnvironmentLabel label={environmentLabel} className="min-w-0 text-[11px]" />
            </div>
          )}
        </CommandMenu>
      </div>,
      document.body,
    )

  return (
    <div ref={wrapRef} className="relative inline-flex min-w-0 max-w-full">
      <Tooltip
        content={
          <span className="flex items-center gap-2">
            Switch project
            <CommandMenuShortcut keys={SHORTCUT} className="ml-0" />
          </span>
        }
        side="bottom"
      >
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={
            activeWorkspace
              ? `Project: ${activeWorkspace.name}. Choose a project`
              : 'Choose a project'
          }
          className={cn(
            'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-16-medium text-[var(--basis-text-strong)] transition-colors',
            'hover:bg-hover',
            open && 'bg-hover',
          )}
        >
          {activeWorkspace ? (
            <ProjectIcon
              workspacePath={activeWorkspace.path}
              fallbackIcon={FolderSimpleIcon}
              className="h-4 w-4 text-[var(--basis-text-muted)]"
            />
          ) : (
            <FolderSimpleIcon weight="light" className="h-4 w-4 text-[var(--basis-text-muted)]" />
          )}
          <span className="truncate">{activeWorkspace?.name ?? 'a project'}</span>
          <CaretDownIcon
            weight="light"
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-[var(--basis-text-faint)] transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
      </Tooltip>
      {menu}
    </div>
  )
}

function ProjectRow({
  item,
  workspace,
  active,
}: {
  item: CommandMenuItemData
  workspace: WorkspaceEntry | undefined
  active: boolean
}) {
  return (
    <CommandMenuItem
      value={item.value}
      title={item.value}
      className="h-9 gap-2.5 px-2.5 text-[13px] text-foreground"
    >
      <ProjectIcon
        workspacePath={workspace?.path ?? item.value}
        fallbackIcon={FolderSimpleIcon}
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 truncate">{item.label}</span>
        {item.description && (
          <span className="min-w-0 truncate text-muted-foreground/70">{item.description}</span>
        )}
      </span>
      <span className="flex w-3.5 shrink-0 justify-center">
        {active && <CheckIcon aria-label="Current project" size={14} className="text-foreground" />}
      </span>
    </CommandMenuItem>
  )
}
