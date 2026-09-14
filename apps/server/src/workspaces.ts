import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  ProofCommandSchemas,
  ProofEventSchemas,
  ProofResponseSchemas,
  type CommandEnvelope,
  type ErrorCode,
  type ProofEvent,
  type Workspace,
} from '@openmanager/protocol/node'
import { auditValue, type AuditLog } from './audit.ts'
import type { CommandContext } from './command-context.ts'
import { openEnvironmentDatabase } from './db/database.ts'
import {
  canonicalizeRoot,
  isWithinRoot,
  PathBoundaryError,
  resolveWorkspacePath,
  validateRegistrationPath,
} from './workspace-paths.ts'

export interface RegisteredWorkspace {
  readonly workspaceId: string
  readonly name: string
  /** Canonical on-disk root, as `realpath` resolved it. */
  readonly root: string
  /** Epoch milliseconds of the last session started here; null until one is. */
  readonly lastUsedAt: number | null
}

export type WorkspacePathResult =
  | { ok: true; workspace: RegisteredWorkspace; path: string }
  | { ok: false; reason: 'unknown_workspace' | PathBoundaryError['reason'] }

export type WorkspaceRegistration =
  | { ok: true; workspace: Workspace }
  | { ok: false; code: Extract<ErrorCode, 'validation' | 'not_found'>; message: string }

export interface WorkspaceRegistryOptions {
  /** Server-controlled registration boundary; defaults to configured roots. Empty denies all. */
  allowedRoots?: readonly string[]
  clock?: () => number
  /** Where registration changes are announced so every connected client sees them. */
  events?: { environmentId: string; emit: (event: ProofEvent) => void }
  /** Runs before a removal is announced, so live work in the folder can be stopped. */
  onUnregister?: (workspaceId: string) => void
  /**
   * Provider IDs the environment can start a session with right now. Read
   * each time workspaces are listed, so health changes show up without a
   * restart. Defaults to none.
   */
  availableProviders?: () => readonly string[]
}

type WorkspaceRow = {
  workspace_id: string
  name: string
  path: string
  last_used_at: number | null
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && 'code' in error && codes.includes(String(error.code))
}

/**
 * The set of roots this environment exposes (threat model D9). Clients name a
 * workspace by the ID the server assigned and never send a root path in its
 * place. Registrations persist in the `workspaces` table, so a workspace
 * added from a client survives a restart; roots passed on the command line
 * are registered the same way on every start. A registered folder that has
 * since been moved or deleted stays listed, flagged as missing, until it is
 * unregistered or comes back.
 */
