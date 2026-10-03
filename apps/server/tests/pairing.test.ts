import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PAIRING_EXCHANGE_CAPABILITY,
  PAIRING_EXCHANGE_PATH,
  PAIRING_LINK_LIFETIME_MS,
  PAIRING_LIST_HISTORY_MS,
  PAIRING_PENDING_LINKS_MAX,
  PAIRING_TOKEN_ALPHABET,
  PairingExchangeResponseSchema,
  PairingResponseSchemas,
  type AccessCapability,
  type CommandEnvelope,
  type PairingLink,
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
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

const directories: string[] = []
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await cleanupProtocolHosts()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

type Reply = { type: 'response' | 'error' } & Record<string, unknown>

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
  list: () => PairingLink[]
  revoke: (linkId: string, clientId?: string) => Reply
  redeem: (clientId: string, payload: Record<string, unknown>) => Reply
  exchange: (body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>
  sql: (statement: string, ...params: (string | number | null)[]) => unknown
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
  const dispatch = (name: string, payload: unknown, clientId: string) =>
    pairing.dispatch(
      {
        type: 'command',
        requestId: `req-${++requests}`,
        name,
        payload: payload as CommandEnvelope['payload'],
      },
      { clientId, command: name },
    ) as Reply
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
      const result = dispatch(
        'pairing.create',
        { capabilities, ...(options.label !== undefined ? { label: options.label } : {}) },
        options.clientId ?? owner.clientId,
      )
      return { status: result.type, body: result }
    },
    list: () =>
      PairingResponseSchemas['pairing.list'].parse(dispatch('pairing.list', null, owner.clientId))
        .payload.links,
    revoke: (linkId, clientId = owner.clientId) => dispatch('pairing.revoke', { linkId }, clientId),
    redeem: (clientId, payload) => dispatch('pairing.redeem', payload, clientId),
    async exchange(body) {
      const response = await fetch(`${url}${PAIRING_EXCHANGE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    },
    sql(statement, ...params) {
      const raw = new DatabaseSync(join(dataDir, DATABASE_FILENAME))
      try {
        const prepared = raw.prepare(statement)
        return /^\s*select/i.test(statement) ? prepared.all(...params) : prepared.run(...params)
      } finally {
        raw.close()
      }
    },
  }
}

function tokenOf(created: { body: Record<string, unknown> }): string {
  return PairingResponseSchemas['pairing.create'].parse(created.body).payload.token
}

function reasonOf(reply: object): unknown {
  const result = reply as { body?: Record<string, unknown>; error?: unknown }
  const error = (result.body?.error ?? result.error) as
    { details?: { reason?: unknown } } | undefined
  return error?.details?.reason
}

async function pairedDevice(h: Harness, capabilities: AccessCapability[] = ['read']) {
  const result = await h.exchange({ token: tokenOf(h.create(capabilities, { label: 'Phone' })) })
  return PairingExchangeResponseSchema.parse(result.body)
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
      status: 'waiting',
      usedByClientId: null,
    })
    expect(Date.parse(link.expiresAt) - Date.parse(link.createdAt)).toBe(PAIRING_LINK_LIFETIME_MS)

    const [row] = h.sql('SELECT * FROM pairing_links') as Record<string, unknown>[]
    expect(JSON.stringify(row)).not.toContain(token)
    expect(row!.token_hash).toBeInstanceOf(Uint8Array)
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

  it('refuses a creator whose own access ended since its socket opened', async () => {
    const h = await harness()
    const tablet = h.clients.issue({
      label: 'Tablet',
      kind: 'paired',
      capabilities: ['read', 'admin'],
    })
    h.clients.revoke(tablet.client.clientId)
    expect(h.create(['read'], { clientId: tablet.client.clientId }).body).toMatchObject({
      type: 'error',
      error: { code: 'auth' },
    })
  })

  it('caps how many links can wait at once, and expired ones stop counting', async () => {
    const h = await harness()
    for (let i = 0; i < PAIRING_PENDING_LINKS_MAX; i++)
      expect(h.create(['read']).status).toBe('response')
    expect(h.create(['read']).body).toMatchObject({ error: { code: 'conflict' } })
    h.clock.now += PAIRING_LINK_LIFETIME_MS
    expect(h.create(['read']).status).toBe('response')
  })

  it('does not let a revoked creator’s links hold places under the cap', async () => {
    const h = await harness()
    const lost = h.clients.issue({
      label: 'Lost phone',
      kind: 'paired',
      capabilities: ['read', 'admin'],
    })
    for (let i = 0; i < PAIRING_PENDING_LINKS_MAX; i++) {
      expect(h.create(['read'], { clientId: lost.client.clientId }).status).toBe('response')
    }
    expect(h.create(['read']).body).toMatchObject({ error: { code: 'conflict' } })
    h.clients.revoke(lost.client.clientId)
    expect(h.create(['read']).status).toBe('response')
    expect(h.list().filter((link) => link.status === 'void')).toHaveLength(
      PAIRING_PENDING_LINKS_MAX,
    )
  })
})

describe('listing and withdrawing links', () => {
  it('reports what became of each recent link, and who used it', async () => {
    const h = await harness()
    const waiting = PairingResponseSchemas['pairing.create'].parse(h.create(['read']).body).payload
    const used = PairingResponseSchemas['pairing.create'].parse(h.create(['read']).body).payload
    const withdrawn = PairingResponseSchemas['pairing.create'].parse(
      h.create(['read']).body,
    ).payload
    const device = PairingExchangeResponseSchema.parse(
      (await h.exchange({ token: used.token })).body,
    )
    h.revoke(withdrawn.link.linkId)

    const byId = new Map(h.list().map((link) => [link.linkId, link]))
    expect(byId.get(waiting.link.linkId)).toMatchObject({ status: 'waiting', usedByClientId: null })
    expect(byId.get(used.link.linkId)).toMatchObject({
      status: 'used',
      usedByClientId: device.clientId,
      usedAt: new Date(h.clock.now).toISOString(),
    })
    expect(byId.get(withdrawn.link.linkId)).toMatchObject({ status: 'revoked' })

    h.clock.now += PAIRING_LINK_LIFETIME_MS
    expect(h.list().find((link) => link.linkId === waiting.link.linkId)?.status).toBe('expired')
    h.clock.now += PAIRING_LIST_HISTORY_MS
    expect(h.list()).toEqual([])
  })

  it('always lists a link that can still be used, however much history follows it', async () => {
    const h = await harness()
    const waiting = PairingResponseSchemas['pairing.create'].parse(h.create(['read']).body).payload
    for (let i = 0; i < 200; i++) {
      h.clock.now += 1
      const later = PairingResponseSchemas['pairing.create'].parse(h.create(['read']).body).payload
      h.revoke(later.link.linkId)
    }
    const links = h.list()
    expect(links).toHaveLength(200)
    expect(links[0]).toMatchObject({ linkId: waiting.link.linkId, status: 'waiting' })
    expect(links.slice(1).every((link) => link.status === 'revoked')).toBe(true)
  })

  it('withdraws a waiting link once, and only a waiting one', async () => {
    const h = await harness()
    const first = PairingResponseSchemas['pairing.create'].parse(h.create(['read']).body).payload
    const second = PairingResponseSchemas['pairing.create'].parse(h.create(['read']).body).payload
    await h.exchange({ token: second.token })

    expect(h.revoke(first.link.linkId)).toMatchObject({
      type: 'response',
      payload: { linkId: first.link.linkId },
    })
    expect(h.revoke(first.link.linkId)).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
    expect(h.revoke(second.link.linkId)).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
    expect(h.audit.query({ type: 'pairing.revoked' })).toEqual([
      expect.objectContaining({ clientId: h.ownerId }),
    ])

    const result = await h.exchange({ token: first.token })
    expect(result.status).toBe(401)
    expect(reasonOf(result)).toBe('invalid')
  })
})

describe('exchanging a pairing link at POST /pair', () => {
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
    })
    expect(h.clients.authenticate(body.credential)).toMatchObject({
      clientId: body.clientId,
      kind: 'paired',
      label: 'Phone',
      capabilities: ['read', 'operate'],
    })
    expect(h.audit.query({ type: 'pairing.exchanged' })).toEqual([
      expect.objectContaining({
        clientId: body.clientId,
        details: expect.objectContaining({ existingClient: false }),
      }),
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

  it('refuses labels with control or bidi format characters', async () => {
    const h = await harness()
    const token = tokenOf(h.create(['read']))
    expect((await h.exchange({ token, label: 'Phone‮enod' })).status).toBe(400)
    expect(h.create(['read'], { label: 'Lap​top' }).body).toMatchObject({
      error: { code: 'validation' },
    })
  })

  it('accepts a token typed in any case with dashes', async () => {
    const h = await harness()
    const token = tokenOf(h.create(['read']))
    const typed = `${token.slice(0, 4)}-${token.slice(4, 8)} ${token.slice(8)}`.toLowerCase()
    expect((await h.exchange({ token: typed })).status).toBe(200)
  })

  it('never takes a credential: a body carrying one is refused', async () => {
    const h = await harness()
    const token = tokenOf(h.create(['read']))
    const result = await h.exchange({ token, credential: h.clients.publishedOwner() })
    expect(result.status).toBe(400)
    expect(reasonOf(result)).toBe('malformed')
    expect((await h.exchange({ token })).status).toBe(200)
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

  it('voids the links of a creator that idled out since', async () => {
    const h = await harness()
    const admin = h.clients.issue({
      label: 'Tablet',
      kind: 'paired',
      capabilities: ['read', 'admin'],
    })
    const token = tokenOf(h.create(['read'], { clientId: admin.client.clientId }))
    h.sql(
      'UPDATE authorized_clients SET expires_at = ? WHERE client_id = ?',
      h.clock.now,
      admin.client.clientId,
    )
    expect(reasonOf(await h.exchange({ token }))).toBe('creator_revoked')
  })

  it('narrows a link to what its creator still holds at exchange time', async () => {
    const h = await harness()
    const admin = h.clients.issue({
      label: 'Tablet',
      kind: 'paired',
      capabilities: ['read', 'operate', 'admin'],
    })
    const token = tokenOf(h.create(['read', 'operate'], { clientId: admin.client.clientId }))
    h.sql(
      'UPDATE authorized_clients SET scopes_json = ? WHERE client_id = ?',
      JSON.stringify(['read', 'admin']),
      admin.client.clientId,
    )
    expect((await h.exchange({ token })).body).toMatchObject({ grant: ['read'] })
  })

  it('leaves the link unused when minting the client fails', async () => {
    const h = await harness()
    const token = tokenOf(h.create(['read']))
    h.sql(`
      CREATE TRIGGER refuse_paired BEFORE INSERT ON authorized_clients
      WHEN NEW.kind = 'paired' BEGIN SELECT RAISE(ABORT, 'refused'); END
    `)
    expect((await h.exchange({ token })).status).toBe(500)
    h.sql('DROP TRIGGER refuse_paired')
    expect((await h.exchange({ token })).status).toBe(200)
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

    h.rateLimiter.reset()
    const oversized = await fetch(`${h.url}${PAIRING_EXCHANGE_PATH}`, {
      method: 'POST',
      body: 'x'.repeat(PAIRING_EXCHANGE_MAX_BYTES + 1),
    })
    expect(oversized.status).toBe(413)
    expect(reasonOf({ body: (await oversized.json()) as Record<string, unknown> })).toBe(
      'malformed',
    )
    const get = await fetch(`${h.url}${PAIRING_EXCHANGE_PATH}`)
    expect(get.status).toBe(405)
    const preflight = await fetch(`${h.url}${PAIRING_EXCHANGE_PATH}`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST')
  })

  it('counts oversized requests against the limit like any other refusal', async () => {
    const h = await harness()
    const oversized = () =>
      fetch(`${h.url}${PAIRING_EXCHANGE_PATH}`, {
        method: 'POST',
        body: 'x'.repeat(PAIRING_EXCHANGE_MAX_BYTES + 1),
      })
    for (let i = 0; i < RATE_LIMITS.pairing.limit; i++) {
      expect((await oversized()).status).toBe(413)
    }
    expect((await oversized()).status).toBe(429)
    expect((await h.exchange({ token: tokenOf(h.create(['read'])) })).status).toBe(429)
  })

  it('limits failed attempts per address; successful ones do not count', async () => {
    const h = await harness()
    for (let i = 0; i < 2 * RATE_LIMITS.pairing.limit; i++) {
      expect((await h.exchange({ token: tokenOf(h.create(['read'])) })).status).toBe(200)
    }
    for (let i = 0; i < RATE_LIMITS.pairing.limit; i++) {
      await h.exchange({ token: 'ABCDEFGHJKLM' })
    }
    const token = tokenOf(h.create(['read']))
    const blocked = await h.exchange({ token })
    expect(blocked.status).toBe(429)
    expect(h.audit.query({ type: 'rate_limited' })).toHaveLength(1)
    h.clock.now += RATE_LIMITS.pairing.windowMs
    expect((await h.exchange({ token })).status).toBe(200)
  })

  it.each([
    ['bad tokens', '"ABCDEFGHJKLM"}', 401],
    ['oversized bodies', 'x'.repeat(PAIRING_EXCHANGE_MAX_BYTES), 413],
  ])('counts failures among requests held open together: %s', async (_, rest, refused) => {
    const h = await harness()
    const { limit } = RATE_LIMITS.pairing
    const held = Array.from({ length: 2 * limit }, () => {
      const request = httpRequest(`${h.url}${PAIRING_EXCHANGE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      const status = new Promise<number>((resolve, reject) => {
        request.on('response', (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        request.on('error', reject)
      })
      request.write('{"token":')
      return { request, status }
    })
    // Every request is past the first check before any body completes.
    await new Promise((resolve) => setTimeout(resolve, 100))
    for (const { request } of held) request.end(rest)
    const statuses = await Promise.all(held.map(({ status }) => status))
    expect(statuses.filter((status) => status === refused)).toHaveLength(limit)
    expect(statuses.filter((status) => status === 429)).toHaveLength(limit)
  })
})

