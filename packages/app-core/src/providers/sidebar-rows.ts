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
    ...(workspace.kind === 'scratch' ? { scratch: true } : {}),
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
  // A subagent's session gets no row of its own: its parent's card counts it,
  // and the parent chat's subagent cards open it.
  const isLive = (summary: SessionSummary) =>
    summary.status === 'running' || summary.status === 'waiting'
  const childrenOf = new Map<string, SessionSummary[]>()
  for (const summary of sessions) {
    if (!summary.subagent || !summary.parentSessionId) continue
    const siblings = childrenOf.get(summary.parentSessionId) ?? []
    siblings.push(summary)
    childrenOf.set(summary.parentSessionId, siblings)
  }
  /** Every subagent under a session, at any depth. */
  const descendants = (sessionId: string, seen = new Set<string>()): SessionSummary[] =>
    (childrenOf.get(sessionId) ?? []).flatMap((child) => {
      if (seen.has(child.sessionId)) return []
      seen.add(child.sessionId)
      return [child, ...descendants(child.sessionId, seen)]
    })
  for (const summary of sessions) {
    if (summary.subagent) continue
    const direct = childrenOf.get(summary.sessionId) ?? []
    const nested = direct.length ? descendants(summary.sessionId) : []
    // One of its subagents is live while it, or a subagent of its own, works.
    const live = direct.filter(
      (child) => isLive(child) || descendants(child.sessionId).some(isLive),
    ).length
    // A subagent running in the background is shown by its card and counted
    // here, so only as many agent tasks as there are live subagents are left
    // out of the background work; any more have no card and stay named.
    let hide = live
    const background =
      summary.backgroundTasks?.filter((task) => {
        if (task.kind !== 'agent' || hide === 0) return true
        hide -= 1
        return false
      }) ?? []
    const entry: SidebarSessionEntry = {
      externalId: summary.sessionId,
      ...(environmentId ? { environmentId } : {}),
      title: summary.title ?? undefined,
      // Idle with an unseen completion is done until someone opens it. Plain
      // server idle means ready; legacy desktop idle clears an unread
      // completion marker, so keep the presentation alias at this boundary.
      // A turn that completed beside background work that just runs on (a
      // dev server in a Codex terminal) is done too: the server sets
      // `doneAt` only when that work will not wake the agent. The row keeps
      // `inBackground`, so it still counts as live work (no settling).
      status:
        summary.status === 'idle'
          ? summary.doneAt
            ? 'done'
            : 'ready'
          : summary.status === 'running' && summary.inBackground && summary.doneAt
            ? 'done'
            : summary.status,
      providerId: summary.providerId as ProviderId,
      ...(summary.parentSessionId ? { parentExternalId: summary.parentSessionId } : {}),
      ...(direct.length ? { subagentCount: direct.length } : {}),
      ...(live ? { subagentsLive: live } : {}),
      // Its subagents' pages are where it is on screen, for the card to show
      // it selected. Joined, so an unchanged set keeps the row as it was.
      ...(nested.length
        ? { subagentSessionIds: nested.map((child) => child.sessionId).join('\n') }
        : {}),
      // ChatView still branches on `isDriven` for the Convex IPC overlay.
      // This path has one protocol-event stream and no `stream_chunks`
      // subscription, so the flag is always true. Desktop must drop the
      // overlay at thin-shell cutover rather than reintroduce `driven`.
      isDriven: true,
      ...(unavailableWorkspaces.has(summary.workspaceId) ? { workspaceUnavailable: true } : {}),
      ...(summary.updatedAt ? { updatedAt: summary.updatedAt } : {}),
      settledAt: summary.settledAt ?? null,
      pinnedAt: summary.pinnedAt ?? null,
      cookingAt: summary.cookingAt ?? null,
      ...(unsentIds.has(summary.sessionId) ? { hasUnsentDraft: true } : {}),
      ...(summary.waitingOn ? { waitingOn: summary.waitingOn } : {}),
      ...(summary.inBackground ? { inBackground: true } : {}),
      // Kept going by its subagents alone: the row says so with their count,
      // not as background work. Its status stays the server's, so it still
      // reads as live work (no settling, no "finished" notice) until they end.
      ...(summary.inBackground && summary.backgroundTasks?.length && background.length === 0
        ? { inBackgroundForSubagents: true }
        : {}),
      // Primitives, so an unchanged roster keeps the row as it was.
      ...(background.length
        ? {
            backgroundTaskCount: background.length,
            backgroundTaskNames: background.map((task) => task.description || task.kind).join('\n'),
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
        entry.git?.worktree === other.git?.worktree &&
        entry.scratch === other.scratch
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

/** Connected now: commands sent to it are answered, and a session could start there. */
export function isEnvironmentReachable(client: Pick<Reader, 'getState'> | undefined): boolean {
  return client?.getState().connection.phase === 'connected'
}

/** What can be offered for an environment's rows just now. */
export function sidebarRowAbilities(client: Reader) {
  const { connection } = client.getState()
  return {
    reachable: isEnvironmentReachable(client),
    canSettle: connection.phase === 'connected' && client.supports('settleSession'),
    canPin: connection.phase === 'connected' && client.supports('pinSession'),
    canCook: connection.phase === 'connected' && client.supports('cookSession'),
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
    const { reachable, canSettle, canPin, canCook, hasIcons } = sidebarRowAbilities(client)
    const unchanged =
      previous &&
      previous.rows.workspaces === workspaces &&
      previous.rows.sessions === sessions &&
      previous.facts === facts &&
      previous.rows.reachable === reachable &&
      previous.rows.canSettle === canSettle &&
      previous.rows.canPin === canPin &&
      previous.rows.canCook === canCook &&
      previous.rows.hasIcons === hasIcons
    const rows: SidebarEnvironmentRows = unchanged
      ? previous.rows
      : {
          environmentId,
          workspaces,
          sessions,
          drafts: facts.cards,
          reachable,
          canSettle,
          canPin,
          canCook,
          hasIcons,
        }
    last = { inputs, rows, facts }
    return rows
  }
}
