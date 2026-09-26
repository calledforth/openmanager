import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeConnectionFactory } from '@agentpack/runtime/testing'
import type { CommandEnvelope } from '@openmanager/protocol/node'
import {
  openEnvironmentSettings,
  type EnvironmentSettingsStore,
} from '../src/environment-settings.js'
import {
  BrowseError,
  createFilesystemService,
  listFolder,
  resolveBrowsePath,
} from '../src/filesystem.js'
import {
  cleanupProtocolHosts,
  connectProtocol,
  handshake,
  nextResponse,
} from './helpers/protocol-client.js'
import { startStubHost } from './helpers/proof-slice.js'

const directories: string[] = []
const stores: EnvironmentSettingsStore[] = []

async function tempDir(prefix = 'openmanager-filesystem-test-') {
  // realpath: Windows CI hands out 8.3 short names, which a listing would
  // otherwise spell differently from the path the test built.
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  directories.push(directory)
  return directory
}

/** home/ with alpha/, Beta/, .hidden/, item10/, item9/, a file, and a link to alpha. */
async function tree() {
  const home = await tempDir()
  for (const name of ['alpha', 'Beta', '.hidden', 'item10', 'item9']) {
    await mkdir(join(home, name))
  }
  await writeFile(join(home, 'notes.txt'), 'not a folder')
  // 'junction' on Windows needs no privilege; elsewhere it is a directory link.
  await symlink(join(home, 'alpha'), join(home, 'linked'), 'junction')
  await symlink(join(home, 'missing'), join(home, 'dangling'), 'junction')
  return home
}

async function service(home: string) {
  const settings = openEnvironmentSettings(await tempDir('openmanager-settings-test-'))
  stores.push(settings)
  return { settings, filesystem: createFilesystemService({ settings, home: () => home }) }
}

const command = (name: string, payload: CommandEnvelope['payload']): CommandEnvelope => ({
  type: 'command',
  requestId: 'req-1',
  name,
  payload,
})

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await cleanupProtocolHosts()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('resolveBrowsePath', () => {
  const home = resolve('/home/you')

  it('expands ~ to the home folder', () => {
    expect(resolveBrowsePath('~', home)).toBe(home)
    expect(resolveBrowsePath('~/code', home)).toBe(join(home, 'code'))
    expect(resolveBrowsePath('~\\code', home, 'win32')).toBe(join(home, 'code'))
  })

  it('refuses relative paths and parent segments', () => {
    for (const path of ['code', './code', 'C:code', '/a/../b']) {
      expect(() => resolveBrowsePath(path, home, 'linux')).toThrow(BrowseError)
    }
  })

  it.runIf(process.platform === 'win32')('reads a bare drive as its root', () => {
    expect(resolveBrowsePath('c:', home, 'win32')).toBe('c:\\')
  })
})

describe('listFolder', () => {
  it('lists every child folder, links included, sorted by name', async () => {
    const home = await tree()
    const listing = await listFolder(home)
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      '.hidden',
      'alpha',
      'Beta',
      'item9',
      'item10',
      'linked',
    ])
    expect(listing.entries[1]).toEqual({ name: 'alpha', path: join(home, 'alpha') })
    expect(listing).toMatchObject({ path: home, parentPath: parse(home).dir, readable: true })
  })

  it('narrows by prefix ignoring case, and sends only what fits its budget', async () => {
    const home = await tree()
    expect((await listFolder(home, { prefix: 'ITEM' })).entries.map((e) => e.name)).toEqual([
      'item9',
      'item10',
    ])
    const bytes = (name: string) =>
      Buffer.byteLength(JSON.stringify({ name, path: join(home, name) })) + 1
    const partial = await listFolder(home, { maxBytes: bytes('.hidden') + bytes('alpha') })
    expect(partial.entries.map((e) => e.name)).toEqual(['.hidden', 'alpha'])
    expect(partial.omitted).toBe(4)
    expect((await listFolder(home)).omitted).toBe(0)
  })

  it('has no parent at a filesystem root', async () => {
    const root = parse(await tempDir()).root
    expect((await listFolder(root)).parentPath).toBeNull()
  })

  it('refuses a missing folder and a file', async () => {
    const home = await tree()
    await expect(listFolder(join(home, 'nope'))).rejects.toMatchObject({ code: 'not_found' })
    await expect(listFolder(join(home, 'notes.txt'))).rejects.toMatchObject({
      code: 'validation',
    })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'lists a folder it may not read as unreadable',
    async () => {
      const home = await tree()
      const locked = join(home, 'alpha')
      await chmod(locked, 0o000)
      try {
        expect(await listFolder(locked)).toMatchObject({ entries: [], readable: false })
      } finally {
        await chmod(locked, 0o755)
      }
    },
  )
})

