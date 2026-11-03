import { createContext, useContext } from 'react'
import type { ProviderId } from '@agentpack/contract'
import type { DraftDiscardOptions, SidebarDraft } from '../components/sidebar/sidebar-sessions'

export type { DraftDiscardOptions }

/** Cheap facts about a workspace the host already knows; nothing is probed here. */
export interface WorkspaceCapabilitySummary {
  /** The root is a git checkout. */
  git: boolean
  /** Provider IDs a session could start with right now. */
  providers: string[]
}

export interface WorkspaceEntry {
  path: string
  name: string
  /** The folder is registered but not on disk right now (moved or deleted). */
  missing?: boolean
  availability?: 'available' | 'missing' | 'inaccessible'
  /** ISO timestamp of the latest session activity; orders the recents list. */
  lastActivityAt?: string | null
  capabilities?: WorkspaceCapabilitySummary
  /** The checkout's branch (null when detached) and whether it is a linked worktree. */
  git?: { branch: string | null; worktree: boolean }
}

/** Where the listed projects live and their sessions run. */
export interface SidebarEnvironment {
  environmentId: string
  /** The name the environment reports for itself (its host name by default). */
  label: string
}

export interface SidebarSessionEntry {
  externalId: string
  /** The environment it lives on, on hosts that know one. */
  environmentId?: string
  title?: string
  status: string
  providerId: ProviderId
  clientId?: string
  parentExternalId?: string
  isDriven: boolean
  /**
   * Its project folder is not reachable right now, so the row is
   * informational until the folder is restored. Derived from the workspace,
   * never from `status`: the lifecycle value stays the one the server owns.
   */
  workspaceUnavailable?: boolean
  /** ISO time of the last activity; hosts that do not track it leave it out. */
  updatedAt?: string
  /** ISO time the user settled it; null or absent while it is active. */
  settledAt?: string | null
  /** ISO time the user pinned it; null or absent while it is not pinned. */
  pinnedAt?: string | null
  /** Its composer holds text or an image that was not sent. Hosts whose
   * drafts do not sync leave it out. */
  hasUnsentDraft?: boolean
  /** What a `waiting` session waits on (`question`, `permission`, `plan`),
   * when the host knows. A question gets its own state in the sidebar. */
  waitingOn?: string
  /** A `running` session with no turn in flight, kept going only by its
   * background work. Hosts that cannot tell leave it out. */
  inBackground?: boolean
  /** How many background tasks are running, and what they are, one per
   * line. Absent when there are none. */
  backgroundTaskCount?: number
  backgroundTaskNames?: string
}

/**
 * What the sidebar and the new-session landing read: the workspace catalog,
 * which workspace rows are folded, and the navigation commands (re-exposed
 * from session state so views need one hook). The sessions themselves are
 * served on their own, by `useSidebarSessions`.
 */
export interface SidebarDataValue {
  /**
   * The environment every listed project and session belongs to. Hosts that
   * do not know one (or have not heard its name yet) leave it out and views
   * show no environment copy.
   */
  environment?: SidebarEnvironment
  /**
   * The environment `workspaces` and the open session belong to, even with no
   * name to show. Rows of other environments (`useSidebarEnvironments`) are
   * told from its own by this.
   */
  activeEnvironmentId?: string
  workspaces: WorkspaceEntry[]
  /**
   * Workspaces with session activity, most recent first, for the new-chat
   * surface. Hosts without activity data leave it out and get no recents row.
   */
  recentWorkspaces?: WorkspaceEntry[]
  isWorkspacesLoading: boolean
  activeWorkspacePath: string | null
  activeSessionId: string | null
  /** Workspace rows the user folded; persisted by the host. */
  collapsedWorkspacePaths: string[]
  toggleWorkspaceCollapsed: (workspacePath: string) => void
  addWorkspace: () => Promise<void>
  removeWorkspace: (path: string) => Promise<void>
  /**
   * The row commands here take the row's environment last. A host listing
   * several sends each through that environment's own connection, never the
   * open one's; the others have only one to go through and ignore it.
   */
  selectSession: (
    workspacePath: string,
    externalId: string,
    providerId: ProviderId,
    environmentId?: string,
  ) => void
  /**
   * Open a new session page in that project. A host listing several
   * environments takes another environment's to mean that environment's page,
   * and leaves it to the page to say where it is.
   */
  createSession: (workspacePath: string, environmentId?: string) => Promise<void>
  renameSession?: (
    workspacePath: string,
    externalId: string,
    title: string | null,
    environmentId?: string,
  ) => Promise<void>
  /** Name the session again with the environment's title model. Hosts
   * whose environment cannot generate titles leave it out. */
  regenerateSessionTitle?: (externalId: string) => Promise<void>
  /** Settle (`true`) or bring back (`false`). Hosts without settling leave it out. */
  settleSession?: (
    workspacePath: string,
    externalId: string,
    settled: boolean,
    environmentId?: string,
  ) => Promise<void>
  /** Pin (`true`) or unpin (`false`). Hosts without pins leave it out. */
  pinSession?: (
    workspacePath: string,
    externalId: string,
    pinned: boolean,
    environmentId?: string,
  ) => Promise<void>
  deleteSession: (
    workspacePath: string,
    externalId: string,
    providerId: ProviderId,
    environmentId?: string,
  ) => Promise<void>
  /** Clear the "finished, unread" marker once the session is on screen.
   * Hosts that derive status live have nothing to clear and leave it out. */
  acknowledgeSessionDone?: (
    workspacePath: string,
    externalId: string,
    providerId: ProviderId,
  ) => Promise<void>
}

