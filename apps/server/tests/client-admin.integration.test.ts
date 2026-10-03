import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AuthorizedClientListSchema,
  ClientListChangedEventSchema,
  ClientResponseSchemas,
  PAIRING_EXCHANGE_PATH,
  PairingResponseSchemas,
  type AccessCapability,
  type ServerMessage,
} from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { containsSecret } from '../src/redact.js'
import { REVOKED_CLOSE_CODE, REVOKED_CLOSE_REASON } from '../src/websocket.js'
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

/** A handshaken socket for one credential. */
async function connectAs(host: ProtocolHost, credential: string) {
  const client = await connectProtocol({ ...host, token: credential })
  await handshake(client)
  return client
}

function pair(host: ProtocolHost, label: string, capabilities: AccessCapability[]) {
  return host.server.clients.issue({ label, kind: 'paired', capabilities })
}

async function call(client: ProtocolClient, name: string, payload: unknown) {
  return nextResponse(client, client.command(name, payload))
}

async function list(client: ProtocolClient) {
  const answer = await call(client, 'client.list', null)
  return ClientResponseSchemas['client.list'].parse(answer).payload
}

/** The next `client.list.changed` this socket receives, skipping anything else. */
async function nextListChange(client: ProtocolClient, timeoutMs = 5_000) {
  const held = client.heldEvents.findIndex(
    (message) => message.type === 'event' && message.name === 'client.list.changed',
  )
  if (held >= 0) {
    return ClientListChangedEventSchema.parse(client.heldEvents.splice(held, 1)[0]).payload
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('timed out waiting for client.list.changed')
    const message: ServerMessage = await Promise.race([
      nextNonPing(client),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for client.list.changed')), remaining),
      ),
    ])
    if (message.type === 'event' && message.name === 'client.list.changed') {
      return ClientListChangedEventSchema.parse(message).payload
    }
  }
}

/** List changes until one satisfies `done`; earlier, stale readings are skipped. */
async function listChangeWhere(
  client: ProtocolClient,
  done: (list: Awaited<ReturnType<typeof nextListChange>>) => boolean,
) {
  for (;;) {
    const next = await nextListChange(client)
    if (done(next)) return next
  }
}

/** Collect the list changes that arrive within `ms`, without failing on none. */
async function listChangesWithin(client: ProtocolClient, ms: number) {
  const seen: unknown[] = []
  const deadline = Date.now() + ms
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return seen
    const message = await Promise.race([
      nextNonPing(client),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
    ])
    if (message === null) return seen
    if (message.type === 'event' && message.name === 'client.list.changed') seen.push(message)
  }
}

async function upgradeStatus(host: ProtocolHost, credential: string) {
  const ws = new WebSocket(host.url, { headers: { authorization: `Bearer ${credential}` } })
  ws.on('error', () => {})
  return new Promise<number | undefined>((resolve, reject) => {
    ws.once('open', () => {
      ws.terminate()
      reject(new Error('Unexpected successful upgrade'))
    })
    ws.once('unexpected-response', (_request, response) => {
      ws.terminate()
      resolve(response.statusCode)
    })
  })
}

