import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BootstrapResponseSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
} from '@openmanager/protocol/node'

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const directories: string[] = []
const children: ChildProcess[] = []
const clients: WebSocket[] = []

async function launch(dataDir: string) {
  const child = spawn(process.execPath, [entry, '--port=0', '--data-dir', dataDir], {
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

async function stop(process: Awaited<ReturnType<typeof launch>>) {
  expect(process.child.kill('SIGTERM')).toBe(true)
  const exit = await process.exited
  if (process.platform === 'win32') expect(exit).toEqual([null, 'SIGTERM'])
  else expect(exit).toEqual([0, null])
  expect(process.errors()).toBe('')
  children.splice(children.indexOf(process.child), 1)
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
  it('preserves environment identity and durable credential state across a graceful restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-lifecycle-test-'))
    directories.push(dataDir)
    const first = await launch(dataDir)
    const firstBootstrap = BootstrapResponseSchema.parse(
      await (await fetch(`${first.url}/bootstrap`)).json(),
    )
    const identityRecord = await readFile(join(dataDir, 'identity.json'), 'utf8')
    const credentialRecord = await readFile(join(dataDir, 'client-token'), 'utf8')

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
    expect(await readFile(join(dataDir, 'client-token'), 'utf8')).toBe(credentialRecord)
    await stop(restarted)
  })

  it.skipIf(process.platform === 'win32')(
    'delivers a clean close reason to an active socket before SIGTERM exit',
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-lifecycle-test-'))
      directories.push(dataDir)
      const process = await launch(dataDir)
      const token = (await readFile(join(dataDir, 'client-token'), 'utf8')).trim()
      const socket = new WebSocket(`${process.url.replace('http:', 'ws:')}/ws`, {
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
      expect(process.child.kill('SIGTERM')).toBe(true)
      const [code, reason] = await closed
      expect(code).toBe(1001)
      expect(String(reason)).toBe('server_shutdown')
      expect(await process.exited).toEqual([0, null])
      expect(process.errors()).toBe('')
      children.splice(children.indexOf(process.child), 1)
    },
  )
})