describe('filesystem service', () => {
  it('starts in the home folder until a start folder is set', async () => {
    const home = await tree()
    const { filesystem } = await service(home)
    expect((await filesystem.browse(undefined)).path).toBe(home)
  })

  it('starts in the set folder, and falls back home once it is gone', async () => {
    const home = await tree()
    const { settings, filesystem } = await service(home)
    await mkdir(join(home, 'alpha', 'gone'))
    settings.set({ addProjectStartsIn: '~/alpha/gone' })
    expect((await filesystem.browse(undefined)).path).toBe(join(home, 'alpha', 'gone'))
    await rm(join(home, 'alpha', 'gone'), { recursive: true })
    expect((await filesystem.browse(undefined)).path).toBe(home)
  })

  it('answers browse errors as protocol errors', async () => {
    const home = await tree()
    const { filesystem } = await service(home)
    expect(
      await filesystem.dispatch(command('filesystem.browse', { path: join(home, 'nope') })),
    ).toMatchObject({ type: 'error', error: { code: 'not_found' } })
    expect(
      await filesystem.dispatch(command('filesystem.browse', { path: 'relative' })),
    ).toMatchObject({ type: 'error', error: { code: 'validation' } })
  })

  it('validates, trims and persists the start folder', async () => {
    const home = await tree()
    const { settings, filesystem } = await service(home)
    expect(
      await filesystem.dispatch(
        command('environment.settings.set', { settings: { addProjectStartsIn: '~/nope' } }),
      ),
    ).toMatchObject({ type: 'error', error: { code: 'validation' } })
    expect(settings.get()).toEqual({ addProjectStartsIn: '' })

    expect(
      await filesystem.dispatch(
        command('environment.settings.set', { settings: { addProjectStartsIn: ' ~/alpha ' } }),
      ),
    ).toMatchObject({ type: 'response', payload: { settings: { addProjectStartsIn: '~/alpha' } } })
    expect(await filesystem.dispatch(command('environment.settings.get', null))).toMatchObject({
      payload: { settings: { addProjectStartsIn: '~/alpha' } },
    })

    // Empty is always allowed: it means home.
    expect(
      await filesystem.dispatch(
        command('environment.settings.set', { settings: { addProjectStartsIn: '' } }),
      ),
    ).toMatchObject({ payload: { settings: { addProjectStartsIn: '' } } })
  })

  it('leaves commands it does not own to the next service', async () => {
    const { filesystem } = await service(await tempDir())
    expect(filesystem.dispatch(command('workspace.list', null))).toBeUndefined()
  })
})

describe('environment settings store', () => {
  it('keeps values across reopen and ignores unknown or unreadable rows', async () => {
    const dataDir = await tempDir('openmanager-settings-test-')
    const first = openEnvironmentSettings(dataDir)
    first.set({ addProjectStartsIn: '~/code' })
    first.close()
    const second = openEnvironmentSettings(dataDir)
    stores.push(second)
    expect(second.get()).toEqual({ addProjectStartsIn: '~/code' })
  })
})

describe('over the socket', () => {
  it('lets the owner browse and set, and keeps both from a read-only client', async () => {
    const host = await startStubHost(new FakeConnectionFactory())
    const owner = await connectProtocol(host)
    await handshake(owner)
    expect(
      await nextResponse(owner, owner.command('filesystem.browse', { path: host.workspaceRoot })),
    ).toMatchObject({ type: 'response', payload: { path: host.workspaceRoot, readable: true } })

    const watcher = host.server.clients.issue({
      label: 'Watcher',
      kind: 'paired',
      capabilities: ['read'],
    })
    const watcherClient = await connectProtocol({ ...host, token: watcher.credential })
    await handshake(watcherClient)
    for (const [name, payload] of [
      ['filesystem.browse', {}],
      ['environment.settings.set', { settings: { addProjectStartsIn: '' } }],
    ] as const) {
      expect(await nextResponse(watcherClient, watcherClient.command(name, payload))).toMatchObject(
        {
          type: 'error',
          error: { code: 'capability_missing', details: { requiredCapability: 'operate' } },
        },
      )
    }
    // Reading the settings is harmless, so `read` may.
    expect(
      await nextResponse(watcherClient, watcherClient.command('environment.settings.get', null)),
    ).toMatchObject({ type: 'response', payload: { settings: { addProjectStartsIn: '' } } })
  })
})
