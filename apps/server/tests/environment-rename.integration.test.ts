import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EnvironmentChangedEventSchema,
  EnvironmentNameResponseSchemas,
  type ServerMessage,
} from '@openmanager/protocol/node'
import {
  cleanupProtocolHosts,
  connectProtocol,
  handshake,
  nextNonPing,
  nextResponse,
  startProtocolHost,
  type ProtocolClient,
  type ProtocolHost,
} from './helpers/protocol-client.js'

afterEach(cleanupProtocolHosts)

async function connectAs(host: ProtocolHost, credential: string) {
  const client = await connectProtocol({ ...host, token: credential })
  await handshake(client)
  return client
}

async function rename(client: ProtocolClient, label: unknown) {
  return nextResponse(client, client.command('environment.rename', { label }))
}

/** The next `environment.changed` this socket receives, skipping anything else. */
async function nextEnvironmentChange(client: ProtocolClient, timeoutMs = 5_000) {
  const held = client.heldEvents.findIndex(
    (message) => message.type === 'event' && message.name === 'environment.changed',
  )
  if (held >= 0) {
    return EnvironmentChangedEventSchema.parse(client.heldEvents.splice(held, 1)[0]).payload
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('timed out waiting for environment.changed')
    const message: ServerMessage = await Promise.race([
      nextNonPing(client),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for environment.changed')), remaining),
      ),
    ])
    if (message.type === 'event' && message.name === 'environment.changed') {
      return EnvironmentChangedEventSchema.parse(message).payload
    }
  }
}

describe('environment rename', () => {
  it('saves the new name, tells every connection, and answers bootstrap with it', async () => {
    const host = await startProtocolHost()
    const { environmentId } = host.server.identity
    const owner = await connectAs(host, host.token)
    const phone = host.server.clients.issue({
      label: 'Phone',
      kind: 'paired',
      capabilities: ['read'],
    })
    const watcher = await connectAs(host, phone.credential)

    const answer = EnvironmentNameResponseSchemas['environment.rename'].parse(
      await rename(owner, '  Laptop (WSL)  '),
    )
    expect(answer.payload.environment).toMatchObject({ environmentId, name: 'Laptop (WSL)' })
    expect((await nextEnvironmentChange(watcher)).environment).toMatchObject({
      environmentId,
      name: 'Laptop (WSL)',
    })

    expect(host.server.identity).toMatchObject({ environmentId, label: 'Laptop (WSL)' })
    const onDisk = JSON.parse(await readFile(join(host.dataDir, 'identity.json'), 'utf8'))
    expect(onDisk).toEqual({ version: 1, environmentId, label: 'Laptop (WSL)' })
    const bootstrap = await (await fetch(`${host.server.url}/bootstrap`)).json()
    expect(bootstrap).toMatchObject({ environmentId, label: 'Laptop (WSL)' })
  })

  it('advertises the command, and refuses a client without admin', async () => {
    const host = await startProtocolHost()
    const bootstrap = (await (await fetch(`${host.server.url}/bootstrap`)).json()) as {
      capabilities: string[]
    }
    expect(bootstrap.capabilities).toContain('environment.rename')

    const before = host.server.identity.label
    const phone = host.server.clients.issue({
      label: 'Phone',
      kind: 'paired',
      capabilities: ['read', 'operate', 'agent'],
    })
    const client = await connectAs(host, phone.credential)
    expect(await rename(client, 'Mine')).toMatchObject({
      type: 'error',
      error: { code: 'capability_missing', details: { requiredCapability: 'admin' } },
    })
    expect(host.server.identity.label).toBe(before)
  })

  it('refuses blank, long and control-character names and keeps the old one', async () => {
    const host = await startProtocolHost()
    const before = host.server.identity.label
    const owner = await connectAs(host, host.token)
    for (const label of ['   ', 'x'.repeat(129), 'Lap\ntop', 'Lap‮top', 42]) {
      expect(await rename(owner, label)).toMatchObject({
        type: 'error',
        error: { code: 'validation' },
      })
    }
    expect(host.server.identity.label).toBe(before)
    const onDisk = JSON.parse(await readFile(join(host.dataDir, 'identity.json'), 'utf8'))
    expect(onDisk.label).toBe(before)
  })

  it('keeps the last of several renames sent at once', async () => {
    const host = await startProtocolHost()
    const owner = await connectAs(host, host.token)
    // Sent back to back, before any answer: the server takes them in order.
    const pending = new Set(
      ['One', 'Two', 'Three'].map((label) => owner.command('environment.rename', { label })),
    )
    while (pending.size > 0) {
      const message = await nextNonPing(owner)
      if (message.type === 'event') continue
      expect(message.type).toBe('response')
      pending.delete((message as { requestId: string }).requestId)
    }
    expect(host.server.identity.label).toBe('Three')
    const onDisk = JSON.parse(await readFile(join(host.dataDir, 'identity.json'), 'utf8'))
    expect(onDisk.label).toBe('Three')
  })
})
