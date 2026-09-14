import { once } from 'node:events'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_FILENAME } from '../src/db/database.js'
import {
  BootstrapResponseSchema,
  COMPOSER_PREFERENCES_GET_CAPABILITY,
  COMPOSER_PREFERENCES_SET_CAPABILITY,
  PROTOCOL_VERSION,
} from '@openmanager/protocol/node'
import type { AuditEvent } from '../src/audit.js'
import { startServer } from '../src/server.js'
import { createLogger } from '../src/logger.js'
import { SERVER_CAPABILITIES } from '../src/server.js'

/** fetch strips a caller-supplied Host header, so host policy tests go through node:http. */
async function get(port: number, path: string, headers: Record<string, string>) {
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port, path, headers }, resolve).on('error', reject).end()
  })
  let body = ''
  for await (const chunk of response) body += String(chunk)
  return { status: response.statusCode, headers: response.headers, body }
}

/** One raw HTTP/1.0 request, which can omit the Host header entirely. */
async function rawRequest(port: number, head: string) {
  const socket = createConnection({ host: '127.0.0.1', port })
  await once(socket, 'connect')
  socket.end(head)
  let response = ''
  for await (const chunk of socket) response += String(chunk)
  return response
}

const directories: string[] = []
const servers: Awaited<ReturnType<typeof startServer>>[] = []
async function dataDir() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-server-test-'))
  directories.push(directory)
  return join(directory, 'data')
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('headless listener', () => {
  it('creates the data directory, binds loopback, and serves public liveness', async () => {
    const directory = await dataDir()
    const server = await startServer({ port: 0, dataDir: directory, logLevel: 'info' })
    servers.push(server)
    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
    expect((await stat(directory)).isDirectory()).toBe(true)
    const response = await fetch(`${server.url}/health`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('returns the same persisted identity after restart, port and route changes', async () => {
    const directory = await dataDir()
    const config = { port: 0, dataDir: directory, logLevel: 'info' as const }
    const first = await startServer(config)
    const expected = {
      environmentId: first.identity.environmentId,
      label: first.identity.label,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: SERVER_CAPABILITIES,
    }
    try {
      const response = await fetch(`${first.url}/bootstrap`)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
      const firstBootstrap = BootstrapResponseSchema.parse(await response.json())
      expect(firstBootstrap).toMatchObject({
        ...expected,
        websocketUrl: `ws://127.0.0.1:${first.port}/ws`,
      })
      expect(firstBootstrap.providers?.map((provider) => provider.id)).toEqual([
        'cursor',
        'opencode',
        'claude',
      ])
      expect(firstBootstrap.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'cursor',
            displayName: 'Cursor',
            health: expect.objectContaining({ summary: 'unknown', refreshing: false }),
          }),
        ]),
      )
      const differentPort = await startServer(config)
      servers.push(differentPort)
      expect(differentPort.port).not.toBe(first.port)
      // Forwarded headers never change the advertised route or vouch for a host.
      const routed = await get(differentPort.port, '/bootstrap?route=changed', {
        host: `localhost:${differentPort.port}`,
        'x-forwarded-host': 'new-tunnel.example',
        'x-forwarded-proto': 'https',
        forwarded: 'host=new-tunnel.example;proto=https',
      })
      expect(routed.status).toBe(200)
      expect(JSON.parse(routed.body)).toEqual({
        ...expected,
        providers: firstBootstrap.providers,
        websocketUrl: `ws://127.0.0.1:${differentPort.port}/ws`,
      })
    } finally {
      await first.close()
    }
    const restarted = await startServer(config)
    servers.push(restarted)
    expect(await (await fetch(`${restarted.url}/bootstrap`)).json()).toEqual({
      ...expected,
      providers: expect.any(Array),
      websocketUrl: `ws://127.0.0.1:${restarted.port}/ws`,
    })
  })

  it('returns composer preferences after a full server restart', async () => {
    const directory = await dataDir()
    const config = { port: 0, dataDir: directory, logLevel: 'silent' as const }
    const first = await startServer(config)
    expect(
      first.composerService.dispatch({
        type: 'command',
        requestId: 'set-1',
        name: COMPOSER_PREFERENCES_SET_CAPABILITY,
        payload: {
          workspaceId: 'workspace-1',
          providerId: 'cursor',
          preference: { modelId: 'opus', configValues: { effort: 'high' } },
        },
      }),
    ).toMatchObject({ type: 'response' })
    await first.close()

    const restarted = await startServer(config)
    servers.push(restarted)
    expect(
      restarted.composerService.dispatch({
        type: 'command',
        requestId: 'get-1',
        name: COMPOSER_PREFERENCES_GET_CAPABILITY,
        payload: { workspaceId: 'workspace-1', providerId: 'cursor' },
      }),
    ).toMatchObject({
      payload: { preference: { modelId: 'opus', configValues: { effort: 'high' } } },
    })
  })

  it('keeps local files and credentials out of public discovery responses', async () => {
    const directory = await dataDir()
    const server = await startServer({ port: 0, dataDir: directory, logLevel: 'debug' })
    servers.push(server)
    await writeFile(join(directory, 'sessions.json'), '{"privateSession":"test-session"}')
    await writeFile(join(directory, 'token'), 'test-credential')
    const response = await fetch(`${server.url}/bootstrap?token=test-credential`)
    expect(await response.json()).toEqual({
      environmentId: server.identity.environmentId,
      label: server.identity.label,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: SERVER_CAPABILITIES,
      providers: expect.any(Array),
      websocketUrl: `ws://127.0.0.1:${server.port}/ws`,
    })
    expect(await (await fetch(`${server.url}/health?verbose=true`)).json()).toEqual({
      status: 'ok',
    })
  })

  it('refuses any Host other than the bound loopback address or an allowed host', async () => {
    const directory = await dataDir()
    const server = await startServer({
      port: 0,
      dataDir: directory,
      logLevel: 'silent',
      allowedHosts: ['tunnel.example', 'proxy.example:8443'],
    })
    servers.push(server)
    const audits: AuditEvent[] = []
    server.audit.subscribe((event) => audits.push(event))
    for (const host of [
      'attacker.example',
      `attacker.example:${server.port}`,
      `127.0.0.1:${server.port + 1}`,
      'localhost',
      'tunnel.example:8443',
      'proxy.example',
    ]) {
      const response = await get(server.port, '/health', { host })
      expect(response.status, host).toBe(403)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(JSON.parse(response.body)).toEqual({
        type: 'error',
        requestId: null,
        error: { code: 'auth', message: 'Host is not allowed.' },
      })
    }
    // HTTP/1.0 lets a client omit Host altogether; that is refused too.
    expect(await rawRequest(server.port, 'GET /health HTTP/1.0\r\n\r\n')).toMatch(
      /^HTTP\/1\.1 403 [\s\S]*Host is not allowed/,
    )
    expect(audits).toHaveLength(7)
    expect(audits[0]).toMatchObject({
      type: 'host.rejected',
      remoteAddress: '127.0.0.1',
      details: { host: 'attacker.example', url: '/health' },
    })
    expect(audits[6]).toMatchObject({ type: 'host.rejected', details: { host: null } })
    for (const host of [
      `127.0.0.1:${server.port}`,
      `localhost:${server.port}`,
      `LOCALHOST:${server.port}`,
      'tunnel.example',
      'Tunnel.Example',
      'proxy.example:8443',
    ]) {
      const response = await get(server.port, '/health', { host })
      expect(response.status, host).toBe(200)
    }
    // The Host check runs before the Origin check, so a rebinding page that
    // also carries an allowed Origin still fails on its hostname.
    const rebinding = await get(server.port, '/bootstrap', {
      host: 'attacker.example',
      origin: 'http://localhost:5173',
    })
    expect(rebinding.status).toBe(403)
    expect(audits.at(-1)).toMatchObject({ type: 'host.rejected' })
  })

  it('fails startup when a configured workspace root does not exist', async () => {
    const directory = await dataDir()
    await expect(
      startServer({
        port: 0,
        dataDir: directory,
        logLevel: 'silent',
        workspaces: [join(directory, 'missing-root')],
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    // The failed start released the database: a second start on the same directory works.
    servers.push(await startServer({ port: 0, dataDir: directory, logLevel: 'silent' }))
  })

  it.each([
    ['POST', '/health'],
    ['POST', '/bootstrap'],
    ['POST', '/local-owner'],
    ['GET', '/health/extra'],
    ['GET', '/bootstrap/extra'],
    ['GET', '/identity.json'],
  ])('does not expose other methods or paths: %s %s', async (method, path) => {
    const server = await startServer({ port: 0, dataDir: await dataDir(), logLevel: 'info' })
    servers.push(server)
    const response = await fetch(`${server.url}${path}`, { method })
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not found\n')
  })

  it('fails startup on corrupt identity without replacing it or opening a listener', async () => {
    const directory = await dataDir()
    const first = await startServer({ port: 0, dataDir: directory, logLevel: 'info' })
    const port = first.port
    await first.close()
    await writeFile(join(directory, 'identity.json'), 'corrupt')
    await expect(startServer({ port, dataDir: directory, logLevel: 'info' })).rejects.toThrow(
      'identity is invalid',
    )
    // A healthy environment can immediately bind the failed startup's requested port.
    servers.push(await startServer({ port, dataDir: await dataDir(), logLevel: 'info' }))
  })

  it('fails startup on an unknown newer schema without opening a listener', async () => {
    const directory = await dataDir()
    const first = await startServer({ port: 0, dataDir: directory, logLevel: 'info' })
    const port = first.port
    await first.close()
    const database = new DatabaseSync(join(directory, DATABASE_FILENAME))
    database.exec('UPDATE schema_version SET version = 99; PRAGMA user_version = 99')
    database.close()
    await expect(startServer({ port, dataDir: directory, logLevel: 'info' })).rejects.toThrow(
      'newer than this server supports',
    )
    servers.push(await startServer({ port, dataDir: await dataDir(), logLevel: 'info' }))
  })

  it('reports occupied ports rather than silently selecting a different one', async () => {
    const directory = await dataDir()
    const server = await startServer({ port: 0, dataDir: directory, logLevel: 'info' })
    servers.push(server)
    await expect(
      startServer({ port: server.port, dataDir: directory, logLevel: 'info' }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('fails when the configured data directory is a file', async () => {
    const directory = await dataDir()
    await writeFile(directory, 'existing data')
    await expect(startServer({ port: 0, dataDir: directory, logLevel: 'info' })).rejects.toThrow()
  })
})

it('filters structured logs by severity and supports silent logging', () => {
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
  const log = createLogger('warn')
  log('info', 'hidden')
  log('warn', 'visible')
  createLogger('silent')('error', 'hidden too')
  expect(stdout).not.toHaveBeenCalled()
  expect(stderr).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ level: 'warn', message: 'visible' }),
  )
  log('error', 'audit', { audit: { type: 'host.rejected' } })
  expect(stderr).toHaveBeenLastCalledWith(
    JSON.stringify({ level: 'error', message: 'audit', audit: { type: 'host.rejected' } }),
  )
})
