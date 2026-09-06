import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('configuration', () => {
  it('boots with defaults and no Convex or Electron configuration', () => {
    expect(loadConfig([], {})).toEqual({
      port: 43120,
      dataDir: join(homedir(), '.openmanager'),
      logLevel: 'info',
    })
  })

  it('uses flags before environment before defaults', () => {
    const env = {
      OPENMANAGER_PORT: '5000',
      OPENMANAGER_DATA_DIR: './env-data',
      OPENMANAGER_LOG_LEVEL: 'warn',
    }
    expect(loadConfig([], env)).toEqual({
      port: 5000,
      dataDir: resolve('env-data'),
      logLevel: 'warn',
    })
    expect(
      loadConfig(['--port=0', '--data-dir', './flag data', '--log-level', 'debug'], env),
    ).toEqual({ port: 0, dataDir: resolve('flag data'), logLevel: 'debug' })
  })

  it.each(['-1', '65536', '3.5', 'abc', '1e3', '', '9007199254740993'])(
    'rejects invalid port %j before binding',
    (port) => {
      expect(() => loadConfig([`--port=${port}`], {})).toThrow('Port must be')
    },
  )

  it('rejects invalid paths, log levels, unknown flags and positional arguments', () => {
    expect(() => loadConfig(['--data-dir= '], {})).toThrow('Data directory')
    expect(() => loadConfig([], { OPENMANAGER_DATA_DIR: '\0' })).toThrow('Data directory')
    expect(() => loadConfig(['--log-level=trace'], {})).toThrow('Log level')
    expect(() => loadConfig(['--prot=5000'], {})).toThrow()
    expect(() => loadConfig(['extra'], {})).toThrow()
  })
})
