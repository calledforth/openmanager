import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PAIRING_EXCHANGE_CAPABILITY,
  PAIRING_EXCHANGE_PATH,
  PAIRING_LINK_LIFETIME_MS,
  PAIRING_PENDING_LINKS_MAX,
  PAIRING_TOKEN_ALPHABET,
  PairingExchangeResponseSchema,
  PairingResponseSchemas,
  type AccessCapability,
} from '@openmanager/protocol/node'
import { createAuditLog, type AuditLog } from '../src/audit.js'
import { openAuthorizedClients, type AuthorizedClients } from '../src/authorized-clients.js'
import { DATABASE_FILENAME } from '../src/db/database.js'
import type { Logger } from '../src/logger.js'
import {
  createPairingService,
  DEFAULT_PAIRED_LABEL,
  GRANT_CHANGED_CLOSE_CODE,
  mintPairingToken,
  PAIRING_EXCHANGE_MAX_BYTES,
  type PairingService,
} from '../src/pairing.js'
import { createRateLimiter, RATE_LIMITS, type RateLimiter } from '../src/rate-limit.js'
import {
  cleanupProtocolHosts,
  connectProtocol,
  handshake,
  nextResponse,
  startProtocolHost,
} from './helpers/protocol-client.js'

const ENVIRONMENT = { environmentId: 'env-pairing-test', label: 'Test machine' }
const silent = (() => undefined) as unknown as Logger

const directories: string[] = []
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await cleanupProtocolHosts()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

