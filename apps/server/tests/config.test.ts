import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('configuration', () => {
  it('boots with defaults and no Convex or Electron configuration', () => {
    expect(loadConfig([], {})).toEqual({
      port: 43120,
      dataDir: join(homedir(), '.openmanager'),
      logLevel: 'info',
      allowedOrigins: [],
      allowedHosts: [],
      workspaces: [],
      remintOwner: false,
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
      allowedHosts: [],
      workspaces: [],
      remintOwner: false,
    })
    expect(
      loadConfig(['--port=0', '--data-dir', './flag data', '--log-level', 'debug'], env),
    ).toEqual({
      port: 0,
      dataDir: resolve('flag data'),
      logLevel: 'debug',
      allowedOrigins: [],
      allowedHosts: [],
      workspaces: [],
      remintOwner: false,
    })
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

  it('uses exact allowed hosts, lowercased, with flag precedence', () => {
    const env = { OPENMANAGER_ALLOWED_HOSTS: 'Tunnel.example, proxy.example:8443' }
    expect(loadConfig([], env).allowedHosts).toEqual(['tunnel.example', 'proxy.example:8443'])
    expect(loadConfig(['--allowed-host=chosen.example'], env).allowedHosts).toEqual([
      'chosen.example',
    ])
    expect(
      loadConfig(['--allowed-host=chosen.example', '--allowed-host=CHOSEN.example'], {})
        .allowedHosts,
    ).toEqual(['chosen.example'])
  })

  it.each([
    '*',
    'http://tunnel.example',
    'tunnel.example/',
    'tunnel.example/path',
    'user@tunnel.example',
    'tunnel.example:abc',
    ' ',
  ])('rejects unsafe host %j', (host) => {
    expect(() => loadConfig([`--allowed-host=${host}`], {})).toThrow('Allowed hosts')
  })

  it('resolves workspace roots from flags before the delimited environment list', () => {
    const env = { OPENMANAGER_WORKSPACES: ['./one', './two', './one'].join(delimiter) }
    expect(loadConfig([], env).workspaces).toEqual([resolve('one'), resolve('two')])
    expect(loadConfig(['--workspace', './three'], env).workspaces).toEqual([resolve('three')])
    expect(() => loadConfig(['--workspace', ' '], {})).toThrow('Workspace roots')
    expect(() => loadConfig([], { OPENMANAGER_WORKSPACES: 'a\0b' })).toThrow('Workspace roots')
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

  it('treats remint as an explicit flag with no environment-variable fallback', () => {
    expect(loadConfig(['--remint-owner'], {}).remintOwner).toBe(true)
    expect(loadConfig([], { OPENMANAGER_REMINT_OWNER: '1' }).remintOwner).toBe(false)
  })
})