export function openWorkspaceRegistry(
  dataDir: string,
  roots: readonly string[],
  audit: AuditLog,
  options: WorkspaceRegistryOptions = {},
) {
  const allowedRoots = (options.allowedRoots ?? roots).map(canonicalizeRoot)
  const isAllowed = (root: string) => allowedRoots.some((allowed) => isWithinRoot(allowed, root))
  const isAvailable = (root: string): boolean => {
    try {
      return isAllowed(root) && canonicalizeRoot(root) === root
    } catch {
      return false
    }
  }
  const clock = options.clock ?? Date.now
  const database = openEnvironmentDatabase(dataDir)
  const byId = new Map<string, RegisteredWorkspace>()
  const statements = {
    byPath: database.prepare(
      'SELECT workspace_id, name, path, last_used_at FROM workspaces WHERE path = ?',
    ),
    insert: database.prepare(`
      INSERT INTO workspaces (workspace_id, name, path, availability, created_at, updated_at)
      VALUES (?, ?, ?, 'available', ?, ?)
    `),
    rename: database.prepare(
      'UPDATE workspaces SET name = ?, updated_at = ? WHERE workspace_id = ?',
    ),
    remove: database.prepare('DELETE FROM workspaces WHERE workspace_id = ?'),
    markUsed: database.prepare(
      'UPDATE workspaces SET last_used_at = ?, updated_at = ? WHERE workspace_id = ?',
    ),
    // One grouped read over the (workspace_id, updated_at) index; no per-row query.
    lastActivity: database.prepare(
      'SELECT workspace_id, MAX(updated_at) AS last_activity_at FROM sessions GROUP BY workspace_id',
    ),
  }

  const findByRoot = (root: string): RegisteredWorkspace | undefined => {
    const row = statements.byPath.get(root) as WorkspaceRow | undefined
    return row ? byId.get(row.workspace_id) : undefined
  }

  /** Register a canonical root, or return the existing registration for it. */
  const upsert = (root: string, name: string | undefined): RegisteredWorkspace => {
    const now = clock()
    const existing = findByRoot(root)
    if (existing) {
      if (name === undefined || name === existing.name) return existing
      statements.rename.run(name, now, existing.workspaceId)
      const renamed = Object.freeze({ ...existing, name })
      byId.set(existing.workspaceId, renamed)
      return renamed
    }
    const workspaceId = randomUUID()
    const workspace = Object.freeze({
      workspaceId,
      name: name ?? basename(root) ?? root,
      root,
      lastUsedAt: null,
    })
    statements.insert.run(workspaceId, workspace.name, root, now, now)
    byId.set(workspaceId, workspace)
    return workspace
  }

  try {
    const rows = database
      .prepare(
        'SELECT workspace_id, name, path, last_used_at FROM workspaces ORDER BY created_at, rowid',
      )
      .all() as WorkspaceRow[]
    for (const row of rows) {
      byId.set(
        row.workspace_id,
        Object.freeze({
          workspaceId: row.workspace_id,
          name: row.name,
          root: row.path,
          lastUsedAt: row.last_used_at,
        }),
      )
    }
    // A configured root that does not exist is a startup error: the operator
    // named it explicitly and would otherwise silently get nothing.
    for (const configured of roots) {
      const root = canonicalizeRoot(configured)
      if (!isAllowed(root)) throw new Error('Configured workspace is outside allowed roots.')
      upsert(root, undefined)
    }
  } catch (error) {
    database.close()
    throw error
  }

  const toIso = (epochMs: number | null): string | null =>
    epochMs === null ? null : new Date(epochMs).toISOString()

  /** Latest session `updated_at` per workspace, read once per listing. */
  const readSessionActivity = (): Map<string, number> => {
    const rows = statements.lastActivity.all() as {
      workspace_id: string
      last_activity_at: number | null
    }[]
    const activity = new Map<string, number>()
    for (const row of rows) {
      if (row.last_activity_at !== null) activity.set(row.workspace_id, row.last_activity_at)
    }
    return activity
  }

  const toPublic = (
    workspace: RegisteredWorkspace,
    sessionActivity: Map<string, number> = readSessionActivity(),
    providers: readonly string[] = options.availableProviders?.() ?? [],
  ): Workspace => {
    const exists = isAvailable(workspace.root)
    const sessionLast = sessionActivity.get(workspace.workspaceId) ?? null
    const lastActivityAt =
      sessionLast === null
        ? workspace.lastUsedAt
        : Math.max(sessionLast, workspace.lastUsedAt ?? sessionLast)
    return {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      path: workspace.root,
      lastUsedAt: toIso(workspace.lastUsedAt),
      lastActivityAt: toIso(lastActivityAt),
      exists,
      capabilities: {
        // A single stat of `<root>/.git`; never a tree walk (D9 cost budget).
        git: exists && existsSync(join(workspace.root, '.git')),
        providers: [...providers],
      },
    }
  }

  const emit = (
    name: 'workspace.updated' | 'workspace.removed',
    payload: { workspace: Workspace } | { workspaceId: string },
  ) => {
    if (!options.events) return
    const schema = ProofEventSchemas[name] as { parse(input: unknown): ProofEvent }
    options.events.emit(
      schema.parse({
        type: 'event',
        name,
        eventId: randomUUID(),
        timestamp: new Date(clock()).toISOString(),
        scope: { type: 'environment', environmentId: options.events.environmentId },
        payload,
      }),
    )
  }

  const rejectWorkspace = (
    workspaceId: string,
    reason: 'unknown' | 'missing',
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
    if (!isAllowed(root)) {
      return reject('validation', 'escape', 'That folder is outside the allowed workspace roots.')
    }
    const workspace = toPublic(upsert(root, input.name?.trim() || undefined))
    emit('workspace.updated', { workspace })
    return { ok: true, workspace }
  }

  /** Forget a workspace. Sessions recorded under it go with it (FK cascade). */
  const unregister = (workspaceId: string): boolean => {
    if (!byId.has(workspaceId)) return false
    options.onUnregister?.(workspaceId)
    statements.remove.run(workspaceId)
    byId.delete(workspaceId)
    emit('workspace.removed', { workspaceId })
    return true
  }

  let closed = false
  const list = (): Workspace[] => {
    const sessionActivity = readSessionActivity()
    const providers = options.availableProviders?.() ?? []
    return [...byId.values()].map((workspace) => toPublic(workspace, sessionActivity, providers))
  }

  return {
    list,
    register,
    unregister,

    /** Look a workspace up without auditing; for callers that will report a miss themselves. */
    get(workspaceId: string): RegisteredWorkspace | undefined {
      const workspace = byId.get(workspaceId)
      return workspace && isAvailable(workspace.root) ? workspace : undefined
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
      if (!isAvailable(workspace.root)) {
        rejectWorkspace(workspaceId, 'missing', context)
        return undefined
      }
      return workspace
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
      if (!isAvailable(workspace.root)) {
        rejectWorkspace(workspaceId, 'missing', context)
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
      const now = clock()
      statements.markUsed.run(now, now, workspaceId)
      byId.set(workspaceId, Object.freeze({ ...workspace, lastUsedAt: now }))
    },

    dispatch(command: CommandEnvelope, context?: CommandContext): unknown | undefined {
      switch (command.name) {
        case 'workspace.list': {
          const parsed = ProofCommandSchemas['workspace.list'].safeParse(command)
          if (!parsed.success) {
            return errorResult(command.requestId, 'validation', 'Invalid workspace list request.')
          }
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
        default:
          return undefined
      }
    },

    close(): void {
      if (closed) return
      closed = true
      database.close()
    },
  }
}

export type WorkspaceRegistry = ReturnType<typeof openWorkspaceRegistry>
