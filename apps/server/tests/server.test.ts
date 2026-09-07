import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BootstrapResponseSchema, PROTOCOL_VERSION } from '@openmanager/protocol/node'
import { startServer } from '../src/server.js'
import { createLogger } from '../src/logger.js'

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
      capabilities: [],
    }
    try {
      const response = await fetch(`${first.url}/bootstrap`)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(BootstrapResponseSchema.parse(await response.json())).toEqual({
        ...expected,
        websocketUrl: `ws://127.0.0.1:${first.port}/ws`,
      })
      const differentPort = await startServer(config)
      servers.push(differentPort)
      expect(differentPort.port).not.toBe(first.port)
      const routed = await fetch(`${differentPort.url}/bootstrap?route=changed`, {
        headers: {
          host: 'untrusted.example',
          'x-forwarded-host': 'new-tunnel.example',
          'x-forwarded-proto': 'https',
        },
      })
      expect(await routed.json()).toEqual({
        ...expected,
        websocketUrl: `ws://127.0.0.1:${differentPort.port}/ws`,
      })
    } finally {
      await first.close()
    }
    const restarted = await startServer(config)
    servers.push(restarted)
    expect(await (await fetch(`${restarted.url}/bootstrap`)).json()).toEqual({
      ...expected,
      websocketUrl: `ws://127.0.0.1:${restarted.port}/ws`,
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
      capabilities: [],
      websocketUrl: `ws://127.0.0.1:${server.port}/ws`,
    })
    expect(await (await fetch(`${server.url}/health?verbose=true`)).json()).toEqual({ status: 'ok' })
  })

  it.each([
    ['POST', '/health'],
    ['POST', '/bootstrap'],
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
})
