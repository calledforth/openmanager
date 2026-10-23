import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import {
  ProofCommandSchemas,
  ProofEventSchemas,
  ProofResponseSchemas,
  type CommandEnvelope,
  type DurableEvent,
  type ErrorCode,
  type ProofEvent,
  type Workspace,
  type WorkspaceGit,
} from '@openmanager/protocol/node'
import { auditValue, type AuditLog } from './audit.ts'
import type { CommandContext } from './command-context.ts'
import {
  gitJsonOf,
  gitReadingOf,
  lastSessionActivity,
  readWorkspace,
  readWorkspaceRow,
  readWorkspaceRows,
  readWorkspaces,
  workspaceFromRow,
  type GitReading,
  type WorkspaceRow,
} from './db/workspace-rows.ts'
import { workspaceRemovalEvents } from './db/deletions.ts'
import {
  canonicalizeRoot,
  canonicalizeUnavailableRoot,
  PathBoundaryError,
  resolveWorkspacePath,
  validateRegistrationPath,
} from './workspace-paths.ts'
import { createWorkspaceIconCache } from './workspace-icons.ts'

/**
 * The branch a checkout is on, from at most two small reads: `.git` (a
 * directory, or a file naming a linked worktree's gitdir) and its `HEAD`.
 * Never runs git and never walks the tree (D9 cost budget).
 */