describe('device list', () => {
  it('lists live clients with the owner first, who is connected, and which one is asking', async () => {
    const host = await startProtocolHost()
    const phone = pair(host, 'Phone', ['read'])
    const owner = await connectAs(host, host.token)

    const first = await list(owner)
    expect(AuthorizedClientListSchema.parse(first)).toEqual(first)
    expect(first.currentClientId).toBe(host.server.owner.clientId)
    expect(first.omitted).toBe(0)
    expect(first.clients.map((client) => [client.label, client.kind, client.connected])).toEqual([
      ['Local owner', 'owner', true],
      ['Phone', 'paired', false],
    ])
    expect(first.clients[0]!.capabilities).toEqual([
      'read',
      'operate',
      'agent',
      'terminal',
      'admin',
    ])
    expect(first.clients[1]!.lastSeenAt).toBeNull()
    expect(containsSecret(first)).toBe(false)
    expect(JSON.stringify(first)).not.toContain(phone.credential)

    // Connecting is what moves last-seen, and admin holders hear about it.
    await connectAs(host, phone.credential)
    const changed = await listChangeWhere(owner, (next) =>
      next.clients.some((client) => client.clientId === phone.client.clientId && client.connected),
    )
    const seenPhone = changed.clients.find((client) => client.clientId === phone.client.clientId)!
    expect(seenPhone.connected).toBe(true)
    expect(seenPhone.lastSeenAt).not.toBeNull()
    expect(Date.parse(seenPhone.expiresAt)).toBeGreaterThan(Date.parse(seenPhone.lastSeenAt!))
    expect(changed.currentClientId).toBe(host.server.owner.clientId)
  })

  it('keeps revoked and expired clients out of the list', async () => {
    const host = await startProtocolHost()
    const gone = pair(host, 'Old tablet', ['read'])
    host.server.revokeClient(gone.client.clientId)
    const idle = pair(host, 'Idle phone', ['read'])
    const database = openEnvironmentDatabase(host.dataDir)
    try {
      database
        .prepare('UPDATE authorized_clients SET expires_at = 1 WHERE client_id = ?')
        .run(idle.client.clientId)
    } finally {
      database.close()
    }
    const owner = await connectAs(host, host.token)
    expect((await list(owner)).clients.map((client) => client.label)).toEqual(['Local owner'])
  })

  it('refuses clients without admin and records the refusal', async () => {
    const host = await startProtocolHost()
    const phone = pair(host, 'Phone', ['read', 'operate', 'agent'])
    const client = await connectAs(host, phone.credential)
    for (const [name, payload] of [
      ['client.list', null],
      ['client.rename', { clientId: phone.client.clientId, label: 'Mine' }],
      ['client.revoke', { clientId: host.server.owner.clientId }],
      ['client.revoke_others', null],
      ['client.owner.rotate', null],
    ] as const) {
      expect(await call(client, name, payload)).toMatchObject({
        type: 'error',
        error: { code: 'capability_missing', details: { requiredCapability: 'admin' } },
      })
    }
    expect(
      host.server.audit.query({ type: 'capability.denied', clientId: phone.client.clientId }),
    ).toHaveLength(5)
  })

  it('sends list changes only to connections that listed the clients', async () => {
    const host = await startProtocolHost()
    const viewer = pair(host, 'Viewer', ['read'])
    const owner = await connectAs(host, host.token)
    const quietOwnerTab = await connectAs(host, host.token)
    await list(owner)
    const watcher = await connectAs(host, viewer.credential)
    await listChangeWhere(owner, (next) =>
      next.clients.some((client) => client.clientId === viewer.client.clientId && client.connected),
    )

    const renamed = await call(owner, 'client.rename', {
      clientId: viewer.client.clientId,
      label: 'Kitchen display',
    })
    expect(renamed).toMatchObject({ type: 'response' })
    await listChangeWhere(owner, (next) =>
      next.clients.some((client) => client.label === 'Kitchen display'),
    )
    expect(await listChangesWithin(watcher, 300)).toEqual([])
    expect(await listChangesWithin(quietOwnerTab, 100)).toEqual([])
  })
})

describe('naming clients', () => {
  it('trims names, refuses blank, long and control-character ones, and keeps the owner name across rotation', async () => {
    const host = await startProtocolHost()
    const phone = pair(host, 'Phone', ['read'])
    const owner = await connectAs(host, host.token)

    const renamed = ClientResponseSchemas['client.rename'].parse(
      await call(owner, 'client.rename', { clientId: phone.client.clientId, label: '  Pixel  ' }),
    )
    expect(renamed.payload.client.label).toBe('Pixel')
    expect(host.server.clients.get(phone.client.clientId)?.label).toBe('Pixel')

    for (const label of ['   ', 'x'.repeat(129), 'two\nlines']) {
      expect(
        await call(owner, 'client.rename', { clientId: phone.client.clientId, label }),
      ).toMatchObject({ type: 'error', error: { code: 'validation' } })
    }
    expect(
      await call(owner, 'client.rename', { clientId: 'no-such-client', label: 'Ghost' }),
    ).toMatchObject({ type: 'error', error: { code: 'not_found' } })

    await call(owner, 'client.rename', { clientId: host.server.owner.clientId, label: 'Desk' })
    host.server.remintOwner()
    expect(host.server.owner.label).toBe('Desk')
  })
})

