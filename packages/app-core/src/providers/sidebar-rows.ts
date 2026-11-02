import type { ProviderId } from '@agentpack/contract'
import type { SessionSummary, Workspace } from '@openmanager/protocol'
import {
  selectProviderCatalog,
  selectSessionList,
  selectWorkspaces,
  type EnvironmentClient,
  type EnvironmentState,
} from '@openmanager/environment-client'
import {
  NO_DRAFT_FACTS,
  sameSidebarDraftFacts,
  selectSessionsWithUnsentDraft,
  selectSidebarDrafts,
  type SidebarDraftFacts,
} from '../components/sidebar/sidebar-sessions'
import { deriveProviderUiStatus } from '@openmanager/shared/contracts/provider-health'
import { providerHealthReportFromWire } from '../lib/provider-health-view'
import { DEFAULT_PROVIDER_ID, availableProviderIds, type ProviderStatuses } from './draft-provider'
import type {
  SidebarEnvironmentRows,
  SidebarSessionEntry,
  SidebarSessionsByWorkspace,
  WorkspaceEntry,
} from './sidebar-provider'

export function toWorkspaceEntry(workspace: Workspace, available: string[]): WorkspaceEntry {
  return {
    path: workspace.workspaceId,
    name: workspace.name,
    missing: !workspace.exists,
    availability: workspace.availability,
    lastActivityAt: workspace.lastActivityAt,
    // Which providers could start here is provider health, the same for every project.
    capabilities: { git: workspace.capabilities.git, providers: available },
    ...(workspace.git ? { git: workspace.git } : {}),
  }
}

/** The sidebar's rows for these sessions, grouped under their workspace's path. */
export function groupSidebarSessions({
  sessions,
  unsent,
  workspaces,
  environmentId,
}: {
  sessions: readonly SessionSummary[]
  /** Sessions holding an unsent draft. */
  unsent: readonly string[]
  workspaces: readonly WorkspaceEntry[]
  environmentId: string | undefined
}): SidebarSessionsByWorkspace {
  const unsentIds = new Set(unsent)
  const grouped: SidebarSessionsByWorkspace = {}
  const unavailableWorkspaces = new Set(
    workspaces
      .filter((workspace) =>
        workspace.availability ? workspace.availability !== 'available' : workspace.missing,
      )
      .map((workspace) => workspace.path),
  )
  for (const summary of sessions) {
    const entry: SidebarSessionEntry = {
      externalId: summary.sessionId,
      ...(environmentId ? { environmentId } : {}),
      title: summary.title ?? undefined,
      // Idle with an unseen completion is done until someone opens it. Plain
      // server idle means ready; legacy desktop idle clears an unread
      // completion marker, so keep the presentation alias at this boundary.
      status: summary.status === 'idle' ? (summary.doneAt ? 'done' : 'ready') : summary.status,
      providerId: summary.providerId as ProviderId,
      ...(summary.parentSessionId ? { parentExternalId: summary.parentSessionId } : {}),
      // ChatView still branches on `isDriven` for the Convex IPC overlay.
      // This path has one protocol-event stream and no `stream_chunks`
      // subscription, so the flag is always true. Desktop must drop the
      // overlay at thin-shell cutover rather than reintroduce `driven`.
      isDriven: true,
      ...(unavailableWorkspaces.has(summary.workspaceId) ? { workspaceUnavailable: true } : {}),
      ...(summary.updatedAt ? { updatedAt: summary.updatedAt } : {}),
      settledAt: summary.settledAt ?? null,
      pinnedAt: summary.pinnedAt ?? null,
      ...(unsentIds.has(summary.sessionId) ? { hasUnsentDraft: true } : {}),
      ...(summary.waitingOn ? { waitingOn: summary.waitingOn } : {}),
      ...(summary.inBackground ? { inBackground: true } : {}),
      // Primitives, so an unchanged roster keeps the row as it was.
      ...(summary.backgroundTasks?.length
        ? {
            backgroundTaskCount: summary.backgroundTasks.length,
            backgroundTaskNames: summary.backgroundTasks
              .map((task) => task.description || task.kind)
              .join('\n'),
          }
        : {}),
    }
    ;(grouped[summary.workspaceId] ??= []).push(entry)
  }
  return grouped
}

/**
 * The next grouping, keeping every row and group whose shown fields did not
 * change as the object it was. Sessions carry more than the sidebar shows
 * (the composer selection, thread ids) and a listing rebuilds them all; a
 * change the sidebar does not show then leaves the whole value as it was.
 */
