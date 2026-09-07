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
      allowedOrigins: [],
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
      allowedOrigins: [],
    })
    expect(
      loadConfig(['--port=0', '--data-dir', './flag data', '--log-level', 'debug'], env),
    ).toEqual({ port: 0, dataDir: resolve('flag data'), logLevel: 'debug', allowedOrigins: [] })
  })

  it('uses exact allowed origins with flag precedence and no implicit browser trust', () => {
    const env = { OPENMANAGER_ALLOWED_ORIGINS: 'https://app.example,http://localhost:5173' }
    expect(loadConfig([], env).allowedOrigins).toEqual([
      'https://app.example',
      'http://localhost:5173',
    ])
    expect(loadConfig(['--allowed-origin=https://chosen.example'], env).allowedOrigins).toEqual([
      'https://chosen.example',
    ])
    expect(
      loadConfig(
        ['--allowed-origin=https://chosen.example', '--allowed-origin=https://chosen.example'],
        {},
      ).allowedOrigins,
    ).toEqual(['https://chosen.example'])
  })

  it.each([
    '*',
    'null',
    'file://',
    'https://app.example/',
    'https://user:secret@app.example',
    'https://app.example/path',
    'https://app.example?query=1',
  ])('rejects unsafe origin %s', (origin) => {
    expect(() => loadConfig([`--allowed-origin=${origin}`], {})).toThrow('Allowed origins')
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