describe('redeeming a link as a device that is already paired', () => {
  it('keeps its identity, label and credential, and takes the link grant', async () => {
    const h = await harness()
    const device = await pairedDevice(h, ['read', 'operate'])
    const token = tokenOf(h.create(['read'], { label: 'Something else' }))
    const reply = h.redeem(device.clientId, { token })
    expect(PairingResponseSchemas['pairing.redeem'].parse(reply).payload).toEqual({
      clientId: device.clientId,
      clientLabel: 'Phone',
      grant: ['read'],
      grantChanged: true,
    })
    // Its sockets are told as the redeem commits, before the response is
    // sent, so nothing batched behind the redeem runs under the old grant.
    expect(h.regranted).toEqual([device.clientId])
    expect(h.clients.authenticate(device.credential)?.capabilities).toEqual(['read'])
    expect(h.audit.query({ type: 'token.issued', clientId: device.clientId })).toHaveLength(1)
    expect(h.sql("SELECT count(*) AS count FROM authorized_clients WHERE kind = 'paired'")).toEqual(
      [{ count: 1 }],
    )
    expect(
      h.list().find((link) => link.status === 'used' && link.label === 'Something else'),
    ).toMatchObject({ usedByClientId: device.clientId })
  })

  it('does not reconnect the device when the grant is unchanged', async () => {
    const h = await harness()
    const device = await pairedDevice(h)
    const reply = h.redeem(device.clientId, { token: tokenOf(h.create(['read'])) })
    expect(reply).toMatchObject({ type: 'response', payload: { grantChanged: false } })
    await tick()
    expect(h.regranted).toEqual([])
  })

  it('keeps a stored label that predates the label rules', async () => {
    const h = await harness()
    // `clients.issue` only trims and bounds a label; a newline gets through.
    const device = h.clients.issue({
      label: 'Phone\nAndroid',
      kind: 'paired',
      capabilities: ['read'],
    })
    const reply = h.redeem(device.client.clientId, {
      token: tokenOf(h.create(['read', 'operate'])),
    })
    expect(reply).toMatchObject({
      type: 'response',
      payload: { clientLabel: 'Phone\nAndroid', grant: ['read', 'operate'] },
    })
  })

  it('refuses the owner and an account-enrolled device, and leaves the link usable', async () => {
    const h = await harness()
    const token = tokenOf(h.create(['read']))
    const owner = h.redeem(h.ownerId, { token })
    expect(owner).toMatchObject({ type: 'error', error: { code: 'conflict' } })
    expect(reasonOf(owner)).toBe('already_authorized')
    const cloud = h.clients.issue({ label: 'Account phone', kind: 'cloud', capabilities: ['read'] })
    expect(reasonOf(h.redeem(cloud.client.clientId, { token }))).toBe('already_authorized')
    expect(h.clients.authenticate(h.clients.publishedOwner())?.kind).toBe('owner')
    expect((await h.exchange({ token })).status).toBe(200)
  })

  it('applies the same refusals as the exchange, and rate-limits per client', async () => {
    const h = await harness()
    const device = await pairedDevice(h)
    const { link, token } = PairingResponseSchemas['pairing.create'].parse(
      h.create(['read']).body,
    ).payload
    h.revoke(link.linkId)
    expect(reasonOf(h.redeem(device.clientId, { token }))).toBe('invalid')
    expect(reasonOf(h.redeem(device.clientId, { token: 'nope' }))).toBe('malformed')
    for (let i = 2; i < RATE_LIMITS.pairing.limit; i++) h.redeem(device.clientId, { token })
    expect(h.redeem(device.clientId, { token: tokenOf(h.create(['read'])) })).toMatchObject({
      type: 'error',
      error: { code: 'unavailable' },
    })
    // Another client is not affected.
    const other = await pairedDevice(h)
    expect(h.redeem(other.clientId, { token: tokenOf(h.create(['read'])) }).type).toBe('response')
  })
})