type Harness = {
  dataDir: string
  clients: AuthorizedClients
  pairing: PairingService
  audit: AuditLog
  rateLimiter: RateLimiter
  clock: { now: number }
  regranted: string[]
  ownerId: string
  url: string
  create: (
    capabilities: AccessCapability[],
    options?: { label?: string | null; clientId?: string },
  ) => { status: 'response' | 'error'; body: Record<string, unknown> }
  exchange: (body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>
}

async function harness(): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-pairing-test-'))
  directories.push(dataDir)
  const clock = { now: Date.UTC(2026, 9, 2, 12) }
  const audit = createAuditLog(silent, { dataDir })
  const clients = openAuthorizedClients(dataDir, () => clock.now, audit)
  const owner = clients.ensureOwner()
  const rateLimiter = createRateLimiter(() => clock.now)
  const regranted: string[] = []
  const pairing = createPairingService({
    dataDir,
    clients,
    audit,
    rateLimiter,
    environment: () => ENVIRONMENT,
    onGrantChanged: (clientId) => regranted.push(clientId),
    clock: () => clock.now,
  })
  const server: Server = createServer((request, response) => {
    if (!pairing.handle(request, response)) response.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(() => {
    pairing.close()
    clients.close()
    audit.close()
  })
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let requests = 0
  return {
    dataDir,
    clients,
    pairing,
    audit,
    rateLimiter,
    clock,
    regranted,
    ownerId: owner.clientId,
    url,
    create(capabilities, options = {}) {
      const result = pairing.dispatch(
        {
          type: 'command',
          requestId: `req-${++requests}`,
          name: 'pairing.create',
          payload: {
            capabilities,
            ...(options.label !== undefined ? { label: options.label } : {}),
          },
        },
        { clientId: options.clientId ?? owner.clientId, command: 'pairing.create' },
      ) as { type: 'response' | 'error' } & Record<string, unknown>
      return { status: result.type, body: result }
    },
    async exchange(body) {
      const response = await fetch(`${url}${PAIRING_EXCHANGE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    },
  }
}

function tokenOf(created: { body: Record<string, unknown> }): string {
  return PairingResponseSchemas['pairing.create'].parse(created.body).payload.token
}

function reasonOf(result: { body: Record<string, unknown> }): unknown {
  return (result.body.error as { details?: { reason?: unknown } } | undefined)?.details?.reason
}

describe('pairing tokens', () => {
  it('are twelve unambiguous symbols and do not repeat', () => {
    const tokens = Array.from({ length: 200 }, mintPairingToken)
    expect(new Set(tokens).size).toBe(200)
    for (const token of tokens) {
      expect(token).toHaveLength(12)
      for (const symbol of token) expect(PAIRING_TOKEN_ALPHABET).toContain(symbol)
    }
    expect(PAIRING_TOKEN_ALPHABET).not.toMatch(/[01IO]/)
  })
})

describe('creating pairing links', () => {
  it('returns the token once and stores only its hash, the grant and the label', async () => {
    const h = await harness()
    const created = h.create(['read', 'operate'], { label: 'Phone' })
    expect(created.status).toBe('response')
    const { link, token } = PairingResponseSchemas['pairing.create'].parse(created.body).payload
    expect(link).toMatchObject({
      label: 'Phone',
      capabilities: ['read', 'operate'],
      createdByClientId: h.ownerId,
    })
    expect(Date.parse(link.expiresAt) - Date.parse(link.createdAt)).toBe(PAIRING_LINK_LIFETIME_MS)

    const raw = new DatabaseSync(join(h.dataDir, DATABASE_FILENAME))
    try {
      const row = raw.prepare('SELECT * FROM pairing_links').get() as Record<string, unknown>
      expect(JSON.stringify(row)).not.toContain(token)
      expect(row.token_hash).toBeInstanceOf(Uint8Array)
    } finally {
      raw.close()
    }
    expect(h.audit.query({ type: 'pairing.issued' })).toEqual([
      expect.objectContaining({
        clientId: h.ownerId,
        details: expect.objectContaining({ linkId: link.linkId, capabilities: 'read operate' }),
      }),
    ])
  })

  it('never hands out more than the creating client holds', async () => {
    const h = await harness()
    const limited = h.clients.issue({
      label: 'Tablet',
      kind: 'paired',
      capabilities: ['read', 'admin'],
    })
    const denied = h.create(['read', 'operate'], { clientId: limited.client.clientId })
    expect(denied.body).toMatchObject({
      type: 'error',
      error: { code: 'capability_missing', details: { requiredCapability: 'operate' } },
    })
    expect(h.create(['read'], { clientId: limited.client.clientId }).status).toBe('response')
    expect(h.audit.query({ type: 'capability.denied' })).toHaveLength(1)
  })

  it('caps how many links can wait at once, and expired ones stop counting', async () => {
    const h = await harness()
    for (let i = 0; i < PAIRING_PENDING_LINKS_MAX; i++)
      expect(h.create(['read']).status).toBe('response')
    expect(h.create(['read']).body).toMatchObject({ error: { code: 'conflict' } })
    h.clock.now += PAIRING_LINK_LIFETIME_MS
    expect(h.create(['read']).status).toBe('response')
  })

  it('lists only links still waiting, and withdraws one', async () => {
    const h = await harness()
    const first = PairingResponseSchemas['pairing.create'].parse(h.create(['read']).body).payload
    const second = PairingResponseSchemas['pairing.create'].parse(h.create(['read']).body).payload
    await h.exchange({ token: second.token })

    const list = () =>
      PairingResponseSchemas['pairing.list']
        .parse(
          h.pairing.dispatch({
            type: 'command',
            requestId: 'list',
            name: 'pairing.list',
            payload: null,
          }),
        )
        .payload.links.map((link) => link.linkId)
    expect(list()).toEqual([first.link.linkId])

    const revoke = (linkId: string) =>
      h.pairing.dispatch(
        { type: 'command', requestId: 'revoke', name: 'pairing.revoke', payload: { linkId } },
        { clientId: h.ownerId, command: 'pairing.revoke' },
      )
    expect(revoke(first.link.linkId)).toMatchObject({
      type: 'response',
      payload: { linkId: first.link.linkId },
    })
    expect(list()).toEqual([])
    expect(revoke(first.link.linkId)).toMatchObject({ type: 'error', error: { code: 'not_found' } })
    expect(revoke(second.link.linkId)).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
    expect(h.audit.query({ type: 'pairing.revoked' })).toHaveLength(1)

    const withdrawn = await h.exchange({ token: first.token })
    expect(withdrawn.status).toBe(401)
    expect(reasonOf(withdrawn)).toBe('invalid')
  })
})

describe('exchanging a pairing link', () => {
  it('mints a paired client with the link grant and label', async () => {
    const h = await harness()
    const token = tokenOf(h.create(['read', 'operate'], { label: 'Phone' }))
    const result = await h.exchange({ token, label: 'Chrome on Android' })
    expect(result.status).toBe(200)
    const body = PairingExchangeResponseSchema.parse(result.body)
    expect(body).toMatchObject({
      ...ENVIRONMENT,
      kind: 'paired',
      clientLabel: 'Phone',
      grant: ['read', 'operate'],
      repaired: false,
    })
    expect(h.clients.authenticate(body.credential)).toMatchObject({
      clientId: body.clientId,
      kind: 'paired',
      label: 'Phone',
      capabilities: ['read', 'operate'],
    })
    expect(h.audit.query({ type: 'pairing.exchanged' })).toEqual([
      expect.objectContaining({ clientId: body.clientId }),
    ])
    expect(h.audit.query({ type: 'token.issued', clientId: body.clientId })).toHaveLength(1)
  })

  it('names the device from its own suggestion, or a default, when the link has no label', async () => {
    const h = await harness()
    const suggested = await h.exchange({ token: tokenOf(h.create(['read'])), label: ' Laptop ' })
    expect(suggested.body).toMatchObject({ clientLabel: 'Laptop' })
    const unnamed = await h.exchange({ token: tokenOf(h.create(['read'])) })
    expect(unnamed.body).toMatchObject({ clientLabel: DEFAULT_PAIRED_LABEL })
  })

  it('accepts a token typed in any case with dashes', async () => {
    const h = await harness()
    const token = tokenOf(h.create(['read']))
    const typed = `${token.slice(0, 4)}-${token.slice(4, 8)} ${token.slice(8)}`.toLowerCase()
    expect((await h.exchange({ token: typed })).status).toBe(200)
  })

  it('is single use, even for two exchanges racing each other', async () => {
    const h = await harness()
    const token = tokenOf(h.create(['read']))
    const results = await Promise.all([h.exchange({ token }), h.exchange({ token })])
    expect(results.map((result) => result.status).sort()).toEqual([200, 401])
    const again = await h.exchange({ token })
    expect(again.status).toBe(401)
    expect(reasonOf(again)).toBe('used')
    expect(h.audit.query({ type: 'pairing.rejected' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ details: expect.objectContaining({ reason: 'used' }) }),
      ]),
    )
  })

  it('fails once the link has expired', async () => {
    const h = await harness()
    const token = tokenOf(h.create(['read']))
    h.clock.now += PAIRING_LINK_LIFETIME_MS
    const result = await h.exchange({ token })
    expect(result.status).toBe(401)
    expect(reasonOf(result)).toBe('expired')
  })

  it('reads an unknown token the same as a withdrawn one', async () => {
    const h = await harness()
    const result = await h.exchange({ token: 'ABCDEFGHJKLM' })
    expect(result.status).toBe(401)
    expect(reasonOf(result)).toBe('invalid')
  })

  it('grants a subset when asked, and refuses a superset of the link', async () => {
    const h = await harness()
    const subset = await h.exchange({
      token: tokenOf(h.create(['read', 'operate'])),
      capabilities: ['read'],
    })
    expect(subset.body).toMatchObject({ grant: ['read'] })

    const token = tokenOf(h.create(['read']))
    const superset = await h.exchange({ token, capabilities: ['read', 'agent'] })
    expect(superset.status).toBe(400)
    expect(reasonOf(superset)).toBe('grant_exceeds_link')
    // A refused request does not use the link up.
    expect((await h.exchange({ token })).status).toBe(200)
  })

  it('voids the links of a creator that was revoked since', async () => {
    const h = await harness()
    const admin = h.clients.issue({
      label: 'Tablet',
      kind: 'paired',
      capabilities: ['read', 'operate', 'admin'],
    })
    const token = tokenOf(h.create(['read', 'operate'], { clientId: admin.client.clientId }))
    h.clients.revoke(admin.client.clientId)
    const result = await h.exchange({ token })
    expect(result.status).toBe(401)
    expect(reasonOf(result)).toBe('creator_revoked')
  })

  it('narrows a link to what its creator still holds at exchange time', async () => {
    const h = await harness()
    const admin = h.clients.issue({
      label: 'Tablet',
      kind: 'paired',
      capabilities: ['read', 'operate', 'admin'],
    })
    const token = tokenOf(h.create(['read', 'operate'], { clientId: admin.client.clientId }))
    const raw = new DatabaseSync(join(h.dataDir, DATABASE_FILENAME))
    raw
      .prepare('UPDATE authorized_clients SET scopes_json = ? WHERE client_id = ?')
      .run(JSON.stringify(['read', 'admin']), admin.client.clientId)
    raw.close()
    expect((await h.exchange({ token })).body).toMatchObject({ grant: ['read'] })
  })

  it('refuses malformed, oversized and non-POST requests', async () => {
    const h = await harness()
    const notJson = await h.exchange('not json')
    expect(notJson.status).toBe(400)
    expect(reasonOf(notJson)).toBe('malformed')
    const badToken = await h.exchange({ token: 'O0O0O0O0O0O0' })
    expect(badToken.status).toBe(400)
    const extra = await h.exchange({ token: 'ABCDEFGHJKLM', surprise: true })
    expect(extra.status).toBe(400)

    const oversized = await fetch(`${h.url}${PAIRING_EXCHANGE_PATH}`, {
      method: 'POST',
      body: 'x'.repeat(PAIRING_EXCHANGE_MAX_BYTES + 1),
    })
    expect(oversized.status).toBe(413)
    const get = await fetch(`${h.url}${PAIRING_EXCHANGE_PATH}`)
    expect(get.status).toBe(405)
    const preflight = await fetch(`${h.url}${PAIRING_EXCHANGE_PATH}`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST')
  })

  it('limits attempts per address, counting good and bad alike', async () => {
    const h = await harness()
    const limit = RATE_LIMITS.pairing.limit
    for (let i = 0; i < limit; i++) await h.exchange({ token: 'ABCDEFGHJKLM' })
    const token = tokenOf(h.create(['read']))
    const blocked = await h.exchange({ token })
    expect(blocked.status).toBe(429)
    expect(h.audit.query({ type: 'rate_limited' })).toHaveLength(1)
    h.clock.now += RATE_LIMITS.pairing.windowMs
    expect((await h.exchange({ token })).status).toBe(200)
  })
})

describe('re-pairing a device that is already paired', () => {
  it('keeps the same identity and credential, and takes the new link grant', async () => {
    const h = await harness()
    const first = PairingExchangeResponseSchema.parse(
      (await h.exchange({ token: tokenOf(h.create(['read', 'operate'], { label: 'Phone' })) }))
        .body,
    )
    h.clock.now += 60_000
    const token = tokenOf(h.create(['read'], { label: 'Something else' }))
    const again = PairingExchangeResponseSchema.parse(
      (await h.exchange({ token, credential: first.credential })).body,
    )
    expect(again).toMatchObject({
      clientId: first.clientId,
      credential: first.credential,
      clientLabel: 'Phone',
      grant: ['read'],
      repaired: true,
    })
    expect(h.regranted).toEqual([first.clientId])
    expect(h.clients.authenticate(first.credential)?.capabilities).toEqual(['read'])
    expect(h.audit.query({ type: 'token.issued', clientId: first.clientId })).toHaveLength(1)

    const raw = new DatabaseSync(join(h.dataDir, DATABASE_FILENAME))
    try {
      expect(
        raw.prepare("SELECT count(*) AS count FROM authorized_clients WHERE kind = 'paired'").get(),
      ).toEqual({ count: 1 })
      expect(
        raw
          .prepare('SELECT consumed_by_client_id FROM pairing_links WHERE consumed_at IS NOT NULL')
          .all(),
      ).toEqual([
        { consumed_by_client_id: first.clientId },
        { consumed_by_client_id: first.clientId },
      ])
    } finally {
      raw.close()
    }
  })

  it('does not reconnect the device when the grant is unchanged', async () => {
    const h = await harness()
    const first = PairingExchangeResponseSchema.parse(
      (await h.exchange({ token: tokenOf(h.create(['read'])) })).body,
    )
    await h.exchange({ token: tokenOf(h.create(['read'])), credential: first.credential })
    expect(h.regranted).toEqual([])
  })

  it('pairs a device whose old credential was revoked as a new client', async () => {
    const h = await harness()
    const first = PairingExchangeResponseSchema.parse(
      (await h.exchange({ token: tokenOf(h.create(['read'])) })).body,
    )
    h.clients.revoke(first.clientId)
    const again = PairingExchangeResponseSchema.parse(
      (await h.exchange({ token: tokenOf(h.create(['read'])), credential: first.credential })).body,
    )
    expect(again.repaired).toBe(false)
    expect(again.clientId).not.toBe(first.clientId)
    expect(again.credential).not.toBe(first.credential)
  })

  it('refuses to turn the owner into a paired client, and leaves the link usable', async () => {
    const h = await harness()
    const token = tokenOf(h.create(['read']))
    const owner = h.clients.publishedOwner()!
    const result = await h.exchange({ token, credential: owner })
    expect(result.status).toBe(409)
    expect(reasonOf(result)).toBe('already_authorized')
    expect(h.clients.authenticate(owner)?.kind).toBe('owner')
    expect((await h.exchange({ token })).status).toBe(200)
  })
})

describe('pairing through the environment server', () => {
  it('advertises the exchange and runs create, exchange and connect end to end', async () => {
    const host = await startProtocolHost()
    const bootstrap = (await (await fetch(`${host.server.url}/bootstrap`)).json()) as {
      capabilities: string[]
    }
    expect(bootstrap.capabilities).toEqual(
      expect.arrayContaining([
        'pairing.create',
        'pairing.list',
        'pairing.revoke',
        PAIRING_EXCHANGE_CAPABILITY,
      ]),
    )

    const owner = await connectProtocol(host)
    await handshake(owner)
    const createId = owner.command('pairing.create', { capabilities: ['read'], label: 'Phone' })
    const { token } = PairingResponseSchemas['pairing.create'].parse(
      await nextResponse(owner, createId),
    ).payload

    const exchanged = await fetch(`${host.server.url}${PAIRING_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    expect(exchanged.status).toBe(200)
    const paired = PairingExchangeResponseSchema.parse(await exchanged.json())
    expect(paired.environmentId).toBe(host.server.identity.environmentId)

    const phone = await connectProtocol({ ...host, token: paired.credential })
    await handshake(phone)
    // `read` only: the phone can look but cannot hand out access.
    const listId = phone.command('session.list', {})
    expect(await nextResponse(phone, listId)).toMatchObject({ type: 'response' })
    const denied = phone.command('pairing.create', { capabilities: ['read'] })
    expect(await nextResponse(phone, denied)).toMatchObject({
      type: 'error',
      error: { code: 'capability_missing', details: { requiredCapability: 'admin' } },
    })

    // Re-pairing with a wider grant reconnects the phone so the grant applies.
    const wider = owner.command('pairing.create', { capabilities: ['read', 'operate'] })
    const second = PairingResponseSchemas['pairing.create'].parse(await nextResponse(owner, wider))
      .payload.token
    const closed = once(phone.ws, 'close')
    const repaired = await fetch(`${host.server.url}${PAIRING_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: second, credential: paired.credential }),
    })
    expect(await repaired.json()).toMatchObject({ repaired: true, grant: ['read', 'operate'] })
    const [code] = (await closed) as [number]
    expect(code).toBe(GRANT_CHANGED_CLOSE_CODE)
  })

  it('refuses the exchange from an origin that is not allowed', async () => {
    const host = await startProtocolHost()
    const response = await fetch(`${host.server.url}${PAIRING_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ token: 'ABCDEFGHJKLM' }),
    })
    expect(response.status).toBe(403)
  })
})