describe('revoking clients', () => {
  it('closes the revoked client with 4401, refuses its credential everywhere, and audits who did it', async () => {
    const host = await startProtocolHost()
    const phone = pair(host, 'Phone', ['read', 'operate'])
    const owner = await connectAs(host, host.token)
    const target = await connectAs(host, phone.credential)
    const second = await connectAs(host, phone.credential)

    await list(owner)
    const closed = [once(target.ws, 'close'), once(second.ws, 'close')]
    const answer = await call(owner, 'client.revoke', { clientId: phone.client.clientId })
    expect(answer).toMatchObject({ type: 'response', payload: { clientId: phone.client.clientId } })
    for (const [code, reason] of await Promise.all(closed)) {
      expect(code).toBe(REVOKED_CLOSE_CODE)
      expect(String(reason)).toBe(REVOKED_CLOSE_REASON)
    }

    expect(await upgradeStatus(host, phone.credential)).toBe(401)
    const download = await fetch(`${host.server.url}/artifacts/session-1/artifact-1`, {
      headers: { authorization: `Bearer ${phone.credential}` },
    })
    expect(download.status).toBe(401)

    expect(
      host.server.audit.query({ type: 'token.revoked', clientId: phone.client.clientId }),
    ).toMatchObject([
      {
        command: 'client.revoke',
        outcome: 'revoked',
        details: { revokedBy: host.server.owner.clientId },
      },
    ])
    await listChangeWhere(
      owner,
      (next) => !next.clients.some((client) => client.clientId === phone.client.clientId),
    )

    expect(await call(owner, 'client.revoke', { clientId: phone.client.clientId })).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
  })

  it('refuses to revoke the caller itself or the owner', async () => {
    const host = await startProtocolHost()
    const tablet = pair(host, 'Tablet', ['read', 'admin'])
    const owner = await connectAs(host, host.token)
    const admin = await connectAs(host, tablet.credential)

    expect(await call(admin, 'client.revoke', { clientId: tablet.client.clientId })).toMatchObject({
      type: 'error',
      error: { code: 'validation' },
    })
    expect(
      await call(owner, 'client.revoke', { clientId: host.server.owner.clientId }),
    ).toMatchObject({ type: 'error', error: { code: 'validation' } })
    expect(
      await call(admin, 'client.revoke', { clientId: host.server.owner.clientId }),
    ).toMatchObject({ type: 'error', error: { code: 'validation' } })

    // Both are still in, and their sockets still answer.
    expect((await list(owner)).clients).toHaveLength(2)
    expect((await list(admin)).clients).toHaveLength(2)
    expect(host.server.audit.query({ type: 'token.revoked' })).toEqual([])
  })

  it('revokes every other client but keeps the caller and the owner', async () => {
    const host = await startProtocolHost()
    const tablet = pair(host, 'Tablet', ['read', 'admin'])
    const phone = pair(host, 'Phone', ['read'])
    const laptop = pair(host, 'Laptop', ['read', 'operate'])
    const owner = await connectAs(host, host.token)
    const admin = await connectAs(host, tablet.credential)
    const phoneSocket = await connectAs(host, phone.credential)
    const phoneClosed = once(phoneSocket.ws, 'close')

    const answer = ClientResponseSchemas['client.revoke_others'].parse(
      await call(admin, 'client.revoke_others', null),
    )
    expect(answer.payload.revokedClientIds.sort()).toEqual(
      [phone.client.clientId, laptop.client.clientId].sort(),
    )
    expect((await phoneClosed)[0]).toBe(REVOKED_CLOSE_CODE)
    expect((await list(owner)).clients.map((client) => client.label)).toEqual([
      'Local owner',
      'Tablet',
    ])
    expect(await upgradeStatus(host, laptop.credential)).toBe(401)
    expect(
      host.server.audit
        .query({ type: 'token.revoked' })
        .map((event) => [event.clientId, event.command])
        .sort(),
    ).toEqual(
      [
        [phone.client.clientId, 'client.revoke_others'],
        [laptop.client.clientId, 'client.revoke_others'],
      ].sort(),
    )

    // Nothing left to revoke is an empty answer, not an error.
    expect(await call(admin, 'client.revoke_others', null)).toMatchObject({
      type: 'response',
      payload: { revokedClientIds: [] },
    })
  })
})

