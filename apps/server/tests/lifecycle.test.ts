import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    const record = output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((line) => line.message.startsWith('Environment server listening'))
    process.kill(record.pid, 'SIGKILL')
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
    // stdout is inherited by the server; close waits for it to exit too.
    await supervisorClosed
    children.splice(children.indexOf(supervisor), 1)
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
      const [data] = await once(socket, 'message')
      expect(ServerMessageSchema.parse(JSON.parse(data.toString()))).toMatchObject({
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
})
