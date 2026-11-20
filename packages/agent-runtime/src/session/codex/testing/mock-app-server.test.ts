import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CodexProcessExitedError,
  CodexVersionUnsupportedError,
  startCodexAppServer,
  type CodexAppServerClient,
} from '../CodexAppServerClient.js'
import type { CodexExecutable } from '../executable.js'
import { codexMockAppServerPath, readCodexFixture, serializeCodexFixture, type CodexFixture } from './fixture.js'
import { createCodexMockExecutable } from './mock-executable.js'

/** The mock app-server as a real child process, spawned the way production
 * spawns Codex (`spawnCodexAppServer`), for what an in-process fake cannot
 * show: real pipes, a real exit code, a real signal. */

let dir: string
let executable: CodexExecutable
const clients: CodexAppServerClient[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-mock-'))
  executable = createCodexMockExecutable(dir)
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.terminate({ reason: 'disposed' }).catch(() => undefined)))
  rmSync(dir, { recursive: true, force: true })
})

function writeFixture(fixture: CodexFixture): string {
  const path = join(dir, 'fixture.jsonl')
  writeFileSync(path, serializeCodexFixture(fixture))
  return path
}

/** Passed as `-c` flags. The mock refuses to start unless they arrive exactly
 * like this, so a value with spaces and quotes checks the quoting through the
 * launcher (on Windows, `cmd.exe` and a `.cmd` shim). */
const CONFIG = ['features.request_permissions_tool=true', 'developer_instructions="say \\"hi\\" twice"']

async function start(env: Record<string, string>, options: { terminateGraceMs?: number } = {}) {
  const client = await startCodexAppServer(
    {
      executable,
      cwd: dir,
      env: {
        ...(process.env as Record<string, string>),
        CODEX_MOCK_EXPECT_ARGS: JSON.stringify([...CONFIG.flatMap((entry) => ['-c', entry]), 'app-server']),
        ...env,
      },
      config: CONFIG,
      spawnTimeoutMs: 10_000,
      clientVersion: '0.0.0-fixture',
      initializeTimeoutMs: 10_000,
    },
    { log: () => undefined, terminateGraceMs: options.terminateGraceMs ?? 2_000, requestTimeoutMs: 10_000 },
  )
  clients.push(client)
  return client
}

/** The recorded handshake from `simple-turn`, then `extra`. */
function handshakeThen(extra: CodexFixture['entries']): CodexFixture {
  const recorded = readCodexFixture('simple-turn')
  const handshake = recorded.entries.filter(
    (entry) =>
      'message' in entry &&
      (entry.message.method === 'initialize' ||
        entry.message.method === 'initialized' ||
        (entry.from === 'server' && entry.message.id === 1)),
  )
  return { header: recorded.header, entries: [...handshake, ...extra] }
}

describe('mock codex app-server process', () => {
  it('handshakes, answers a request, then crashes with a panic', { timeout: 20_000 }, async () => {
    const fixture = handshakeThen([
      { atMs: 1, from: 'client', message: { id: 2, method: 'model/list', params: {} } },
      { atMs: 2, from: 'server', message: { id: 2, result: { data: [], nextCursor: null } } },
      { atMs: 3, from: 'client', message: { id: 3, method: 'account/read', params: { refreshToken: false } } },
      { atMs: 4, from: 'server', stderr: "thread 'main' panicked at app-server/src/lib.rs:7:9:" },
      { atMs: 4, from: 'server', stderr: 'account store is corrupt' },
      { atMs: 5, from: 'server', exit: { code: 101, signal: null } },
    ])
    const client = await start({ CODEX_MOCK_FIXTURE: writeFixture(fixture) })
    expect(client.pid).toBeGreaterThan(0)
    expect(client.info?.version).toMatchObject({ version: '0.170.0', status: 'supported' })

    await expect(client.request('model/list', {})).resolves.toEqual({ data: [], nextCursor: null })

    const crashed = client.request('account/read', { refreshToken: false })
    await expect(crashed).rejects.toBeInstanceOf(CodexProcessExitedError)
    await expect(crashed).rejects.toThrow(
      "codex app-server exited (exit code 101): thread 'main' panicked at app-server/src/lib.rs:7:9: account store is corrupt",
    )
    await expect(client.exited).resolves.toMatchObject({ exitCode: 101, signal: null })
  })

  it('replays a recorded turn through real pipes', { timeout: 20_000 }, async () => {
    const path = join(dir, 'simple-turn.jsonl')
    writeFileSync(path, serializeCodexFixture(readCodexFixture('simple-turn')))
    const client = await start({ CODEX_MOCK_FIXTURE: path })
    const deltas: string[] = []
    client.on('item/agentMessage/delta', (params) => deltas.push(params.delta))
    const completed = new Promise<string>((resolve) => client.on('turn/completed', (p) => resolve(p.turn.status)))

    const { thread } = await client.request('thread/start', {
      cwd: '/workspace',
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: { notify: [] },
      model: 'gpt-6-luna',
    })
    await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'Reply with exactly the word: pong', text_elements: [] }],
      effort: 'low',
      summary: 'detailed',
      model: 'gpt-6-luna',
    })
    expect(await completed).toBe('completed')
    expect(deltas.join('')).toBe('pong')
    // The recorded bubblewrap warning reached stderr.
    expect(client.stderrTail).toContain('bubblewrap')

    await expect(client.terminate({ reason: 'disposed' })).resolves.toMatchObject({ forced: false })
  })

  it('refuses a codex too old to run, and stops it', { timeout: 20_000 }, async () => {
    await expect(start({ CODEX_MOCK_USER_AGENT: 'OpenManager/0.150.0 (Mock; x86_64)' })).rejects.toBeInstanceOf(
      CodexVersionUnsupportedError,
    )
  })

  it('refuses a command line that is not `[-c key=value]... app-server`', { timeout: 20_000 }, () => {
    for (const args of [[], ['app-server', 'extra'], ['-c', 'app-server'], ['-c', 'a=b', 'proto']]) {
      const result = spawnSync(process.execPath, [codexMockAppServerPath(), ...args], { encoding: 'utf8', input: '' })
      expect(result.status, JSON.stringify(args)).toBe(2)
      expect(result.stderr).toMatch(/^mock codex app-server: /)
    }
    const ok = spawnSync(process.execPath, [codexMockAppServerPath(), '-c', 'a=b c', 'app-server'], {
      encoding: 'utf8',
      input: '',
    })
    expect(ok.status).toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'is killed with SIGKILL when it ignores SIGTERM',
    { timeout: 20_000 },
    async () => {
      const client = await start({ CODEX_MOCK_IGNORE_SIGTERM: '1' }, { terminateGraceMs: 300 })
      await expect(client.terminate({ reason: 'disposed' })).resolves.toMatchObject({
        signal: 'SIGKILL',
        forced: true,
      })
    },
  )
})
