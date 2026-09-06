import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  it('creates the data directory, binds loopback, and exposes no product routes', async () => {
    const directory = await dataDir()
    const server = await startServer({ port: 0, dataDir: directory, logLevel: 'info' })
    servers.push(server)
    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
    expect((await stat(directory)).isDirectory()).toBe(true)
    const response = await fetch(`${server.url}/health`)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not found\n')
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