describe('rotating the owner credential', () => {
  it('answers the owner with a new credential, then closes every socket that used the old one', async () => {
    const host = await startProtocolHost()
    const previous = host.server.owner.clientId
    const owner = await connectAs(host, host.token)
    const otherTab = await connectAs(host, host.token)
    const closed = [once(owner.ws, 'close'), once(otherTab.ws, 'close')]

    const answer = ClientResponseSchemas['client.owner.rotate'].parse(
      await call(owner, 'client.owner.rotate', null),
    )
    const { credential, client } = answer.payload
    expect(credential).not.toBe(host.token)
    expect(client).toMatchObject({ kind: 'owner', label: 'Local owner', connected: false })
    expect(client.clientId).toBe(host.server.owner.clientId)
    expect(client.clientId).not.toBe(previous)
    for (const [code, reason] of await Promise.all(closed)) {
      expect(code).toBe(REVOKED_CLOSE_CODE)
      expect(String(reason)).toBe(REVOKED_CLOSE_REASON)
    }

    // The data directory publishes the new credential for local clients.
    expect((await readFile(join(host.dataDir, 'owner-credential'), 'utf8')).trim()).toBe(credential)
    expect(await upgradeStatus(host, host.token)).toBe(401)
    const renewed = await connectAs(host, credential)
    expect((await list(renewed)).currentClientId).toBe(client.clientId)

    expect(host.server.audit.query({ type: 'owner.reminted' })).toMatchObject([
      {
        clientId: client.clientId,
        details: { previousClientId: previous, requestedBy: previous },
      },
    ])
    expect(host.server.audit.query({ type: 'token.revoked', clientId: previous })).toMatchObject([
      { command: 'owner.rotate' },
    ])
    expect(containsSecret(host.server.audit.query({}))).toBe(false)
  })

  it('lets only the owner rename the owner', async () => {
    const host = await startProtocolHost()
    const tablet = pair(host, 'Tablet', ['read', 'admin'])
    const admin = await connectAs(host, tablet.credential)
    expect(
      await call(admin, 'client.rename', { clientId: host.server.owner.clientId, label: 'Mine' }),
    ).toMatchObject({ type: 'error', error: { code: 'capability_missing' } })
    expect(
      await call(admin, 'client.rename', { clientId: tablet.client.clientId, label: 'My tablet' }),
    ).toMatchObject({ type: 'response' })
    expect(host.server.clients.get(host.server.owner.clientId)?.label).toBe('Local owner')
  })

  it('is refused for a paired client, even one with admin', async () => {
    const host = await startProtocolHost()
    const tablet = pair(host, 'Tablet', ['read', 'admin'])
    const admin = await connectAs(host, tablet.credential)
    const before = host.server.owner.clientId
    expect(await call(admin, 'client.owner.rotate', null)).toMatchObject({
      type: 'error',
      error: { code: 'capability_missing' },
    })
    expect(host.server.owner.clientId).toBe(before)
    expect(await upgradeStatus(host, tablet.credential).catch(() => 'open')).toBe('open')
  })

  it('keeps the old credential working when the new one cannot be published', async () => {
    const host = await startProtocolHost()
    const owner = await connectAs(host, host.token)
    const before = host.server.owner.clientId
    vi.spyOn(host.server.clients, 'remintOwner').mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(await call(owner, 'client.owner.rotate', null)).toMatchObject({
      type: 'error',
      error: { code: 'internal' },
    })
    // The server, this socket and the old credential all carry on.
    expect((await list(owner)).currentClientId).toBe(before)
    expect(await upgradeStatus(host, host.token).catch(() => 'open')).toBe('open')
  })
})

