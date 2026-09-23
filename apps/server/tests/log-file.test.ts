import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createLogger, LOG_ROTATE_BYTES, openLogFile } from '../src/logger.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'openmanager-log-file-'))
  directories.push(dir)
  return dir
}

describe('log file configuration', () => {
  it('accepts a log file from the flag before the environment and resolves it', () => {
    expect(loadConfig([], {}).logFile).toBeUndefined()
    expect(loadConfig([], { OPENMANAGER_LOG_FILE: './logs/env.log' }).logFile).toBe(
      resolve('logs/env.log'),
    )
    expect(
      loadConfig(['--log-file', './flag.log'], { OPENMANAGER_LOG_FILE: './env.log' }).logFile,
    ).toBe(resolve('flag.log'))
    expect(() => loadConfig(['--log-file= '], {})).toThrow('Log file')
    expect(() => loadConfig([], { OPENMANAGER_LOG_FILE: 'a\0b' })).toThrow('Log file')
  })

  it('treats exit-with-parent as an explicit flag with no environment fallback', () => {
    expect(loadConfig([], {}).exitWithParent).toBeUndefined()
    expect(loadConfig(['--exit-with-parent'], {}).exitWithParent).toBe(true)
    expect(loadConfig([], { OPENMANAGER_EXIT_WITH_PARENT: '1' }).exitWithParent).toBeUndefined()
  })
})

describe('log file sink', () => {
  it('creates the directory, appends JSON lines at or above the level, and redacts secrets', async () => {
    const file = join(await scratch(), 'nested', 'server.log')
    const log = createLogger('info', openLogFile(file))
    log('debug', 'hidden')
    log('info', 'started', { url: 'http://127.0.0.1:1' })
    log('error', 'failed', { credential: 'omc1.' + 'a'.repeat(43) })
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual({
      level: 'info',
      message: 'started',
      url: 'http://127.0.0.1:1',
    })
    expect(lines[1]).toContain('"level":"error"')
    expect(lines[1]).not.toContain('a'.repeat(43))
  })

  it('shares one descriptor per path and rotates an oversized file on open', async () => {
    const dir = await scratch()
    const file = join(dir, 'server.log')
    await writeFile(file, 'x'.repeat(LOG_ROTATE_BYTES))
    const sink = openLogFile(file)
    expect(openLogFile(file)).toBe(sink)
    sink('fresh', 'stdout')
    expect((await stat(`${file}.1`)).size).toBe(LOG_ROTATE_BYTES)
    expect(await readFile(file, 'utf8')).toBe('fresh\n')
  })
})
