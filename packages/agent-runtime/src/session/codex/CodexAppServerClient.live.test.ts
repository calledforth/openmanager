import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HostLogEntry } from '../../host.js'
import {
  CodexProcessExitedError,
  startCodexAppServer,
  type CodexAppServerClient,
} from './CodexAppServerClient.js'
import { resolveCodexExecutable } from './executable.js'

/** Against the real `codex` on this machine. Opt in with
 * `OPENMANAGER_LIVE_CODEX=1`; it needs a signed-in Codex but spends no tokens:
 * nothing here starts a turn. */
const live = process.env.OPENMANAGER_LIVE_CODEX === '1'

describe.skipIf(!live)('codex app-server, live', () => {
  async function start(logs: HostLogEntry[], cwd: string): Promise<CodexAppServerClient> {
    const resolution = resolveCodexExecutable()
    if (!resolution.found) throw new Error(`codex not found; searched ${resolution.searched.join(', ')}`)
    return startCodexAppServer(
      {
        executable: resolution.executable,
        cwd,
        env: process.env as Record<string, string>,
        spawnTimeoutMs: 15_000,
        clientVersion: '0.0.0-live-test',
        initializeTimeoutMs: 30_000,
      },
      { log: (entry) => logs.push(entry), terminateGraceMs: 2_000, requestTimeoutMs: 30_000 },
    )
  }

  it('handshakes, reads the account and models, and opens a thread', { timeout: 90_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openmanager-codex-live-'))
    const logs: HostLogEntry[] = []
    const client = await start(logs, cwd)
    try {
      const info = client.info!
      expect(info.userAgent).toMatch(/^OpenManager\//)
      expect(info.version.status).not.toBe('unsupported')

      const account = await client.request('account/read', { refreshToken: false })
      expect(account).toHaveProperty('requiresOpenaiAuth')

      const models = await client.request('model/list', {})
      expect(models.data.length).toBeGreaterThan(0)

      const started: string[] = []
      client.on('thread/started', (params) => started.push(params.thread.id))
      const thread = await client.request('thread/start', {
        cwd,
        ephemeral: true,
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
        config: { notify: [] },
      })
      expect(thread.thread.id).toBeTruthy()
      await expect.poll(() => started).toContain(thread.thread.id)
      expect(client.stats.decodeErrors).toBe(0)
    } finally {
      const exit = await client.terminate({ reason: 'disposed' })
      expect(exit.forced).toBe(false)
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('rejects a request in flight when the process is killed', { timeout: 60_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openmanager-codex-live-'))
    const client = await start([], cwd)
    try {
      // A request the server is still working on when the process dies.
      const inFlight = client.request('model/list', {})
      process.kill(client.pid!, 'SIGKILL')
      await expect(inFlight).rejects.toBeInstanceOf(CodexProcessExitedError)
      await expect(client.exited).resolves.toMatchObject({ signal: 'SIGKILL' })
      await expect(client.request('account/read', { refreshToken: false })).rejects.toBeInstanceOf(
        CodexProcessExitedError,
      )
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
