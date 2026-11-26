import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ServerUpdateStatusSchema } from '@openmanager/protocol/node'
import { createAuditLog } from '../src/audit.js'
import { createRateLimiter } from '../src/rate-limit.js'
import {
  createServerUpdateService,
  type LaunchUpdater,
  type ServerUpdateOptions,
} from '../src/server-update.js'
import { UPDATE_STATUS_FILE, type UpdateRecord } from '../src/standalone/update-record.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const silent = () => undefined

function setup(overrides: Partial<ServerUpdateOptions> & { newest?: string } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'om-server-update-'))
  const dataDir = join(temp, 'data')
  mkdirSync(dataDir)
  const execPath =
    process.platform === 'win32'
      ? join(temp, 'OpenManager', 'versions', '0.21.0', 'openmanager.exe')
      : join(temp, 'openmanager', 'versions', '0.21.0', 'openmanager')
  const launches: Parameters<LaunchUpdater>[0][] = []
  let githubCalls = 0
  const options: ServerUpdateOptions = {
    dataDir,
    version: '0.21.0',
    execPath,
    standalone: true,
    platform: 'linux',
    arch: 'x64',
    env: {},
    fetch: (async () => {
      githubCalls++
      return Response.json([
        { tag_name: 'v0.9.0', draft: false, prerelease: false },
        { tag_name: `server-v${overrides.newest ?? '0.22.0'}`, draft: false, prerelease: false },
      ])
    }) as typeof fetch,
    launch: async (launch) => {
      launches.push(launch)
    },
    autoCheck: false,
    authenticate: (credential) =>
      credential === 'admin-token'
        ? { clientId: 'owner', capabilities: ['read', 'operate', 'admin'] }
        : credential === 'reader-token'
          ? { clientId: 'phone', capabilities: ['read'] }
          : undefined,
    audit: createAuditLog(silent, { dataDir }),
    rateLimiter: createRateLimiter(),
    budgetKey: () => 'test',
    log: silent,
    ...overrides,
  }
  const service = createServerUpdateService(options)
  cleanups.push(() => {
    service.close()
    rmSync(temp, { recursive: true, force: true })
  })
  const writeRecord = (record: UpdateRecord) =>
    writeFileSync(join(dataDir, UPDATE_STATUS_FILE), JSON.stringify(record))
  return { service, launches, dataDir, writeRecord, githubCalls: () => githubCalls }
}