describe('pairing through the environment server', () => {
  it('advertises pairing and runs create, exchange, connect and redeem end to end', async () => {
    const host = await startProtocolHost({ allowedOrigins: ['https://app.example'] })
    const bootstrap = (await (await fetch(`${host.server.url}/bootstrap`)).json()) as {
      capabilities: string[]
    }
    expect(bootstrap.capabilities).toEqual(
      expect.arrayContaining([
        'pairing.create',
        'pairing.list',
        'pairing.revoke',
        'pairing.redeem',
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
      headers: { 'content-type': 'application/json', origin: 'https://app.example' },
      body: JSON.stringify({ token }),
    })
    expect(exchanged.status).toBe(200)
    expect(exchanged.headers.get('access-control-allow-origin')).toBe('https://app.example')
    const paired = PairingExchangeResponseSchema.parse(await exchanged.json())
    expect(paired.environmentId).toBe(host.server.identity.environmentId)

    const phone = await connectProtocol({ ...host, token: paired.credential })
    await handshake(phone)
    // `read` only: the phone can look but cannot hand out or see access.
    const listId = phone.command('session.list', {})
    expect(await nextResponse(phone, listId)).toMatchObject({ type: 'response' })
    for (const [name, payload] of [
      ['pairing.create', { capabilities: ['read'] }],
      ['pairing.list', null],
      ['pairing.revoke', { linkId: 'x' }],
    ] as const) {
      const id = phone.command(name, payload)
      expect(await nextResponse(phone, id)).toMatchObject({
        type: 'error',
        error: { code: 'capability_missing', details: { requiredCapability: 'admin' } },
      })
    }

    // Redeeming a wider link over its own socket: the response arrives, then
    // the socket closes so the phone reconnects under the new grant.
    const wider = owner.command('pairing.create', { capabilities: ['read', 'operate'] })
    const second = PairingResponseSchemas['pairing.create'].parse(await nextResponse(owner, wider))
      .payload.token
    const closed = once(phone.ws, 'close')
    const redeemId = phone.command('pairing.redeem', { token: second })
    expect(await nextResponse(phone, redeemId)).toMatchObject({
      type: 'response',
      payload: { clientId: paired.clientId, grant: ['read', 'operate'], grantChanged: true },
    })
    const [code] = (await closed) as [number]
    expect(code).toBe(GRANT_CHANGED_CLOSE_CODE)

    const again = await connectProtocol({ ...host, token: paired.credential })
    await handshake(again)
    const browse = again.command('workspace.add', { path: host.workspaceRoot })
    expect(await nextResponse(again, browse)).not.toMatchObject({
      error: { code: 'capability_missing' },
    })

    // A downgrade with a privileged frame right behind it, in one write: the
    // second frame is refused, not served under the grant the redeem replaced.
    const narrower = owner.command('pairing.create', { capabilities: ['read'] })
    const third = PairingResponseSchemas['pairing.create'].parse(
      await nextResponse(owner, narrower),
    ).payload.token
    const socket = (again.ws as unknown as { _socket: Socket })._socket
    const reclosed = once(again.ws, 'close')
    socket.cork()
    const downgradeId = again.command('pairing.redeem', { token: third })
    const behindId = again.command('workspace.remove', { workspaceId: 'any' })
    socket.uncork()
    expect(await nextResponse(again, downgradeId)).toMatchObject({
      type: 'response',
      payload: { grant: ['read'], grantChanged: true },
    })
    expect(await nextResponse(again, behindId)).toMatchObject({
      type: 'error',
      error: { code: 'auth' },
    })
    expect(((await reclosed) as [number])[0]).toBe(GRANT_CHANGED_CLOSE_CODE)
  })

  it('answers a command whose service throws and keeps serving the socket', async () => {
    const host = await startProtocolHost()
    const owner = await connectProtocol(host)
    await handshake(owner)
    const spy = vi.spyOn(host.server.pairing, 'dispatch').mockImplementationOnce(() => {
      throw new Error('database is locked')
    })
    const failing = owner.command('pairing.list', null)
    expect(await nextResponse(owner, failing)).toMatchObject({
      type: 'error',
      error: { code: 'internal' },
    })
    spy.mockRestore()
    const listed = owner.command('pairing.list', null)
    expect(await nextResponse(owner, listed)).toMatchObject({ type: 'response' })
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
