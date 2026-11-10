import { useCallback, useMemo } from 'react'
import {
  SearchPaletteBody,
  SearchPaletteDialog,
  type SearchableSession,
} from '@openmanager/app-core/components/command/SearchPalette'
import type { ChatSearchSource } from '@openmanager/app-core/lib/chat-search'
import {
  useSidebarData,
  useSidebarEnvironments,
  useSidebarSessions,
  type SidebarSessionsByWorkspace,
  type WorkspaceEntry,
} from '@openmanager/app-core/providers/sidebar-provider'
import { useEnvironmentClients } from '../providers/environment-client-provider'

/**
 * ⌘⇧F over every saved environment: the palette shell stays mounted for its
 * shortcut, and the body, which reads every environment's sessions, only
 * while it is open.
 */
export function ShellSearchPalette() {
  return (
    <SearchPaletteDialog>
      <ShellSearchBody />
    </SearchPaletteDialog>
  )
}

function sessionsOf(
  environmentId: string,
  workspaces: readonly WorkspaceEntry[],
  byWorkspace: SidebarSessionsByWorkspace,
): SearchableSession[] {
  const names = new Map(workspaces.map((workspace) => [workspace.path, workspace.name]))
  return Object.entries(byWorkspace).flatMap(([workspacePath, entries]) =>
    entries.map((entry) => ({
      environmentId: entry.environmentId ?? environmentId,
      externalId: entry.externalId,
      title: entry.title,
      providerId: entry.providerId,
      workspacePath,
      workspaceName: names.get(workspacePath),
      updatedAt: entry.updatedAt,
    })),
  )
}

function ShellSearchBody() {
  const { workspaces, activeEnvironmentId, selectSession } = useSidebarData()
  const sessionsByWorkspace = useSidebarSessions()
  const environments = useSidebarEnvironments()
  const { clients } = useEnvironmentClients()

  const sessions = useMemo(
    () => [
      ...(activeEnvironmentId
        ? sessionsOf(activeEnvironmentId, workspaces, sessionsByWorkspace)
        : []),
      ...(environments?.others ?? []).flatMap((other) =>
        sessionsOf(other.environmentId, other.workspaces, other.sessions),
      ),
    ],
    [activeEnvironmentId, workspaces, sessionsByWorkspace, environments?.others],
  )

  // The open environment first, then the others in their saved order: the
  // order equal places merge in. Only those whose server can search.
  const sources = useMemo<ChatSearchSource[]>(() => {
    const order = [
      ...(activeEnvironmentId ? [activeEnvironmentId] : []),
      ...(environments?.others ?? []).map((other) => other.environmentId),
    ]
    return order.flatMap((environmentId) => {
      const client = clients[environmentId]
      if (!client?.supports('searchMessages')) return []
      return [
        {
          environmentId,
          search: (query: string, limit: number) => client.commands.searchMessages(query, limit),
        },
      ]
    })
  }, [activeEnvironmentId, environments?.others, clients])

  const rowEnvironments = environments?.rowEnvironments
  const environmentName = useCallback(
    (environmentId: string) => rowEnvironments?.[environmentId]?.name,
    [rowEnvironments],
  )

  const onOpenSession = useCallback(
    (session: SearchableSession) =>
      selectSession(
        session.workspacePath,
        session.externalId,
        session.providerId,
        session.environmentId,
      ),
    [selectSession],
  )

  return (
    <SearchPaletteBody
      sessions={sessions}
      sources={sources}
      environmentName={environmentName}
      onOpenSession={onOpenSession}
    />
  )
}