export const SidebarDataContext = createContext<SidebarDataValue | null>(null)

export function useSidebarData(): SidebarDataValue {
  const ctx = useContext(SidebarDataContext)
  if (!ctx) throw new Error('useSidebarData must be used within SidebarDataProvider')
  return ctx
}

/** Sessions grouped under their workspace's path, newest first. */
export type SidebarSessionsByWorkspace = Record<string, SidebarSessionEntry[]>

/**
 * The sessions, served apart from the rest of the sidebar data.
 *
 * Sessions change all the time (a status, a title, a settle), while the
 * catalog and the commands hardly do. Served together, every such change
 * would re-render whatever reads the catalog, the new-session landing and the
 * shell's overlays included, though they show no session. Hosts keep this
 * value, and each group and row in it, the same object while nothing the
 * sidebar shows has changed.
 */
export const SidebarSessionsContext = createContext<SidebarSessionsByWorkspace | null>(null)

export function useSidebarSessions(): SidebarSessionsByWorkspace {
  const ctx = useContext(SidebarSessionsContext)
  if (!ctx) throw new Error('useSidebarSessions must be used within SidebarDataProvider')
  return ctx
}

/** One environment's rows, for a sidebar that lists more than the open one. */
export interface SidebarEnvironmentRows {
  environmentId: string
  workspaces: WorkspaceEntry[]
  sessions: SidebarSessionsByWorkspace
  /** Its draft cards, newest edit first. */
  drafts: SidebarDraft[]
  /** Connected now (`isEnvironmentReachable`). Absent reads as not. */
  reachable?: boolean
  /** Settling can be offered: it is connected and can keep the change. */
  canSettle: boolean
  /** Pinning can be offered, on the same terms. */
  canPin: boolean
  /** Its project icons can be asked for. */
  hasIcons: boolean
}

/** What a row needs to know about the environment it is on. */
export interface SidebarRowEnvironment {
  /** Its saved name, shown on the card. */
  name: string
  /** Connected now, so a new agent could start there. Absent reads as not. */
  reachable?: boolean
  canSettle: boolean
  canPin: boolean
  /** Null where it has no icons to give. */
  iconLookup: ((workspaceId: string) => Promise<string | null>) | null
}

/**
 * The rest of the list, on a host with more than one environment saved.
 * Everything else about the sidebar stays the open environment's. Kept the
 * same object while nothing a row shows has changed.
 */
export interface SidebarEnvironmentsValue {
  /** The environments other than the open one, in their saved order. */
  others: readonly SidebarEnvironmentRows[]
  /** By environment id, the open one included. */
  rowEnvironments: Readonly<Record<string, SidebarRowEnvironment>>
  /** Some environment's rows may yet arrive: what joins now is the list filling, not news. */
  filling: boolean
}

export const SidebarEnvironmentsContext = createContext<SidebarEnvironmentsValue | null>(null)

/** Null on a host with one environment, which is every host but the web's. */
export function useSidebarEnvironments(): SidebarEnvironmentsValue | null {
  return useContext(SidebarEnvironmentsContext)
}

