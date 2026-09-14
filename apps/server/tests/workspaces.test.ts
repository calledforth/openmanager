import * as fs from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProofEvent } from '@openmanager/protocol/node'
import { createAuditLog, type AuditEvent } from '../src/audit.js'
import { canonicalizeRoot } from '../src/workspace-paths.js'
import {
  openWorkspaceRegistry,
  type WorkspaceRegistryOptions,
  type WorkspaceRegistry,
} from '../src/workspaces.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, accessSync: vi.fn(actual.accessSync) }
})

const directories: string[] = []
const registries: WorkspaceRegistry[] = []
afterEach(async () => {
  vi.mocked(fs.accessSync).mockReset()
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
  const events: ProofEvent[] = []
  let now = Date.parse('2026-09-13T12:00:00Z')
  const open = (configured: string[], options: WorkspaceRegistryOptions = {}) => {
    const registry = openWorkspaceRegistry(dataDir, configured, audit, {
      allowedRoots: [base],
      clock: () => now,
      events: { environmentId: 'env-1', emit: (event) => events.push(event) },
      ...options,
    })
    registries.push(registry)
    return registry
  }
  return { base, dataDir, roots, audits, events, log, open, tick: (ms: number) => (now += ms) }
}

const listed = (name: string, path: string, extra: Record<string, unknown> = {}) => ({
  workspaceId: expect.any(String),
  name,
  path,
  lastUsedAt: null,
  exists: true,
  ...extra,
})

describe('workspace registry', () => {
  it('assigns stable IDs to canonical roots and lists them with their path', async () => {
    const { roots, open, base } = await fixture()
    await symlink(
      roots.a,
      join(base, 'alpha-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const first = open([roots.a, join(base, 'alpha-link'), roots.b])
    const workspaces = first.list()
    expect(workspaces).toEqual([
      listed('alpha', canonicalizeRoot(roots.a)),
      listed('beta', canonicalizeRoot(roots.b)),
    ])
    expect(first.get(workspaces[0]!.workspaceId)?.root).toBe(canonicalizeRoot(roots.a))
    first.close()

    // Registrations persist: a restart keeps the IDs, and a root dropped from
    // the command line stays registered until it is unregistered.
    const second = open([roots.b])
    expect(second.list()).toEqual(workspaces)
    expect(second.resolve(workspaces[0]!.workspaceId)?.root).toBe(canonicalizeRoot(roots.a))
    second.close()
    const third = open([roots.a, roots.b])
    expect(third.list()).toEqual(workspaces)
  })

  it('registers a nested folder as its own workspace', async () => {
    const { roots, open } = await fixture()
    const registry = open([join(roots.a, 'src'), roots.a])
    expect(registry.list().map((workspace) => workspace.name)).toEqual(['src', 'alpha'])
  })

  it('registers a typed path, canonicalized, and announces it once', async () => {
    const { roots, open, base, events, audits } = await fixture()
    await symlink(
      roots.b,
      join(base, 'beta-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const registry = open([roots.a])
    const context = { clientId: 'client-1', command: 'workspace.add' }
    const added = registry.register({ path: ` ${join(base, 'beta-link')} ` }, context)
    expect(added).toEqual({ ok: true, workspace: listed('beta', canonicalizeRoot(roots.b)) })
    if (!added.ok) throw new Error('unreachable')
    expect(registry.list()).toEqual([listed('alpha', canonicalizeRoot(roots.a)), added.workspace])
    expect(events).toEqual([
      expect.objectContaining({
        name: 'workspace.updated',
        scope: { type: 'environment', environmentId: 'env-1' },
        payload: { workspace: added.workspace },
      }),
    ])
    // The same folder spelled differently is the same registration.
    expect(registry.register({ path: roots.b }, context)).toEqual(added)
    expect(registry.list()).toHaveLength(2)
    // A name is optional and can be set on re-registration.
    expect(registry.register({ path: roots.b, name: 'Beta' }, context)).toEqual({
      ok: true,
      workspace: { ...added.workspace, name: 'Beta' },
    })
    expect(audits).toEqual([])
  })

  it('refuses paths that are relative, missing, or a file, and audits each', async () => {
    const { roots, open, audits } = await fixture()
    const registry = open([])
    const context = { clientId: 'client-1', command: 'workspace.add' }
    await writeFile(join(roots.a, 'notes.txt'), 'x')
    expect(registry.register({ path: '   ' }, context)).toMatchObject({
      ok: false,
      code: 'validation',
    })
    expect(registry.register({ path: 'relative/folder' }, context)).toMatchObject({
      ok: false,
      code: 'validation',
      message: 'The path must be absolute.',
    })
    expect(registry.register({ path: join(roots.a, 'nope') }, context)).toMatchObject({
      ok: false,
      code: 'not_found',
      message: 'No folder exists at that path on this environment.',
    })
    expect(registry.register({ path: join(roots.a, 'notes.txt') }, context)).toMatchObject({
      ok: false,
      code: 'validation',
      message: 'That path is a file, not a folder.',
    })
    expect(registry.list()).toEqual([])
    expect(audits.map((event) => [event.type, event.clientId, event.details.reason])).toEqual([
      ['workspace.rejected', 'client-1', 'invalid'],
      ['workspace.rejected', 'client-1', 'relative'],
      ['workspace.rejected', 'client-1', 'missing'],
      ['workspace.rejected', 'client-1', 'not_directory'],
    ])
  })

  it('unregisters a workspace, announces it, and forgets it across restarts', async () => {
    const { roots, open, events } = await fixture()
    const closed: string[] = []
    const first = open([roots.a, roots.b], { onUnregister: (id) => closed.push(id) })
    const [alpha, beta] = first.list()
    expect(first.unregister(beta!.workspaceId)).toBe(true)
    // Live work in the folder is stopped before anyone hears the workspace is gone.
    expect(closed).toEqual([beta!.workspaceId])
    expect(events.at(-1)!.name).toBe('workspace.removed')
    expect(first.unregister(beta!.workspaceId)).toBe(false)
    expect(first.list()).toEqual([alpha])
    expect(first.get(beta!.workspaceId)).toBeUndefined()
    expect(events.at(-1)).toMatchObject({
      name: 'workspace.removed',
      payload: { workspaceId: beta!.workspaceId },
    })
    first.close()
    const second = open([])
    expect(second.list()).toEqual([alpha])
  })

  it('flags a registered folder that is gone as missing and refuses to resolve it', async () => {
    const { roots, open, audits } = await fixture()
    const registry = open([roots.a, roots.b])
    const [alpha, beta] = registry.list()
    await rm(roots.b, { recursive: true })
    expect(registry.list()).toEqual([alpha, { ...beta, exists: false }])
    const context = { clientId: 'client-1', command: 'session.create' }
    expect(registry.resolve(beta!.workspaceId, context)).toBeUndefined()
    expect(audits).toEqual([
      expect.objectContaining({
        type: 'workspace.rejected',
        clientId: 'client-1',
        details: { workspaceId: beta!.workspaceId, reason: 'missing', command: 'session.create' },
      }),
    ])
    // Back on disk, it is usable again without re-registering.
    await mkdir(roots.b)
    expect(registry.list()).toEqual([alpha, beta])
    expect(registry.resolve(beta!.workspaceId, context)?.root).toBe(beta!.path)
  })

  it('records when a workspace was last used and keeps it across restarts', async () => {
    const { roots, open, tick } = await fixture()
    const first = open([roots.a])
    const [alpha] = first.list()
    expect(alpha!.lastUsedAt).toBeNull()
    tick(60_000)
    first.markUsed(alpha!.workspaceId)
    first.markUsed('unknown')
    expect(first.list()[0]!.lastUsedAt).toBe('2026-09-13T12:01:00.000Z')
    first.close()
    expect(open([roots.a]).list()[0]!.lastUsedAt).toBe('2026-09-13T12:01:00.000Z')
  })

  it('defaults to configured roots, rejects outside paths and traversal without persisting or emitting', async () => {
    const { roots, open, events, audits } = await fixture()
    const registry = open([roots.a], { allowedRoots: undefined })
    for (const path of ['../other', `${roots.a}/src/../src`, `${roots.a}\\src\\..\\src`, roots.b]) {
      expect(registry.register({ path })).toMatchObject({ ok: false, code: 'validation' })
    }
    expect(registry.list()).toHaveLength(1)
    expect(events).toEqual([])
    expect(audits).toHaveLength(4)
    expect(registry.register({ path: join(roots.a, 'src') }).ok).toBe(true)
    registry.close()
    expect(open([], { allowedRoots: [] }).register({ path: roots.a })).toMatchObject({ ok: false })
  })

  it('checks symlink targets and canonicalizes aliases to a single registration', async () => {
    const { roots, open } = await fixture()
    const registry = open([roots.a], { allowedRoots: undefined })
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(roots.b, join(roots.a, 'escape'), type)
    expect(registry.register({ path: join(roots.a, 'escape') })).toMatchObject({
      ok: false,
      code: 'validation',
    })
    await symlink(join(roots.a, 'src'), join(roots.a, 'alias'), type)
    const added = registry.register({ path: join(roots.a, 'alias') })
    expect(added).toMatchObject({
      ok: true,
      workspace: { path: canonicalizeRoot(join(roots.a, 'src')) },
    })
    expect(registry.register({ path: join(roots.a, 'src') })).toEqual(added)
  })

  it('marks restored paths outside a narrowed allowlist unavailable', async () => {
    const { roots, open } = await fixture()
    const first = open([roots.a, roots.b])
    const beta = first.list()[1]!
    first.close()
    const second = open([roots.a], { allowedRoots: undefined })
    expect(second.list().find((workspace) => workspace.workspaceId === beta.workspaceId)).toEqual({
      ...beta,
      exists: false,
    })
    expect(second.resolve(beta.workspaceId)).toBeUndefined()
    expect(second.get(beta.workspaceId)).toBeUndefined()
    expect(second.resolvePath(beta.workspaceId, 'src')).toEqual({
      ok: false,
      reason: 'unknown_workspace',
    })
  })

  it('refuses a stored directory replaced by a symlink before and after restart', async () => {
    const { roots, open } = await fixture()
    const first = open([roots.a], { allowedRoots: undefined })
    const added = first.register({ path: join(roots.a, 'src') })
    if (!added.ok) throw new Error('registration failed')
    await rm(join(roots.a, 'src'), { recursive: true })
    await symlink(roots.b, join(roots.a, 'src'), process.platform === 'win32' ? 'junction' : 'dir')
    const verify = (registry: WorkspaceRegistry) => {
      expect(
        registry.list().find((workspace) => workspace.workspaceId === added.workspace.workspaceId)
          ?.exists,
      ).toBe(false)
      expect(registry.resolve(added.workspace.workspaceId)).toBeUndefined()
      expect(registry.resolvePath(added.workspace.workspaceId, 'new.txt').ok).toBe(false)
    }
    verify(first)
    first.close()
    verify(open([roots.a], { allowedRoots: undefined }))
  })

  it('refuses unreadable directories and marks existing registrations unavailable', async () => {
    const { roots, open } = await fixture()
    const registry = open([roots.a])
    const alpha = registry.list()[0]!
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw Object.assign(new Error('Access denied'), { code: 'EACCES' })
    })
    expect(registry.register({ path: join(roots.a, 'src') })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    expect(registry.list()).toEqual([{ ...alpha, exists: false }])
    expect(registry.resolve(alpha.workspaceId)).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')(
    'keeps canonical POSIX names distinct from client input syntax',
    async () => {
      const { roots, open } = await fixture()
      const unusual = join(roots.a, 'literal\\name')
      await mkdir(unusual)
      const first = open([unusual], { allowedRoots: [roots.a] })
      const workspace = first.list()[0]!
      expect(workspace.exists).toBe(true)
      expect(first.get(workspace.workspaceId)?.root).toBe(canonicalizeRoot(unusual))
      expect(first.resolve(workspace.workspaceId)?.root).toBe(canonicalizeRoot(unusual))
      expect(first.resolvePath(workspace.workspaceId, 'new.txt').ok).toBe(true)
      first.close()
      const second = open([], { allowedRoots: [roots.a] })
      expect(second.list()).toEqual([workspace])
      expect(second.resolve(workspace.workspaceId)?.root).toBe(canonicalizeRoot(unusual))
    },
  )

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
        command: 'session.create',
        outcome: 'rejected',
        details: { workspaceId: roots.a, reason: 'unknown', command: 'session.create' },
      },
      {
        type: 'workspace.rejected',
        at: '2026-09-13T12:00:00.000Z',
        clientId: 'client-1',
        command: 'session.create',
        outcome: 'rejected',
        details: { workspaceId: roots.b, reason: 'unknown', command: 'session.create' },
      },
      {
        type: 'workspace.rejected',
        at: '2026-09-13T12:00:00.000Z',
        outcome: 'rejected',
        details: { workspaceId: `${'x'.repeat(256)}...`, reason: 'unknown', command: null },
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
      [
        'workspace.rejected',
        'client-2',
        { workspaceId: roots.a, reason: 'unknown', command: 'file.read' },
      ],
    ])
  })

  it('answers workspace list, add and remove commands', async () => {
    const { roots, open } = await fixture()
    const registry = open([roots.a])
    const context = { clientId: 'client-1', command: 'workspace.add' }
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
    const added = registry.dispatch(
      { type: 'command', requestId: 'add-1', name: 'workspace.add', payload: { path: roots.b } },
      context,
    ) as { payload: { workspace: { workspaceId: string } } }
    expect(added).toEqual({
      type: 'response',
      requestId: 'add-1',
      payload: { workspace: listed('beta', canonicalizeRoot(roots.b)) },
    })
    expect(
      registry.dispatch(
        {
          type: 'command',
          requestId: 'add-2',
          name: 'workspace.add',
          payload: { path: join(roots.b, 'nope') },
        },
        context,
      ),
    ).toEqual({
      type: 'error',
      requestId: 'add-2',
      error: { code: 'not_found', message: 'No folder exists at that path on this environment.' },
    })
    expect(
      registry.dispatch(
        { type: 'command', requestId: 'add-3', name: 'workspace.add', payload: { path: '' } },
        context,
      ),
    ).toMatchObject({ type: 'error', error: { code: 'validation' } })
    expect(
      registry.dispatch({
        type: 'command',
        requestId: 'remove-1',
        name: 'workspace.remove',
        payload: { workspaceId: added.payload.workspace.workspaceId },
      }),
    ).toEqual({ type: 'response', requestId: 'remove-1', payload: null })
    expect(
      registry.dispatch({
        type: 'command',
        requestId: 'remove-2',
        name: 'workspace.remove',
        payload: { workspaceId: added.payload.workspace.workspaceId },
      }),
    ).toMatchObject({ type: 'error', error: { code: 'not_found' } })
    expect(registry.list()).toHaveLength(1)
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
