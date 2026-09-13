import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuditEvent } from '../src/audit.js'
import { OWNER_GRANT } from '../src/authorized-clients.js'
import {
  evaluateLocalOwnerAccess,
  LOCAL_OWNER_CLAIM_HEADER,
  isFirstPartyLoopbackOrigin,
  isLoopbackHostHeader,
  isLoopbackRemoteAddress,
  LOCAL_OWNER_PATH,
} from '../src/local-owner.js'
import { RATE_LIMITS } from '../src/rate-limit.js'
import { startServer } from '../src/server.js'

const LOCAL_OWNER_CLAIM_KEY = 'L'.repeat(43)

/** fetch strips a caller-supplied Host header, so host policy tests go through node:http. */
async function get(port: number, path: string, headers: Record<string, string>) {
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port, path, headers }, resolve).on('error', reject).end()
  })
  let body = ''
  for await (const chunk of response) body += String(chunk)
  return { status: response.statusCode, headers: response.headers, body }
}

const directories: string[] = []
const servers: Awaited<ReturnType<typeof startServer>>[] = []
async function dataDir() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-local-owner-'))
  directories.push(directory)
  return join(directory, 'data')
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('local owner access helpers', () => {
  it('accepts only loopback remotes, bound loopback hosts, and first-party loopback origins', () => {
    expect(isLoopbackRemoteAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackRemoteAddress('::1')).toBe(true)
    expect(isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackRemoteAddress('203.0.113.7')).toBe(false)
    expect(isLoopbackRemoteAddress(undefined)).toBe(false)

    expect(isLoopbackHostHeader('127.0.0.1:43120', 43120)).toBe(true)
    expect(isLoopbackHostHeader('localhost:43120', 43120)).toBe(true)
    expect(isLoopbackHostHeader('LOCALHOST:43120', 43120)).toBe(true)
    expect(isLoopbackHostHeader('[::1]:43120', 43120)).toBe(true)
    expect(isLoopbackHostHeader('tunnel.example', 43120)).toBe(false)
    expect(isLoopbackHostHeader('127.0.0.1:9', 43120)).toBe(false)

    expect(isFirstPartyLoopbackOrigin('http://localhost:5173')).toBe(true)
    expect(isFirstPartyLoopbackOrigin('http://127.0.0.1:5173')).toBe(true)
    expect(isFirstPartyLoopbackOrigin('https://localhost')).toBe(true)
    expect(isFirstPartyLoopbackOrigin('https://app.example')).toBe(false)
    expect(isFirstPartyLoopbackOrigin('http://localhost:5173.attacker.example')).toBe(false)
    expect(isFirstPartyLoopbackOrigin(undefined)).toBe(false)
    expect(isFirstPartyLoopbackOrigin('null')).toBe(false)
  })

  it('hides the route from tunnel hosts and refuses missing or hosted origins', () => {
    const loopback = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        host: '127.0.0.1:43120',
        origin: 'http://localhost:5173',
        [LOCAL_OWNER_CLAIM_HEADER]: LOCAL_OWNER_CLAIM_KEY,
      },
    }
    expect(evaluateLocalOwnerAccess(loopback as never, 43120, LOCAL_OWNER_CLAIM_KEY)).toBe('ok')
    expect(
      evaluateLocalOwnerAccess(
        { ...loopback, headers: { host: 'tunnel.example', origin: 'http://localhost:5173' } } as never,
        43120,
        LOCAL_OWNER_CLAIM_KEY,
      ),
    ).toBe('not_found')
    expect(
      evaluateLocalOwnerAccess(
        { ...loopback, headers: { host: '127.0.0.1:43120' } } as never,
        43120,
        LOCAL_OWNER_CLAIM_KEY,
      ),
    ).toBe('forbidden')
    expect(
      evaluateLocalOwnerAccess(
        {
          ...loopback,
          headers: { host: '127.0.0.1:43120', origin: 'https://app.example' },
        } as never,
        43120,
        LOCAL_OWNER_CLAIM_KEY,
      ),
    ).toBe('forbidden')
    expect(
      evaluateLocalOwnerAccess(
        {
          ...loopback,
          headers: {
            host: '127.0.0.1:43120',
            origin: 'http://localhost:5173',
            'x-forwarded-for': '203.0.113.7',
          },
        } as never,
        43120,
        LOCAL_OWNER_CLAIM_KEY,
      ),
    ).toBe('not_found')
    expect(
      evaluateLocalOwnerAccess(
        {
          ...loopback,
          headers: { host: '127.0.0.1:43120', origin: 'http://localhost:5173' },
        } as never,
        43120,
        LOCAL_OWNER_CLAIM_KEY,
      ),
    ).toBe('not_found')
  })
})