/** One saved environment, as the new session page offers it. */
export interface EnvironmentOption {
  environmentId: string
  label: string
  /** Its address, for an environment whose name another saved one shares. */
  detail?: string
  /** Connected now. Nothing could start on one that is not, so it cannot be picked. */
  reachable: boolean
}

/** Where new sessions run, on a host with more than one environment saved. */
export interface EnvironmentChoiceValue {
  /** In their saved order. */
  environments: readonly EnvironmentOption[]
  /** The environment selected now, for a page that has not learned its own. */
  selectedId: string | null
  /**
   * Go to that environment's new session page, false if it cannot be gone to
   * now. `from` is the draft on the page and the environment it is on: its
   * text goes along, and its images stay with it where they were uploaded.
   * `workspaceId` is the project to open there, in place of the most recent.
   */
  choose: (
    environmentId: string,
    from: { draftId: string; environmentId: string } | null,
    workspaceId?: string,
  ) => boolean
  /** A project `choose` was asked to open, until that environment's page takes it. */
  opening: { environmentId: string; workspaceId: string } | null
  /** The page has opened it. */
  opened: () => void
}

export const EnvironmentChoiceContext = createContext<EnvironmentChoiceValue | null>(null)

/** Null with one environment saved, which is always so off the web: nothing to pick. */
export function useEnvironmentChoice(): EnvironmentChoiceValue | null {
  return useContext(EnvironmentChoiceContext)
}

/** A draft discard waiting out its undo window. */
export interface PendingDraftDiscard {
  draftId: string
  /** The environment the draft is on, on hosts that know one. */
  environmentId?: string
  /** Tells one discard from the next, so a second one restarts the notice. */
  key: number
  /** Made from the keyboard: the notice takes focus, so Undo is a keypress away. */
  fromKeyboard: boolean
  /** Where focus goes when the notice closes with focus on it, unless the card is back. */
  returnFocus: HTMLElement | null
}

/**
 * The new-session drafts the sidebar shows as cards, and what a card does.
 * Only hosts whose environment keeps drafts and gives each its own page
 * serve this; elsewhere `useSidebarDrafts` is null and no card shows.
 */
export interface SidebarDraftsValue {
  /**
   * Newest edit first. The draft on screen keeps the card it had when it was
   * opened, unchanged while it is typed in; a draft first written on this
   * screen gets its card once it is left.
   */
  drafts: SidebarDraft[]
  /** The draft on screen, whose card shows selected. */
  openDraftId: string | null
  /** Go to the draft's page, everything as it was left. Takes the card's environment, as the session commands do. */
  openDraft: (draftId: string, environmentId?: string) => void
  /**
   * Hide the draft's card, and delete the draft once the undo window closes
   * or the page goes. The draft on screen leaves for a blank page. Does
   * nothing to a draft being sent; called off if the draft changes elsewhere
   * during the window.
   */
  discardDraft: (draftId: string, options?: DraftDiscardOptions) => void
  pendingDiscard: PendingDraftDiscard | null
  /**
   * Bring the pending discard's card back; nothing was deleted. Given the
   * discard's `key`, does nothing once another discard has taken its place:
   * a notice on its way out acts on its own discard or on none.
   */
  undoDiscard: (key?: number) => void
  /** Delete the pending discard's draft now; `key` as for `undoDiscard`. */
  confirmDiscard: (key?: number) => void
  /** Pause the undo window while the user is reading or reaching for it; `key` as above. */
  holdDiscard: (held: boolean, key?: number) => void
}

export const SidebarDraftsContext = createContext<SidebarDraftsValue | null>(null)

/** The draft cards, or null on a host without them. */
export function useSidebarDrafts(): SidebarDraftsValue | null {
  return useContext(SidebarDraftsContext)
}

export function resolveInitialWorkspacePath(
  workspaces: Array<{ path: string }>,
  lastActiveWorkspacePath: string,
): string | null {
  if (workspaces.length === 0) return null
  if (
    lastActiveWorkspacePath &&
    workspaces.some((workspace) => workspace.path === lastActiveWorkspacePath)
  ) {
    return lastActiveWorkspacePath
  }
  return workspaces[0]?.path ?? null
}

/** Toggle membership; returns a new array either way so state setters notice. */
export function toggleCollapsedWorkspace(paths: readonly string[], path: string): string[] {
  return paths.includes(path) ? paths.filter((item) => item !== path) : [...paths, path]
}
