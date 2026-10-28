import { spawn, type ChildProcess } from 'node:child_process'
import { nextServerText } from './helpers/frames.ts'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BootstrapResponseSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
} from '@openmanager/protocol/node'
import { DATABASE_FILENAME } from '../src/db/database.js'

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const directories: string[] = []
const children: ChildProcess[] = []
const clients: WebSocket[] = []

async function launch(dataDir: string) {
  // A developer's own server may have handed this shell its workspaces, and a
  // server with a workspace probes its providers, which is not under test.
  const env = { ...process.env }
  delete env.OPENMANAGER_WORKSPACES
  const child = spawn(process.execPath, [entry, '--port=0', '--data-dir', dataDir], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.push(child)
  const exited = once(child, 'exit')
  let output = ''
  let errors = ''
  child.stderr!.on('data', (chunk) => {
    errors += String(chunk)
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
      const [chunk] = await once(child.stdout!, 'data', { signal: controller.signal })
      output += String(chunk)
    }
  } finally {
    clearTimeout(timeout)
  }
  return {
    child,
    exited,
    errors: () => errors,
    url: output.match(/http:\/\/127\.0\.0\.1:\d+/)![0],
  }
}

async function stop(serverProcess: Awaited<ReturnType<typeof launch>>) {
  expect(serverProcess.child.kill('SIGTERM')).toBe(true)
  const exit = await serverProcess.exited
  if (process.platform === 'win32') expect(exit).toEqual([null, 'SIGTERM'])
  else expect(exit).toEqual([0, null])
  expect(serverProcess.errors()).toBe('')
  children.splice(children.indexOf(serverProcess.child), 1)
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
  }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('process lifecycle', () => {
  it('automatically relaunches a crashed server with the same identity, credential and SQLite', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-supervisor-test-'))
    directories.push(dataDir)
    // Exercise the actual Windows launcher without registering an OS task.
    const env = { ...process.env }
    delete env.OPENMANAGER_WORKSPACES
    const supervisor = spawn(
      process.execPath,
      [entry, '--supervise', '--exit-with-parent', '--port=0', '--data-dir', dataDir],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      },
    )
    children.push(supervisor)
    let output = ''
    let errors = ''
    supervisor.stdout!.on('data', (chunk) => {
      output += String(chunk)
    })
    supervisor.stderr!.on('data', (chunk) => {
      errors += String(chunk)
    })
    const urls = () => output.match(/http:\/\/127\.0\.0\.1:\d+/g) ?? []
    await vi.waitFor(() => expect(urls()).toHaveLength(1), { timeout: 5000 })
    const identity = await readFile(join(dataDir, 'identity.json'), 'utf8')
    const credential = await readFile(join(dataDir, 'owner-credential'), 'utf8')
    const database = new DatabaseSync(join(dataDir, DATABASE_FILENAME))
    try {
      database.exec(
        "CREATE TABLE recovery_probe (value TEXT); INSERT INTO recovery_probe VALUES ('committed before crash')",
      )
    } finally {
      database.close()
    }
    const serverPids = () =>
      output
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { message: string; pid?: number })
        .filter((line) => line.message.startsWith('Environment server listening'))
        .map((line) => line.pid!)
    process.kill(serverPids()[0]!, 'SIGKILL')
    await vi.waitFor(() => expect(urls()).toHaveLength(2), { timeout: 15000 })
    expect(await readFile(join(dataDir, 'identity.json'), 'utf8')).toBe(identity)
    expect(await readFile(join(dataDir, 'owner-credential'), 'utf8')).toBe(credential)
    const recovered = new DatabaseSync(join(dataDir, DATABASE_FILENAME))
    try {
      expect(recovered.prepare('SELECT value FROM recovery_probe').get()).toEqual({
        value: 'committed before crash',
      })
      expect(recovered.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally {
      recovered.close()
    }
    // Ending the supervisor is the Windows task's graceful-stop path. Its
    // child notices the missing parent and closes sockets before exiting.
    const socket = new WebSocket(`${urls()[1]!.replace('http:', 'ws:')}/ws`, {
      headers: { authorization: `Bearer ${credential.trim()}` },
    })
    clients.push(socket)
    socket.on('error', () => {})
    await once(socket, 'open')
    const closed = once(socket, 'close')
    const supervisorClosed = once(supervisor, 'close')
    supervisor.kill('SIGKILL')
    const [code, reason] = await closed
    expect(code, `${output}\n${errors}`).toBe(1001)
    expect(String(reason)).toBe('server_shutdown')
    await supervisorClosed
    children.splice(children.indexOf(supervisor), 1)
    // The server outlives its supervisor until it has closed SQLite.
    const server = serverPids()[1]!
    await vi.waitFor(() => expect(() => process.kill(server, 0)).toThrow(), { timeout: 10_000 })
  }, 25_000)

  it('preserves environment identity and durable credential state across a graceful restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-lifecycle-test-'))
    directories.push(dataDir)
    const first = await launch(dataDir)
    const firstBootstrap = BootstrapResponseSchema.parse(
      await (await fetch(`${first.url}/bootstrap`)).json(),
    )
    const identityRecord = await readFile(join(dataDir, 'identity.json'), 'utf8')
    const credentialRecord = await readFile(join(dataDir, 'owner-credential'), 'utf8')

    await stop(first)

    const restarted = await launch(dataDir)
    const restartedBootstrap = BootstrapResponseSchema.parse(
      await (await fetch(`${restarted.url}/bootstrap`)).json(),
    )
    expect(restartedBootstrap).toMatchObject({
      environmentId: firstBootstrap.environmentId,
      label: firstBootstrap.label,
    })
    expect(await readFile(join(dataDir, 'identity.json'), 'utf8')).toBe(identityRecord)
    expect(await readFile(join(dataDir, 'owner-credential'), 'utf8')).toBe(credentialRecord)
    await stop(restarted)
  })

  it.skipIf(process.platform === 'win32')(
    'delivers a clean close reason to an active socket before SIGTERM exit',
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-lifecycle-test-'))
      directories.push(dataDir)
      const serverProcess = await launch(dataDir)
      const token = (await readFile(join(dataDir, 'owner-credential'), 'utf8')).trim()
      const socket = new WebSocket(`${serverProcess.url.replace('http:', 'ws:')}/ws`, {
        headers: { authorization: `Bearer ${token}` },
      })
      clients.push(socket)
      socket.on('error', () => {})
      await once(socket, 'open')
      socket.send(
        JSON.stringify({
          type: 'command',
          requestId: 'handshake-1',
          name: 'protocol.handshake',
          payload: {
            protocolVersion: PROTOCOL_VERSION,
            requiredCapabilities: ['connection.heartbeat'],
          },
        }),
      )
      const data = await nextServerText(socket)
      expect(ServerMessageSchema.parse(JSON.parse(data))).toMatchObject({
        type: 'response',
        requestId: 'handshake-1',
      })

      const closed = once(socket, 'close')
      expect(serverProcess.child.kill('SIGTERM')).toBe(true)
      const [code, reason] = await closed
      expect(code).toBe(1001)
      expect(String(reason)).toBe('server_shutdown')
      expect(await serverProcess.exited).toEqual([0, null])
      expect(serverProcess.errors()).toBe('')
      children.splice(children.indexOf(serverProcess.child), 1)
    },
  )

  it('writes an uncaught crash to the log file and still exits', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-crash-log-test-'))
    directories.push(dataDir)
    const logFile = join(dataDir, 'server.log')
    // Throws once the server has hooked the crash monitor, like a bug in any
    // callback nothing else catches.
    const crash = join(dataDir, 'crash.mjs')
    await writeFile(
      crash,
      [
        'const timer = setInterval(() => {',
        "  if (process.listenerCount('uncaughtExceptionMonitor') === 0) return",
        '  clearInterval(timer)',
        "  throw new Error('crash probe')",
        '}, 10)',
      ].join('\n'),
    )
    const env = { ...process.env }
    delete env.OPENMANAGER_WORKSPACES
    const child = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(crash).href,
        entry,
        '--port=0',
        '--data-dir',
        dataDir,
        '--log-file',
        logFile,
      ],
      { env, stdio: 'ignore', windowsHide: true },
    )
    children.push(child)
    const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null]
    expect(code).not.toBe(0)
    expect(code).not.toBeNull()
    const log = await readFile(logFile, 'utf8')
    expect(log).toContain('Environment server crashed (uncaughtException): Error: crash probe')
    expect(log).toMatch(/crash probe\s+at /)
  })
})

