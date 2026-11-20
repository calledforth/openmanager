import { describe, expect, it } from 'vitest'
import { type CodexExecutableDeps, resolveCodexExecutable } from './executable.js'

/** A fake filesystem: the files that exist, what some of them contain, and the
 * entries of some directories. Paths are compared as written, so a Windows
 * test spells them the way the resolver builds them with `path.win32`. */
function fakeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}, links: Record<string, string> = {}) {
  return {
    exists: (path: string) => path in files,
    readFile: (path: string) => files[path],
    listDir: (path: string) => dirs[path] ?? [],
    realpath: (path: string) => links[path] ?? path,
  } satisfies Partial<CodexExecutableDeps>
}

const linux = { platform: 'linux', arch: 'x64', homedir: '/home/me' } as const
const windows = { platform: 'win32', arch: 'x64', homedir: 'C:\\Users\\me' } as const

const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n')

describe('resolveCodexExecutable', () => {
  it('lets CODEX_BIN win over PATH and the standalone install', () => {
    const result = resolveCodexExecutable({
      ...linux,
      env: { CODEX_BIN: '  /opt/codex/bin/codex  ', PATH: '/usr/bin' },
      ...fakeFs({
        '/opt/codex/bin/codex': '',
        '/usr/bin/codex': '',
        '/home/me/.codex/packages/standalone/current/bin/codex': '',
      }),
    })
    expect(result).toEqual({
      found: true,
      executable: { command: '/opt/codex/bin/codex', source: 'env', needsShell: false },
    })
  })

  it('looks a bare CODEX_BIN up on PATH', () => {
    const result = resolveCodexExecutable({
      ...linux,
      env: { CODEX_BIN: 'codex-nightly', PATH: '/a:/b' },
      ...fakeFs({ '/b/codex-nightly': '', '/a/codex': '' }),
    })
    expect(result).toEqual({
      found: true,
      executable: { command: '/b/codex-nightly', source: 'env', needsShell: false },
    })
  })

  it('reports a CODEX_BIN that names nothing, instead of running another codex', () => {
    const result = resolveCodexExecutable({
      ...linux,
      env: { CODEX_BIN: '/nope/codex', PATH: '/usr/bin' },
      ...fakeFs({ '/usr/bin/codex': '' }),
    })
    expect(result).toEqual({ found: false, searched: ['/nope/codex'], envOverride: '/nope/codex' })
  })

  it('ignores a blank CODEX_BIN', () => {
    const result = resolveCodexExecutable({
      ...linux,
      env: { CODEX_BIN: '   ', PATH: '/usr/local/bin:/usr/bin' },
      ...fakeFs({ '/usr/bin/codex': '' }),
    })
    expect(result).toEqual({
      found: true,
      executable: { command: '/usr/bin/codex', source: 'path', needsShell: false },
    })
  })

  it('takes the first codex on a POSIX PATH', () => {
    const result = resolveCodexExecutable({
      ...linux,
      env: { PATH: ':/home/me/.local/bin:/usr/bin' },
      ...fakeFs({ '/home/me/.local/bin/codex': '', '/usr/bin/codex': '' }),
    })
    expect(result).toEqual({
      found: true,
      executable: { command: '/home/me/.local/bin/codex', source: 'path', needsShell: false },
    })
  })

  it('resolves an npm codex.cmd on the Windows PATH to the native codex.exe it wraps', () => {
    const npm = 'C:\\nvm4w\\nodejs'
    const native = `${npm}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
    const result = resolveCodexExecutable({
      ...windows,
      // Windows spells it `Path`, and the extensionless sh shim next to the
      // .cmd must not be picked.
      env: { Path: `C:\\Windows\\System32;"${npm}"`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      ...fakeFs({
        [`${npm}\\codex`]: '#!/bin/sh',
        [`${npm}\\codex.cmd`]: NPM_SHIM,
        [native]: '',
      }),
    })
    expect(result).toEqual({
      found: true,
      executable: { command: native, source: 'path', needsShell: false },
    })
  })

  it('finds the native exe next to a pnpm-linked package', () => {
    const bin = 'C:\\Users\\me\\AppData\\Local\\pnpm'
    const linked = `${bin}\\global\\5\\node_modules\\@openai\\codex`
    const store = `${bin}\\global\\5\\node_modules\\.pnpm\\@openai+codex@0.170.0\\node_modules\\@openai\\codex`
    const native = `${bin}\\global\\5\\node_modules\\.pnpm\\@openai+codex@0.170.0\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
    const shim = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n)'
    const result = resolveCodexExecutable({
      ...windows,
      env: { PATH: bin },
      ...fakeFs({ [`${bin}\\codex.cmd`]: shim, [native]: '' }, {}, { [linked]: store }),
    })
    expect(result).toEqual({
      found: true,
      executable: { command: native, source: 'path', needsShell: false },
    })
  })

  it('falls back to the .cmd shim, through a shell, when its native exe is missing', () => {
    const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm'
    const result = resolveCodexExecutable({
      ...windows,
      env: { PATH: npm },
      ...fakeFs({ [`${npm}\\codex.cmd`]: NPM_SHIM }),
    })
    expect(result).toEqual({
      found: true,
      executable: { command: `${npm}\\codex.cmd`, source: 'path', needsShell: true },
    })
  })

  it('prefers a codex.exe on the Windows PATH over a later shim', () => {
    const result = resolveCodexExecutable({
      ...windows,
      env: { PATH: 'C:\\tools;C:\\npm' },
      ...fakeFs({ 'C:\\tools\\codex.exe': '', 'C:\\npm\\codex.cmd': NPM_SHIM }),
    })
    expect(result).toEqual({
      found: true,
      executable: { command: 'C:\\tools\\codex.exe', source: 'path', needsShell: false },
    })
  })

  it('uses the standalone install through its current link', () => {
    const result = resolveCodexExecutable({
      ...linux,
      env: { PATH: '/usr/bin' },
      ...fakeFs(
        {
          '/home/me/.codex/packages/standalone/current/bin/codex': '',
          '/home/me/.codex/packages/standalone/releases/0.180.0-x86_64-unknown-linux-musl/bin/codex': '',
        },
        { '/home/me/.codex/packages/standalone/releases': ['0.180.0-x86_64-unknown-linux-musl'] },
      ),
    })
    expect(result).toEqual({
      found: true,
      executable: {
        command: '/home/me/.codex/packages/standalone/current/bin/codex',
        source: 'standalone',
        needsShell: false,
      },
    })
  })

  it('respects CODEX_HOME and finds the Windows standalone codex.exe', () => {
    const result = resolveCodexExecutable({
      ...windows,
      env: { PATH: '', CODEX_HOME: 'D:\\codex-home' },
      ...fakeFs({ 'D:\\codex-home\\packages\\standalone\\current\\bin\\codex.exe': '' }),
    })
    expect(result).toEqual({
      found: true,
      executable: {
        command: 'D:\\codex-home\\packages\\standalone\\current\\bin\\codex.exe',
        source: 'standalone',
        needsShell: false,
      },
    })
  })

  it('falls back to the newest standalone release when current is missing', () => {
    const releases = '/home/me/.codex/packages/standalone/releases'
    const result = resolveCodexExecutable({
      ...linux,
      env: {},
      ...fakeFs(
        {
          [`${releases}/0.9.0-x86_64-unknown-linux-musl/bin/codex`]: '',
          [`${releases}/0.165.0-x86_64-unknown-linux-musl/bin/codex`]: '',
          [`${releases}/0.170.0-alpha.1-x86_64-unknown-linux-musl/bin/codex`]: '',
          [`${releases}/0.170.0-x86_64-unknown-linux-musl/bin/codex`]: '',
        },
        {
          [releases]: [
            '0.9.0-x86_64-unknown-linux-musl',
            '0.170.0-alpha.1-x86_64-unknown-linux-musl',
            '0.170.0-x86_64-unknown-linux-musl',
            '0.165.0-x86_64-unknown-linux-musl',
            // Newest, but half-installed: no binary yet.
            '0.171.0-x86_64-unknown-linux-musl',
            'not-a-release',
          ],
        },
      ),
    })
    expect(result).toEqual({
      found: true,
      executable: {
        command: `${releases}/0.170.0-x86_64-unknown-linux-musl/bin/codex`,
        source: 'standalone',
        needsShell: false,
      },
    })
  })

  it('says what it searched when codex is nowhere', () => {
    const result = resolveCodexExecutable({
      ...windows,
      env: { PATH: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      ...fakeFs({}),
    })
    expect(result).toEqual({
      found: false,
      searched: [
        'PATH',
        'C:\\Users\\me\\.codex\\packages\\standalone\\current\\bin\\codex.exe',
        'C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe',
        'C:\\Users\\me\\.codex\\packages\\standalone\\releases',
      ],
    })
  })
})