describe('GET /local-owner', () => {
  it('issues the published owner credential to a first-party loopback origin', async () => {
    const directory = await dataDir()
    const server = await startServer({
      port: 0,
      dataDir: directory,
      logLevel: 'silent',
      allowedOrigins: ['http://localhost:5173'],
      localOwnerClaimKey: LOCAL_OWNER_CLAIM_KEY,
    })
    servers.push(server)
    const audits: AuditEvent[] = []
    server.audit.subscribe((event) => audits.push(event))
    const published = (await readFile(join(directory, 'owner-credential'), 'utf8')).trim()

    const preflight = await fetch(`${server.url}${LOCAL_OWNER_PATH}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': LOCAL_OWNER_CLAIM_HEADER,
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toBe(LOCAL_OWNER_CLAIM_HEADER)

    const claimed = await fetch(`${server.url}${LOCAL_OWNER_PATH}`, {
      headers: {
        origin: 'http://localhost:5173',
        [LOCAL_OWNER_CLAIM_HEADER]: LOCAL_OWNER_CLAIM_KEY,
      },
    })
    expect(claimed.status).toBe(200)
    expect(claimed.headers.get('cache-control')).toBe('no-store')
    expect(claimed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(await claimed.json()).toEqual({
      environmentId: server.identity.environmentId,
      label: server.identity.label,
      kind: 'owner',
      grant: [...OWNER_GRANT],
      credential: published,
    })
    expect(audits).toEqual([
      expect.objectContaining({
        type: 'owner.claimed',
        clientId: server.owner.clientId,
        remoteAddress: '127.0.0.1',
        details: { origin: 'http://localhost:5173' },
      }),
    ])

    const discovery = await (await fetch(`${server.url}/bootstrap`)).json()
    expect(JSON.stringify(discovery)).not.toContain(published)
    expect(discovery).not.toHaveProperty('credential')
  })

  it('does not exist on a tunnel host and ignores forwarded headers', async () => {
    const directory = await dataDir()
    const server = await startServer({
      port: 0,
      dataDir: directory,
      logLevel: 'silent',
      allowedOrigins: ['http://localhost:5173', 'https://app.example'],
      allowedHosts: ['tunnel.example'],
      localOwnerClaimKey: LOCAL_OWNER_CLAIM_KEY,
    })
    servers.push(server)
    const published = (await readFile(join(directory, 'owner-credential'), 'utf8')).trim()

    const tunnel = await get(server.port, LOCAL_OWNER_PATH, {
      host: 'tunnel.example',
      origin: 'http://localhost:5173',
      'x-forwarded-host': `127.0.0.1:${server.port}`,
      'x-forwarded-for': '127.0.0.1',
      [LOCAL_OWNER_CLAIM_HEADER]: LOCAL_OWNER_CLAIM_KEY,
    })
    expect(tunnel.status).toBe(404)
    expect(tunnel.body).toBe('Not found\n')
    expect(tunnel.body).not.toContain(published)

    const hosted = await fetch(`${server.url}${LOCAL_OWNER_PATH}`, {
      headers: {
        origin: 'https://app.example',
        [LOCAL_OWNER_CLAIM_HEADER]: LOCAL_OWNER_CLAIM_KEY,
      },
    })
    expect(hosted.status).toBe(403)
    const hostedBody = await hosted.json()
    expect(hostedBody).toMatchObject({ error: { code: 'auth' } })
    expect(JSON.stringify(hostedBody)).not.toContain(published)

    const native = await fetch(`${server.url}${LOCAL_OWNER_PATH}`)
    expect(native.status).toBe(403)
    expect(await native.json()).toMatchObject({ error: { code: 'auth' } })

    const rewritten = await get(server.port, LOCAL_OWNER_PATH, {
      host: `127.0.0.1:${server.port}`,
      origin: 'http://localhost:5173',
      'x-forwarded-for': '203.0.113.7',
      'cf-connecting-ip': '203.0.113.7',
      [LOCAL_OWNER_CLAIM_HEADER]: LOCAL_OWNER_CLAIM_KEY,
    })
    expect(rewritten.status).toBe(404)
    expect(rewritten.body).toBe('Not found\n')
    expect(rewritten.body).not.toContain(published)

    const unmarkedTunnel = await get(server.port, LOCAL_OWNER_PATH, {
      host: `127.0.0.1:${server.port}`,
      origin: 'http://localhost:5173',
    })
    expect(unmarkedTunnel.status).toBe(404)
    expect(unmarkedTunnel.body).not.toContain(published)
  })

  it('rate-limits issuance attempts without serving the credential', async () => {
    const directory = await dataDir()
    const server = await startServer({
      port: 0,
      dataDir: directory,
      logLevel: 'silent',
      allowedOrigins: ['http://localhost:5173'],
      localOwnerClaimKey: LOCAL_OWNER_CLAIM_KEY,
    })
    servers.push(server)
    const published = (await readFile(join(directory, 'owner-credential'), 'utf8')).trim()
    const { limit } = RATE_LIMITS.local_owner
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const response = await fetch(`${server.url}${LOCAL_OWNER_PATH}`, {
        headers: {
          origin: 'http://localhost:5173',
          [LOCAL_OWNER_CLAIM_HEADER]: LOCAL_OWNER_CLAIM_KEY,
        },
      })
      expect(response.status).toBe(200)
    }
    const blocked = await fetch(`${server.url}${LOCAL_OWNER_PATH}`, {
      headers: {
        origin: 'http://localhost:5173',
        [LOCAL_OWNER_CLAIM_HEADER]: LOCAL_OWNER_CLAIM_KEY,
      },
    })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBeTruthy()
    const blockedBody = await blocked.json()
    expect(blockedBody).toMatchObject({ error: { code: 'unavailable' } })
    expect(JSON.stringify(blockedBody)).not.toContain(published)
  })
})

describe('explicit owner remint', () => {
  it('revokes the previous owner and cuts its live sockets', async () => {
    const directory = await dataDir()
    const server = await startServer({
      port: 0,
      dataDir: directory,
      logLevel: 'silent',
      allowedOrigins: ['http://localhost:5173'],
    })
    servers.push(server)
    const previousId = server.owner.clientId
    const previous = (await readFile(join(directory, 'owner-credential'), 'utf8')).trim()
    const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}/ws`, {
      headers: { authorization: `Bearer ${previous}` },
    })
    socket.on('error', () => {})
    await once(socket, 'open')
    const closed = once(socket, 'close')

    const minted = server.remintOwner()
    expect(minted.credential).not.toBe(previous)
    expect(minted.client.clientId).not.toBe(previousId)
    expect(server.owner).toEqual(minted.client)
    const [code, reason] = await closed
    expect(code).toBe(4401)
    expect(String(reason)).toBe('revoked')
    expect(server.clients.authenticate(previous)).toBeUndefined()
    expect(server.clients.authenticate(minted.credential)).toEqual(minted.client)
    socket.terminate()
  })

  it('remints on startup only when the flag is set', async () => {
    const directory = await dataDir()
    const first = await startServer({ port: 0, dataDir: directory, logLevel: 'silent' })
    const originalId = first.owner.clientId
    const original = (await readFile(join(directory, 'owner-credential'), 'utf8')).trim()
    await first.close()

    const reused = await startServer({ port: 0, dataDir: directory, logLevel: 'silent' })
    servers.push(reused)
    expect(reused.owner.clientId).toBe(originalId)
    expect((await readFile(join(directory, 'owner-credential'), 'utf8')).trim()).toBe(original)
    await reused.close()
    servers.splice(servers.indexOf(reused), 1)

    const reminted = await startServer({
      port: 0,
      dataDir: directory,
      logLevel: 'silent',
      remintOwner: true,
    })
    servers.push(reminted)
    expect(reminted.owner.clientId).not.toBe(originalId)
    expect((await readFile(join(directory, 'owner-credential'), 'utf8')).trim()).not.toBe(original)
    expect(reminted.clients.authenticate(original)).toBeUndefined()
  })
})