export function reuseUnchanged(
  previous: SidebarSessionsByWorkspace | null,
  next: SidebarSessionsByWorkspace,
): SidebarSessionsByWorkspace {
  if (!previous) return next
  const rows = new Map<string, SidebarSessionEntry>()
  for (const group of Object.values(previous)) {
    for (const row of group) rows.set(row.externalId, row)
  }
  let changed = Object.keys(previous).length !== Object.keys(next).length
  const result: SidebarSessionsByWorkspace = {}
  for (const [path, group] of Object.entries(next)) {
    const kept = group.map((row) => {
      const before = rows.get(row.externalId)
      return before && sameEntry(before, row) ? before : row
    })
    const before = previous[path]
    const same =
      before !== undefined &&
      before.length === kept.length &&
      kept.every((row, index) => row === before[index])
    result[path] = same ? before : kept
    if (!same) changed = true
  }
  return changed ? result : previous
}

function sameEntry(left: SidebarSessionEntry, right: SidebarSessionEntry): boolean {
  const keys = Object.keys(left) as (keyof SidebarSessionEntry)[]
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.is(left[key], right[key]))
  )
}

/** Equal while the sidebar shows them the same: it reads none of what a turn changes. */
function sameWorkspaceEntries(left: readonly WorkspaceEntry[], right: readonly WorkspaceEntry[]) {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index]!
      return (
        entry.path === other.path &&
        entry.name === other.name &&
        entry.missing === other.missing &&
        entry.availability === other.availability &&
        entry.git?.branch === other.git?.branch &&
        entry.git?.worktree === other.git?.worktree
      )
    })
  )
}

function statusesOf(state: EnvironmentState): ProviderStatuses {
  const statuses: Record<string, ProviderStatuses[ProviderId]> = {}
  for (const entry of selectProviderCatalog(state)) {
    statuses[entry.id] = deriveProviderUiStatus(providerHealthReportFromWire(entry.health))
  }
  return statuses
}

type Reader = Pick<EnvironmentClient, 'getState' | 'supports'>

/** What can be offered for an environment's rows just now. */
export function sidebarRowAbilities(client: Reader) {
  const { connection } = client.getState()
  return {
    canSettle: connection.phase === 'connected' && client.supports('settleSession'),
    hasIcons:
      connection.capabilities.includes('workspace.icon') && client.supports('resolveWorkspaceIcon'),
  }
}

/**
 * Reads one environment's sidebar rows off its client, for a sidebar listing
 * an environment that is not the open one. Nothing is open there, so nothing
 * is left out of its rows; the open environment's rows come from its own
 * providers.
 *
 * This runs on every update the environment's store makes, a streamed token
 * included, so each environment costs a few comparisons per token and nothing
 * else: the rows are read again only when what they are made of changed, and
 * stay the same object unless what they show did.
 */
export function createSidebarRowsReader() {
  let last:
    | {
        inputs: readonly unknown[]
        rows: SidebarEnvironmentRows
        facts: SidebarDraftFacts
      }
    | undefined
  return (client: Reader): SidebarEnvironmentRows | null => {
    const state = client.getState()
    const environmentId = state.environment?.environmentId
    if (!environmentId) return null
    const inputs = [
      environmentId,
      state.sessions,
      state.sessionOrder,
      state.workspaces,
      state.workspaceOrder,
      state.drafts,
      state.draftEdits,
      state.providers,
      state.providerOrder,
      state.connection.phase,
      state.connection.capabilities,
      client.supports,
    ]
    if (last && last.inputs.every((input, index) => input === inputs[index])) return last.rows
    const available = availableProviderIds(selectProviderCatalog(state))
    const built = selectWorkspaces(state).map((workspace) => toWorkspaceEntry(workspace, available))
    const previous = last?.rows.environmentId === environmentId ? last : undefined
    const workspaces =
      previous && sameWorkspaceEntries(previous.rows.workspaces, built)
        ? previous.rows.workspaces
        : built
    const sessions = reuseUnchanged(
      previous?.rows.sessions ?? null,
      groupSidebarSessions({
        sessions: selectSessionList(state),
        unsent: selectSessionsWithUnsentDraft(state, null),
        workspaces,
        environmentId,
      }),
    )
    const read = selectSidebarDrafts(state, null, null, DEFAULT_PROVIDER_ID, statusesOf(state))
    const facts = sameSidebarDraftFacts(previous?.facts ?? NO_DRAFT_FACTS, read)
      ? (previous?.facts ?? read)
      : read
    const { canSettle, hasIcons } = sidebarRowAbilities(client)
    const unchanged =
      previous &&
      previous.rows.workspaces === workspaces &&
      previous.rows.sessions === sessions &&
      previous.facts === facts &&
      previous.rows.canSettle === canSettle &&
      previous.rows.hasIcons === hasIcons
    const rows: SidebarEnvironmentRows = unchanged
      ? previous.rows
      : {
          environmentId,
          workspaces,
          sessions,
          drafts: facts.cards,
          canSettle,
          hasIcons,
        }
    last = { inputs, rows, facts }
    return rows
  }
}