async function listen(service: ReturnType<typeof setup>['service']) {
  const server: Server = createServer((request, response) => {
    if (!service.handle(request, response)) {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/server-update`
  return (init: RequestInit & { token?: string; query?: string } = {}) =>
    fetch(`${base}${init.query ?? ''}`, {
      ...init,
      headers: init.token ? { authorization: `Bearer ${init.token}` } : {},
    })
}

describe('server update status', () => {
  it('says a newer release is out once GitHub has been asked', async () => {
    const { service } = setup()
    expect(await service.status()).toMatchObject({
      currentVersion: '0.21.0',
      latestVersion: null,
      updateAvailable: false,
      canUpdate: true,
      state: 'idle',
    })
    await service.check()
    const status = await service.status()
    expect(ServerUpdateStatusSchema.parse(status)).toMatchObject({
      latestVersion: '0.22.0',
      updateAvailable: true,
      releaseUrl: 'https://github.com/calledforth/openmanager/releases/tag/server-v0.22.0',
    })
    expect(status.checkedAt).toEqual(expect.any(String))
  })

  it('names why a checkout or a moved copy cannot update itself', async () => {
    expect(await setup({ standalone: false }).service.status()).toMatchObject({
      canUpdate: false,
      cannotUpdateReason: expect.stringContaining('source checkout'),
    })
    expect(await setup({ execPath: '/usr/local/bin/openmanager' }).service.status()).toMatchObject({
      canUpdate: false,
      cannotUpdateReason: expect.stringContaining('install script'),
    })
    expect(await setup({ platform: 'darwin', arch: 'arm64' }).service.status()).toMatchObject({
      canUpdate: false,
    })
  })

  it('starts the updater with a status file and reports it as updating', async () => {
    const { service, launches, dataDir } = setup()
    const started = await service.start()
    expect(started).toMatchObject({ state: 'updating', targetVersion: '0.22.0' })
    expect(launches).toHaveLength(1)
    expect(launches[0]!.args).toEqual([
      'update',
      '--status-file',
      join(dataDir, UPDATE_STATUS_FILE),
      '0.22.0',
    ])
    await expect(service.start()).rejects.toThrow('already running')
  })

  it('refuses to update to what already runs', async () => {
    const { service, launches } = setup({ newest: '0.21.0' })
    await expect(service.start()).rejects.toThrow('already the newest')
    expect(launches).toEqual([])
  })

  it('reads the updater record: running, crashed, failed, finished', async () => {
    const { service, writeRecord } = setup()
    const base = { pid: process.pid, fromVersion: '0.21.0', targetVersion: '0.22.0', log: [] }
    writeRecord({ ...base, state: 'updating', startedAt: Date.now() })
    expect(await service.status()).toMatchObject({ state: 'updating', targetVersion: '0.22.0' })

    writeRecord({ ...base, pid: 2 ** 22 + 12345, state: 'updating', startedAt: Date.now() })
    expect(await service.status()).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('stopped before it finished'),
    })

    writeRecord({
      ...base,
      state: 'failed',
      startedAt: 1,
      finishedAt: 2,
      error: 'Checksum mismatch',
    })
    expect(await service.status()).toMatchObject({ state: 'failed', error: 'Checksum mismatch' })

    // Installed, but this server (started by hand) is still the old one.
    writeRecord({ ...base, state: 'succeeded', startedAt: 1, finishedAt: 2 })
    expect(await service.status()).toMatchObject({ state: 'restart_required' })
  })

  it('the new server says which version it replaced', async () => {
    const { service, writeRecord } = setup({ version: '0.22.0' })
    writeRecord({
      pid: 1,
      fromVersion: '0.21.0',
      targetVersion: '0.22.0',
      state: 'succeeded',
      startedAt: 1,
      finishedAt: 2,
      log: [],
    })
    expect(await service.status()).toMatchObject({ state: 'idle', updatedFrom: '0.21.0' })
  })
})

describe('GET and POST /server-update', () => {
  it('needs a credential, and admin to update', async () => {
    const { service, launches } = setup()
    const request = await listen(service)
    expect((await request()).status).toBe(401)
    const read = await request({ token: 'reader-token' })
    expect(read.status).toBe(200)
    expect(ServerUpdateStatusSchema.parse(await read.json()).currentVersion).toBe('0.21.0')
    const denied = await request({ method: 'POST', token: 'reader-token' })
    expect(denied.status).toBe(403)
    expect(launches).toEqual([])
    const started = await request({ method: 'POST', token: 'admin-token' })
    expect(started.status).toBe(202)
    expect(await started.json()).toMatchObject({ state: 'updating', targetVersion: '0.22.0' })
    expect(launches).toHaveLength(1)
  })

  it('checks GitHub on ?check=1, at most every ten seconds', async () => {
    const context = setup()
    const request = await listen(context.service)
    const first = await (await request({ token: 'reader-token', query: '?check=1' })).json()
    expect(first).toMatchObject({ latestVersion: '0.22.0', updateAvailable: true })
    await request({ token: 'reader-token', query: '?check=1' })
    expect(context.githubCalls()).toBe(1)
  })

  it('refuses a malformed version and a server that cannot update', async () => {
    const request = await listen(setup().service)
    const bad = await request({
      method: 'POST',
      token: 'admin-token',
      body: JSON.stringify({ version: 'latest; rm -rf /' }),
    })
    expect(bad.status).toBe(400)
    const checkout = await listen(setup({ standalone: false }).service)
    const refused = await checkout({ method: 'POST', token: 'admin-token' })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
      'source checkout',
    )
  })
})