describe('supervised server output', () => {
  it('keeps the server up when Node prints a warning after a child program exits', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-supervised-output-test-'))
    directories.push(dataDir)
    const logFile = join(dataDir, 'server.log')
    // In the server (not the supervisor): run a program to completion, then
    // print a warning. With the console inherited, the warning crashed the
    // detached server on Windows once that program had exited.
    const probe = join(dataDir, 'warn.mjs')
    await writeFile(
      probe,
      [
        "import { spawn } from 'node:child_process'",
        // The program started here inherits NODE_OPTIONS and loads this file
        // too; the variable keeps it from starting one of its own.
        "if (!process.argv.includes('--supervise') && !process.env.WARN_PROBE_CHILD) {",
        "  const env = { ...process.env, WARN_PROBE_CHILD: '1' }",
        "  const done = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true, env })",
        "  done.on('exit', () => setTimeout(() => process.emitWarning('supervised warning probe'), 50))",
        '}',
      ].join('\n'),
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // The supervisor starts the server without its own exec arguments, so
      // the probe travels in the environment both of them read.
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(probe).href}`.trim(),
    }
    delete env.OPENMANAGER_WORKSPACES
    const supervisor = spawn(
      process.execPath,
      [entry, '--supervise', '--port=0', '--data-dir', dataDir, '--log-file', logFile],
      { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true },
    )
    children.push(supervisor)
    const exited = once(supervisor, 'exit')
    const readLog = () => readFile(logFile, 'utf8').catch(() => '')
    try {
      await vi.waitFor(
        async () => {
          const log = await readLog()
          expect(log).toContain('supervised warning probe')
          expect(log).toContain('Environment server listening')
        },
        { timeout: 15_000, interval: 100 },
      )
      // A crash would show within a moment of the warning.
      await new Promise((resolve) => setTimeout(resolve, 500))
      const log = await readLog()
      // Still the first server: nothing crashed and nothing was restarted.
      expect(log).not.toContain('Environment server crashed')
      expect(log.match(/Environment server listening/g)).toHaveLength(1)
      const url = log.match(/http:\/\/127\.0\.0\.1:\d+/)![0]
      expect((await fetch(`${url}/bootstrap`)).ok).toBe(true)
    } finally {
      // A graceful stop, so the server has closed SQLite before cleanup.
      supervisor.send('shutdown')
      expect((await exited)[0]).toBe(0)
      children.splice(children.indexOf(supervisor), 1)
    }
  }, 30_000)
})