describe('failures and budgets', () => {
  it('still cuts the old owner sockets when the rotation answer fails after the commit', async () => {
    const host = await startProtocolHost()
    const owner = await connectAs(host, host.token)
    const otherTab = await connectAs(host, host.token)
    const closed = [once(owner.ws, 'close'), once(otherTab.ws, 'close')]
    const get = host.server.clients.get.bind(host.server.clients)
    // The caller's own check passes; reading the new owner back then fails.
    vi.spyOn(host.server.clients, 'get')
      .mockImplementationOnce(get)
      .mockImplementationOnce(() => {
        throw new Error('read failed')
      })
    expect(await call(owner, 'client.owner.rotate', null)).toMatchObject({
      type: 'error',
      error: { code: 'internal' },
    })
    for (const [code] of await Promise.all(closed)) expect(code).toBe(REVOKED_CLOSE_CODE)
    expect(await upgradeStatus(host, host.token)).toBe(401)
    const published = (await readFile(join(host.dataDir, 'owner-credential'), 'utf8')).trim()
    await connectAs(host, published)
  })

  it('does not count listing the devices against the mutation budget', async () => {
    const host = await startProtocolHost()
    const phone = pair(host, 'Phone', ['read'])
    const owner = await connectAs(host, host.token)
    for (let index = 0; index < 125; index += 1) {
      expect(await call(owner, 'client.list', null)).toMatchObject({ type: 'response' })
    }
    expect(
      await call(owner, 'client.rename', { clientId: phone.client.clientId, label: 'Pixel' }),
    ).toMatchObject({ type: 'response' })
  })
})

describe('clients the list must not lose', () => {
  it('lists, and revokes with the others, a client whose credential expired while it stayed connected', async () => {
    const host = await startProtocolHost()
    const phone = pair(host, 'Phone', ['read'])
    const owner = await connectAs(host, host.token)
    const stale = await connectAs(host, phone.credential)
    const database = openEnvironmentDatabase(host.dataDir)
    try {
      database
        .prepare('UPDATE authorized_clients SET expires_at = 1 WHERE client_id = ?')
        .run(phone.client.clientId)
    } finally {
      database.close()
    }

    expect((await list(owner)).clients.map((client) => client.label)).toEqual([
      'Local owner',
      'Phone',
    ])
    const closed = once(stale.ws, 'close')
    expect(await call(owner, 'client.revoke_others', null)).toMatchObject({
      type: 'response',
      payload: { revokedClientIds: [phone.client.clientId] },
    })
    expect((await closed)[0]).toBe(REVOKED_CLOSE_CODE)
  })

  it('counts the clients past the list limit, and revoke-others still reaches them', async () => {
    const host = await startProtocolHost()
    for (let index = 0; index < 1030; index += 1) pair(host, `Device ${index}`, ['read'])
    const owner = await connectAs(host, host.token)
    const listed = await list(owner)
    expect(listed.clients).toHaveLength(1024)
    expect(listed.omitted).toBe(7)
    const answer = ClientResponseSchemas['client.revoke_others'].parse(
      await call(owner, 'client.revoke_others', null),
    )
    expect(answer.payload.revokedClientIds).toHaveLength(1030)
    expect(await list(owner)).toMatchObject({ omitted: 0, clients: [{ kind: 'owner' }] })
  }, 30_000)

  it('announces a device that pairs through a link, and one whose grant a link changes', async () => {
    const host = await startProtocolHost()
    const owner = await connectAs(host, host.token)
    await list(owner)
    const createLink = async (capabilities: AccessCapability[], label?: string) =>
      PairingResponseSchemas['pairing.create'].parse(
        await call(owner, 'pairing.create', { capabilities, ...(label ? { label } : {}) }),
      ).payload.token

    // A new device exchanges a link over HTTP.
    const token = await createLink(['read'], 'Garage tablet')
    const exchanged = await fetch(`${host.server.url}${PAIRING_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    expect(exchanged.status).toBe(200)
    await listChangeWhere(owner, (next) =>
      next.clients.some((client) => client.label === 'Garage tablet' && !client.connected),
    )

    // A paired device redeems a wider link over its own socket.
    const phone = pair(host, 'Phone', ['read'])
    const phoneSocket = await connectAs(host, phone.credential)
    const wider = await createLink(['read', 'operate'])
    expect(await call(phoneSocket, 'pairing.redeem', { token: wider })).toMatchObject({
      type: 'response',
      payload: { grantChanged: true },
    })
    await listChangeWhere(owner, (next) =>
      next.clients.some(
        (client) =>
          client.clientId === phone.client.clientId && client.capabilities.includes('operate'),
      ),
    )
  })

  it('announces a newly minted client to connections that listed', async () => {
    const host = await startProtocolHost()
    const owner = await connectAs(host, host.token)
    await list(owner)
    pair(host, 'New phone', ['read'])
    await listChangeWhere(owner, (next) =>
      next.clients.some((client) => client.label === 'New phone' && !client.connected),
    )
  })
})
