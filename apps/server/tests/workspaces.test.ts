import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuditLog, type AuditEvent } from '../src/audit.js'
import { canonicalizeRoot } from '../src/workspace-paths.js'
import { openWorkspaceRegistry, type WorkspaceRegistry } from '../src/workspaces.js'

const directories: string[] = []
const registries: WorkspaceRegistry[] = []
afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'openmanager-workspaces-'))
  directories.push(base)
  const dataDir = join(base, 'data')
  const roots = { a: join(base, 'alpha'), b: join(base, 'beta'), outside: join(base, 'outside') }
  await mkdir(dataDir)
  for (const root of Object.values(roots)) await mkdir(join(root, 'src'), { recursive: true })
  const audits: AuditEvent[] = []
  const log = vi.fn()
  const audit = createAuditLog(log, () => new Date('2026-09-13T12:00:00Z'))
  audit.subscribe((event) => audits.push(event))
  const open = (configured: string[]) => {
    const registry = openWorkspaceRegistry(dataDir, configured, audit)
    registries.push(registry)
    return registry
  }
  return { base, dataDir, roots, audits, log, open }
}

describe('workspace registry', () => {
  it('assigns stable IDs to canonical roots and lists names only', async () => {
    const { roots, open, base } = await fixture()
    await symlink(
      roots.a,
      join(base, 'alpha-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const first = open([roots.a, join(base, 'alpha-link'), roots.b])
    const listed = first.list()
    expect(listed).toEqual([
      { workspaceId: expect.any(String), name: 'alpha' },
      { workspaceId: expect.any(String), name: 'beta' },
    ])
    expect(first.get(listed[0]!.workspaceId)?.root).toBe(canonicalizeRoot(roots.a))
    first.close()

    // A restart with the same roots keeps the IDs; a dropped root is no longer resolvable.
    const second = open([roots.b])
    expect(second.list()).toEqual([listed[1]])
    expect(second.get(listed[0]!.workspaceId)).toBeUndefined()
    expect(second.resolve(listed[0]!.workspaceId)).toBeUndefined()
    second.close()
    const third = open([roots.a, roots.b])
    expect(third.list()).toEqual(listed)
  })

  it('treats a root nested inside another configured root as the outer workspace', async () => {
    const { roots, open } = await fixture()
    const registry = open([join(roots.a, 'src'), roots.a])
    expect(registry.list()).toEqual([{ workspaceId: expect.any(String), name: 'alpha' }])
  })

  it('fails startup for a root that does not exist', async () => {
    const { roots, open } = await fixture()
    expect(() => open([join(roots.a, 'missing')])).toThrow()
  })

  it('audits workspace substitution with the client and command that attempted it', async () => {
    const { roots, open, audits, log } = await fixture()
    const registry = open([roots.a])
    const context = { clientId: 'client-1', command: 'session.create' }
    expect(registry.resolve(roots.a, context)).toBeUndefined()
    expect(registry.resolve(roots.b, context)).toBeUndefined()
    expect(registry.resolve('x'.repeat(300))).toBeUndefined()
    expect(audits).toEqual([
      {
        type: 'workspace.rejected',
        at: '2026-09-13T12:00:00.000Z',
        clientId: 'client-1',
        details: { workspaceId: roots.a, command: 'session.create' },
      },
      {
        type: 'workspace.rejected',
        at: '2026-09-13T12:00:00.000Z',
        clientId: 'client-1',
        details: { workspaceId: roots.b, command: 'session.create' },
      },
      {
        type: 'workspace.rejected',
        at: '2026-09-13T12:00:00.000Z',
        clientId: undefined,
        details: { workspaceId: `${'x'.repeat(256)}...`, command: null },
      },
    ])
    expect(log).toHaveBeenCalledTimes(3)
    expect(log.mock.calls[0]).toEqual(['warn', 'audit', { audit: audits[0] }])
  })

  it('resolves paths under a workspace and audits escapes and substitutions', async () => {
    const { roots, open, audits } = await fixture()
    const registry = open([roots.a])
    const [{ workspaceId }] = registry.list()
    const context = { clientId: 'client-2', command: 'file.read' }
    expect(registry.resolvePath(workspaceId, 'src/index.ts', context)).toEqual({
      ok: true,
      workspace: expect.objectContaining({ workspaceId, name: 'alpha' }),
      path: join(canonicalizeRoot(roots.a), 'src', 'index.ts'),
    })
    expect(registry.resolvePath(workspaceId, '../beta/src', context)).toEqual({
      ok: false,
      reason: 'escape',
    })
    expect(registry.resolvePath(workspaceId, roots.outside, context)).toEqual({
      ok: false,
      reason: 'absolute',
    })
    expect(registry.resolvePath(roots.a, 'src', context)).toEqual({
      ok: false,
      reason: 'unknown_workspace',
    })
    expect(audits.map((event) => [event.type, event.clientId, event.details])).toEqual([
      [
        'path.rejected',
        'client-2',
        { workspaceId, path: '../beta/src', reason: 'escape', command: 'file.read' },
      ],
      [
        'path.rejected',
        'client-2',
        { workspaceId, path: roots.outside, reason: 'absolute', command: 'file.read' },
      ],
      ['workspace.rejected', 'client-2', { workspaceId: roots.a, command: 'file.read' }],
    ])
  })

  it('answers workspace.list with IDs and names only', async () => {
    const { roots, open } = await fixture()
    const registry = open([roots.a, roots.b])
    const response = registry.dispatch({
      type: 'command',
      requestId: 'list-1',
      name: 'workspace.list',
      payload: null,
    })
    expect(response).toEqual({
      type: 'response',
      requestId: 'list-1',
      payload: { workspaces: registry.list() },
    })
    expect(JSON.stringify(response).toLowerCase()).not.toContain(roots.a.toLowerCase())
    expect(
      registry.dispatch({
        type: 'command',
        requestId: 'list-2',
        name: 'workspace.list',
        payload: {},
      }),
    ).toMatchObject({ type: 'error', error: { code: 'validation' } })
    expect(
      registry.dispatch({ type: 'command', requestId: 'x', name: 'session.list', payload: null }),
    ).toBeUndefined()
  })
})
