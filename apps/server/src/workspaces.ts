import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  ProofCommandSchemas,
  ProofResponseSchemas,
  type CommandEnvelope,
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
} from './workspace-paths.ts'

export interface RegisteredWorkspace {
  readonly workspaceId: string
  readonly name: string
  /** Canonical on-disk root. Never sent to clients. */
  readonly root: string
}

export type WorkspacePathResult =
  | { ok: true; workspace: RegisteredWorkspace; path: string }
  | { ok: false; reason: 'unknown_workspace' | PathBoundaryError['reason'] }

/**
 * The set of roots this environment exposes (threat model D9). Clients name a
 * workspace by the ID the server assigned; the root path never travels. IDs
 * persist in the `workspaces` table so sessions survive a restart, but only
 * the roots configured for this process are resolvable in it.
 */
export function openWorkspaceRegistry(
  dataDir: string,
  roots: readonly string[],
  audit: AuditLog,
  clock: () => number = Date.now,
) {
  const database = openEnvironmentDatabase(dataDir)
  const byId = new Map<string, RegisteredWorkspace>()
  try {
    const byPath = database.prepare('SELECT workspace_id FROM workspaces WHERE path = ?')
    const insert = database.prepare(`
      INSERT INTO workspaces (workspace_id, name, path, availability, created_at, updated_at)
      VALUES (?, ?, ?, 'available', ?, ?)
    `)
    const touch = database.prepare(`
      UPDATE workspaces SET name = ?, availability = 'available', updated_at = ?
      WHERE workspace_id = ?
    `)
    for (const configured of roots) {
      const root = canonicalizeRoot(configured)
      if ([...byId.values()].some((workspace) => isWithinRoot(workspace.root, root))) continue
      for (const [workspaceId, workspace] of byId) {
        // A root nested inside another root is one workspace: the outer one.
        if (isWithinRoot(root, workspace.root)) byId.delete(workspaceId)
      }
      const name = basename(root) || root
      const now = clock()
      const row = byPath.get(root) as { workspace_id: string } | undefined
      let workspaceId: string
      if (row) {
        workspaceId = row.workspace_id
        touch.run(name, now, workspaceId)
      } else {
        workspaceId = randomUUID()
        insert.run(workspaceId, name, root, now, now)
      }
      byId.set(workspaceId, Object.freeze({ workspaceId, name, root }))
    }
  } catch (error) {
    database.close()
    throw error
  }

  const rejectWorkspace = (workspaceId: string, context: CommandContext | undefined) => {
    audit.record({
      type: 'workspace.rejected',
      clientId: context?.clientId,
      details: {
        workspaceId: auditValue(workspaceId),
        command: auditValue(context?.command),
      },
    })
  }

  let closed = false
  const list = (): Workspace[] =>
    [...byId.values()].map(({ workspaceId, name }) => ({ workspaceId, name }))

  return {
    list,

    /** Look a workspace up without auditing; for callers that will report a miss themselves. */
    get(workspaceId: string): RegisteredWorkspace | undefined {
      return byId.get(workspaceId)
    },

    /**
     * Resolve a workspace named by a command. An unknown ID, including a root
     * path sent in place of an ID (workspace substitution, T12), is audited.
     */
    resolve(workspaceId: string, context?: CommandContext): RegisteredWorkspace | undefined {
      const workspace = byId.get(workspaceId)
      if (!workspace) rejectWorkspace(workspaceId, context)
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
        rejectWorkspace(workspaceId, context)
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

    dispatch(command: CommandEnvelope): unknown | undefined {
      if (command.name !== 'workspace.list') return undefined
      const parsed = ProofCommandSchemas['workspace.list'].safeParse(command)
      if (!parsed.success) {
        return {
          type: 'error',
          requestId: command.requestId,
          error: { code: 'validation', message: 'Invalid workspace list request.' },
        }
      }
      return ProofResponseSchemas['workspace.list'].parse({
        type: 'response',
        requestId: command.requestId,
        payload: { workspaces: list() },
      })
    },

    close(): void {
      if (closed) return
      closed = true
      database.close()
    },
  }
}

export type WorkspaceRegistry = ReturnType<typeof openWorkspaceRegistry>