export function readWorkspaceGit(root: string): WorkspaceGit | undefined {
  const dotGit = join(root, '.git')
  try {
    let gitDir = dotGit
    let worktree = false
    const stat = statSync(dotGit)
    if (stat.isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
      if (!match?.[1]) return undefined
      gitDir = resolve(root, match[1].trim())
      // Submodules also use a `.git` file; only `<repo>/.git/worktrees/<name>` is a worktree.
      worktree = /[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitDir)
    } else if (!stat.isDirectory()) {
      return undefined
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return { branch: ref?.[1] ? ref[1].slice(0, 256) : null, worktree }
  } catch {
    return undefined
  }
}

/** What a folder's checkout looks like now: one `.git` stat and its `HEAD`. */
export function readGitReading(root: string): GitReading {
  const git = readWorkspaceGit(root)
  return { checkout: existsSync(join(root, '.git')), ...(git ? { git } : {}) }
}

export interface RegisteredWorkspace {
  readonly workspaceId: string
  readonly name: string
  /** Canonical on-disk root, as `realpath` resolved it. */
  readonly root: string
  /** Epoch milliseconds of the last session started here; null until one is. */
  readonly lastUsedAt: number | null
  readonly availability: 'available' | 'missing' | 'inaccessible'
}

export type WorkspacePathResult =
  | { ok: true; workspace: RegisteredWorkspace; path: string }
  | { ok: false; reason: 'unknown_workspace' | PathBoundaryError['reason'] }

export type WorkspaceRegistration =
  | { ok: true; workspace: Workspace }
  | { ok: false; code: Extract<ErrorCode, 'validation' | 'not_found'>; message: string }

/**
 * Where the registry reads and writes: the event database's connection, and
 * the event service's atomic append (docs/sync-foundations.md §4.7.11). The
 * registry opens no connection of its own and writes no row itself: every
 * change is a `workspace.*` event whose projection is the one writer, and its
 * cache follows committed records only: those its own writes return, and any
 * other the host hands it through `apply`.
 */
export interface WorkspaceStore {
  database: DatabaseSync
  environmentId: string
  /** Commit events in one transaction and answer the records that committed. */
  appendAtomic(events: readonly ProofEvent[]): readonly DurableEvent[]
  /** Write whatever the batcher holds, so session times read from rows are current. */
  flush(): void
}

export interface WorkspaceRegistryOptions {
  clock?: () => number
  /** Runs before a removal is announced, so live work in the folder can be stopped. */
  onUnregister?: (workspaceId: string) => void
  /**
   * A change an observation found could not be written. The command that
   * observed it still routes by what the folder is now; the row and every
   * client keep the last state that was written until the next observation.
   */
  onObservationError?: (workspaceId: string, error: unknown) => void
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && 'code' in error && codes.includes(String(error.code))
}

/**
 * The set of roots this environment exposes (threat model D9). Clients name a
 * workspace by the ID the server assigned and never send a root path in its
 * place. Any signed-in client may register any directory on this machine:
 * being paired is the consent, and the boundary D9 enforces is that every
 * later path stays inside the workspace it names. Registrations persist in
 * the `workspaces` table, so a workspace added from a client survives a
 * restart; roots passed on the command line are registered the same way on
 * every start. A registered folder that has since been moved or deleted stays
 * listed, flagged as missing, until it is unregistered or comes back.
 *
 * Every write is an event (docs/sync-foundations.md §4.4): registering,
 * renaming, what an observation of the folder found (availability and the
 * git reading), the last-used stamp and removal. The folder is observed on
 * the command paths that use it; a listing and the environment snapshot
 * read rows only.
 */
export function openWorkspaceRegistry(
  store: WorkspaceStore,
  roots: readonly string[],
  audit: AuditLog,
  options: WorkspaceRegistryOptions = {},
) {
  // A stored root is usable when it still resolves to itself: a directory
  // replaced by a link elsewhere is refused (T12), not silently followed.
  const availabilityOf = (root: string): RegisteredWorkspace['availability'] => {
    try {
      return canonicalizeRoot(root) === root ? 'available' : 'inaccessible'
    } catch (error) {
      return hasCode(error, 'ENOENT', 'ENOTDIR') ||
        (error instanceof Error && error.message.startsWith('Workspace root is not a directory'))
        ? 'missing'
        : 'inaccessible'
    }
  }
  const clock = options.clock ?? Date.now
  const { database } = store
  const byId = new Map<string, RegisteredWorkspace>()
  const icons = createWorkspaceIconCache()

  const findByRoot = (root: string): RegisteredWorkspace | undefined => {
    for (const workspace of byId.values()) if (workspace.root === root) return workspace
    return undefined
  }

  /** Commit events together and follow what committed. */
  const commit = (events: readonly ProofEvent[]) => {
    for (const record of store.appendAtomic(events)) apply(record.event)
  }

  const announce = (workspace: Workspace) =>
    commit([
      ProofEventSchemas['workspace.updated'].parse({
        type: 'event',
        name: 'workspace.updated',
        eventId: randomUUID(),
        timestamp: new Date(clock()).toISOString(),
        scope: { type: 'environment', environmentId: store.environmentId },
        payload: { workspace },
      }),
    ])

  /** Follow one committed record: the cache never runs ahead of the rows (I11). */
  const apply = (event: ProofEvent): void => {
    if (event.name === 'workspace.updated') {
      const workspace = event.payload.workspace
      byId.set(
        workspace.workspaceId,
        Object.freeze({
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          root: workspace.path,
          lastUsedAt: workspace.lastUsedAt === null ? null : Date.parse(workspace.lastUsedAt),
          availability: workspace.availability ?? (workspace.exists ? 'available' : 'missing'),
        }),
      )
    } else if (event.name === 'workspace.removed') {
      byId.delete(event.payload.workspaceId)
    }
  }

  /**
   * Announce a workspace as `row` describes it; the projection writes it and
   * the committed record updates the cache before this returns. Built after
   * a flush, so the recency it states is what the rows say.
   */
  const write = (row: WorkspaceRow): RegisteredWorkspace => {
    store.flush()
    announce(workspaceFromRow(row, lastSessionActivity(database, row.workspace_id)))
    const written = byId.get(row.workspace_id)
    if (!written) throw new Error(`Workspace ${row.workspace_id} was written but not applied`)
    return written
  }

  /**
   * Look at the folder and announce what changed: availability, and the git
   * reading while it is available. Answers the workspace as the folder is
   * now, so routing never follows a stale row, even when the write failed.
   */
  const observe = (workspace: RegisteredWorkspace): RegisteredWorkspace => {
    const availability = availabilityOf(workspace.root)
    const reading = availability === 'available' ? readGitReading(workspace.root) : undefined
    const row = readWorkspaceRow(database, workspace.workspaceId)
    if (!row) return workspace
    const stored = row.availability === 'available' ? gitReadingOf(row) : undefined
    if (row.availability === availability && isDeepStrictEqual(stored, reading)) return workspace
    try {
      return write({ ...row, availability, git_json: gitJsonOf(availability, reading) })
    } catch (error) {
      options.onObservationError?.(workspace.workspaceId, error)
      return Object.freeze({ ...workspace, availability })
    }
  }

  /** Register a canonical root, or rename the registration it already has. */
  const upsert = (root: string, name: string | undefined): RegisteredWorkspace => {
    const existing = findByRoot(root)
    if (existing) {
      const current = observe(existing)
      if (name === undefined || name === current.name) return current
      const row = readWorkspaceRow(database, existing.workspaceId)
      if (!row) throw new Error(`Workspace ${existing.workspaceId} has no row`)
      return write({ ...row, name })
    }
    const availability = availabilityOf(root)
    return write({
      workspace_id: randomUUID(),
      name: name ?? basename(root) ?? root,
      path: root,
      availability,
      last_used_at: null,
      git_json: gitJsonOf(
        availability,
        availability === 'available' ? readGitReading(root) : undefined,
      ),
    })
  }

  for (const row of readWorkspaceRows(database)) {
    byId.set(
      row.workspace_id,
      Object.freeze({
        workspaceId: row.workspace_id,
        name: row.name,
        root: row.path,
        lastUsedAt: row.last_used_at,
        availability: row.availability,
      }),
    )
  }
  // New invalid roots are startup errors; known unavailable roots retain
  // their registration and sessions so the user can recover them.
  for (const configured of roots) {
    let root: string
    try {
      root = canonicalizeRoot(configured)
    } catch (error) {
      if (findByRoot(canonicalizeUnavailableRoot(configured))) continue
      throw error
    }
    if (!findByRoot(root)) upsert(root, undefined)
  }

  const rejectWorkspace = (
    workspaceId: string,
    reason: 'unknown' | 'missing' | 'inaccessible',
    context: CommandContext | undefined,
  ) => {
    audit.record({
      type: 'workspace.rejected',
      clientId: context?.clientId,
      details: {
        workspaceId: auditValue(workspaceId),
        reason,
        command: auditValue(context?.command),
      },
    })
  }

  const errorResult = (requestId: string, code: ErrorCode, message: string) => ({
    type: 'error' as const,
    requestId,
    error: { code, message },
  })

  /**
   * Register a folder by the path a user typed. The path must be absolute on
   * this environment and name an existing directory; it is canonicalized so
   * two spellings of one folder share a registration. A rejected path is
   * audited: probing which folders exist is worth noticing.
   */
  const register = (
    input: { path: string; name?: string },
    context?: CommandContext,
  ): WorkspaceRegistration => {
    const reject = (
      code: 'validation' | 'not_found',
      reason: string,
      message: string,
    ): WorkspaceRegistration => {
      audit.record({
        type: 'workspace.rejected',
        clientId: context?.clientId,
        details: {
          path: auditValue(input.path),
          reason,
          command: auditValue(context?.command),
        },
      })
      return { ok: false, code, message }
    }
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    try {
      validateRegistrationPath(path)
    } catch (error) {
      if (!(error instanceof PathBoundaryError)) throw error
      return reject(
        'validation',
        error.reason === 'absolute' ? 'relative' : error.reason,
        error.message,
      )
    }
    let root: string
    try {
      root = canonicalizeRoot(path)
    } catch (error) {
      if (hasCode(error, 'ENOENT', 'ENOTDIR')) {
        return reject('not_found', 'missing', 'No folder exists at that path on this environment.')
      }
      if (hasCode(error, 'EACCES', 'EPERM')) {
        return reject(
          'not_found',
          'inaccessible',
          'That folder cannot be opened on this environment.',
        )
      }
      if (error instanceof Error && error.message.startsWith('Workspace root is not a directory')) {
        return reject('validation', 'not_directory', 'That path is a file, not a folder.')
      }
      return reject(
        'validation',
        'invalid',
        'That folder path cannot be resolved on this environment.',
      )
    }
    const registered = upsert(root, input.name?.trim() || undefined)
    const workspace = readWorkspace(database, registered.workspaceId)
    if (!workspace) throw new Error(`Workspace ${registered.workspaceId} has no row`)
    return { ok: true, workspace }
  }

  /**
   * Forget a workspace. One transaction says everything that goes with it:
   * each of its sessions, deepest first, its new-session drafts detached,
   * then the workspace itself (db/deletions.ts).
   */
  const unregister = (workspaceId: string): boolean => {
    const workspace = byId.get(workspaceId)
    if (!workspace) return false
    options.onUnregister?.(workspaceId)
    icons.invalidate(workspace.root)
    store.flush()
    commit(workspaceRemovalEvents(database, store.environmentId, workspaceId, clock()))
    return true
  }

  /** Rows only: what was last observed and announced. Never writes. */
  const list = (): Workspace[] => readWorkspaces(database)

  return {
    list,
    register,
    unregister,

    /**
     * Follow a committed record written elsewhere. The host hands over every
     * record the event service commits; the registry's own are already
     * applied, and applying one twice changes nothing.
     */
    apply,

    /**
     * The folder most recently worked in that can still be opened: where a
     * provider is probed before any client has named a workspace. Folders
     * never used keep their registration order behind the used ones.
     *
     * Reads the filesystem but records nothing. A command that uses a
     * workspace announces what it finds; this is asked from inside those very
     * announcements, so it must not make one of its own.
     */
    mostRecent(): RegisteredWorkspace | undefined {
      return [...byId.values()]
        .sort((left, right) => (right.lastUsedAt ?? -1) - (left.lastUsedAt ?? -1))
        .find((workspace) => availabilityOf(workspace.root) === 'available')
    },

    /**
     * Why a workspace could not be routed to, for a caller that already
     * audited the rejection and now has to phrase it: an unknown ID is a
     * missing resource, a registered folder that cannot be used is recoverable.
     */
    availability(workspaceId: string): 'unknown' | RegisteredWorkspace['availability'] {
      const workspace = byId.get(workspaceId)
      return workspace ? observe(workspace).availability : 'unknown'
    },

    /** Look a workspace up without auditing; for callers that will report a miss themselves. */
    get(workspaceId: string): RegisteredWorkspace | undefined {
      const workspace = byId.get(workspaceId)
      const current = workspace && observe(workspace)
      return current?.availability === 'available' ? current : undefined
    },

    /**
     * Resolve a workspace named by a command. An unknown ID, including a root
     * path sent in place of an ID (workspace substitution, T12), is audited.
     * So is a registered folder that no longer exists: nothing can run there.
     */
    resolve(workspaceId: string, context?: CommandContext): RegisteredWorkspace | undefined {
      const workspace = byId.get(workspaceId)
      if (!workspace) {
        rejectWorkspace(workspaceId, 'unknown', context)
        return undefined
      }
      const current = observe(workspace)
      if (current.availability !== 'available') {
        rejectWorkspace(workspaceId, current.availability, context)
        return undefined
      }
      return current
    },

    /**
     * Resolve a client path under a workspace. Every filesystem, git, upload
     * and terminal command must obtain its absolute path here. Escapes are
     * audited with the client that attempted them.
     */
    resolvePath(
      workspaceId: string,
      relativePath: string,
      context?: CommandContext,
    ): WorkspacePathResult {
      const workspace = byId.get(workspaceId)
      if (!workspace) {
        rejectWorkspace(workspaceId, 'unknown', context)
        return { ok: false, reason: 'unknown_workspace' }
      }
      const current = observe(workspace)
      if (current.availability !== 'available') {
        rejectWorkspace(workspaceId, current.availability, context)
        return { ok: false, reason: 'unknown_workspace' }
      }
      try {
        return { ok: true, workspace, path: resolveWorkspacePath(workspace.root, relativePath) }
      } catch (error) {
        if (!(error instanceof PathBoundaryError)) throw error
        audit.record({
          type: 'path.rejected',
          clientId: context?.clientId,
          details: {
            workspaceId,
            path: auditValue(relativePath),
            reason: error.reason,
            command: auditValue(context?.command),
          },
        })
        return { ok: false, reason: error.reason }
      }
    },

    /** Stamp the workspace as used now; called when a session starts in it. */
    markUsed(workspaceId: string): void {
      const workspace = byId.get(workspaceId)
      if (!workspace) return
      observe(workspace)
      const row = readWorkspaceRow(database, workspaceId)
      if (!row) return
      // Connected clients order recents from their cached workspaces, so a
      // start must reach them now rather than on their next handshake.
      write({ ...row, last_used_at: clock() })
    },

    /**
     * The icon a sidebar shows for a workspace, read from the folder on this
     * environment. Unknown and missing workspaces are audited like any other
     * lookup; a folder that simply has no icon answers null.
     */
    async resolveIcon(workspaceId: string, context?: CommandContext): Promise<string | null> {
      const workspace = this.resolve(workspaceId, context)
      if (!workspace) return null
      try {
        return await icons.resolve(workspace.root)
      } catch {
        return null
      }
    },

    dispatch(
      command: CommandEnvelope,
      context?: CommandContext,
    ): unknown | Promise<unknown> | undefined {
      switch (command.name) {
        case 'workspace.list': {
          const parsed = ProofCommandSchemas['workspace.list'].safeParse(command)
          if (!parsed.success) {
            return errorResult(command.requestId, 'validation', 'Invalid workspace list request.')
          }
          // A read that also looks at every folder (plan risk 8): a folder
          // deleted outside the app is noticed on the next listing, as
          // before, and announced to every client. The snapshot only reads.
          for (const workspace of [...byId.values()]) observe(workspace)
          return ProofResponseSchemas['workspace.list'].parse({
            type: 'response',
            requestId: command.requestId,
            payload: { workspaces: list() },
          })
        }
        case 'workspace.add': {
          const parsed = ProofCommandSchemas['workspace.add'].safeParse(command)
          if (!parsed.success) {
            return errorResult(command.requestId, 'validation', 'Invalid workspace add request.')
          }
          const result = register(parsed.data.payload, context)
          if (!result.ok) return errorResult(command.requestId, result.code, result.message)
          return ProofResponseSchemas['workspace.add'].parse({
            type: 'response',
            requestId: command.requestId,
            payload: { workspace: result.workspace },
          })
        }
        case 'workspace.remove': {
          const parsed = ProofCommandSchemas['workspace.remove'].safeParse(command)
          if (!parsed.success) {
            return errorResult(command.requestId, 'validation', 'Invalid workspace remove request.')
          }
          if (!unregister(parsed.data.payload.workspaceId)) {
            return errorResult(command.requestId, 'not_found', 'Workspace not found.')
          }
          return ProofResponseSchemas['workspace.remove'].parse({
            type: 'response',
            requestId: command.requestId,
            payload: null,
          })
        }
        case 'workspace.icon': {
          const parsed = ProofCommandSchemas['workspace.icon'].safeParse(command)
          if (!parsed.success) {
            return errorResult(command.requestId, 'validation', 'Invalid workspace icon request.')
          }
          const { workspaceId } = parsed.data.payload
          if (!byId.has(workspaceId)) {
            rejectWorkspace(workspaceId, 'unknown', context)
            return errorResult(command.requestId, 'not_found', 'Workspace not found.')
          }
          return this.resolveIcon(workspaceId, context).then((iconDataUrl) =>
            ProofResponseSchemas['workspace.icon'].parse({
              type: 'response',
              requestId: command.requestId,
              payload: { iconDataUrl },
            }),
          )
        }
        default:
          return undefined
      }
    },

    /** Nothing to release: the registry holds no connection of its own. */
    close(): void {},
  }
}

export type WorkspaceRegistry = ReturnType<typeof openWorkspaceRegistry>
