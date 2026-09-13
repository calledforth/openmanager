import { chmod, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CREDENTIAL_PATTERN,
  IDLE_EXPIRY_MS,
  OWNER_CREDENTIAL_FILENAME,
  OWNER_GRANT,
  hashCredential,
  mintCredential,
  openAuthorizedClients,
  type AuthorizedClients,
} from '../src/authorized-clients.js'
import { DATABASE_FILENAME } from '../src/db/database.js'

const directories: string[] = []
const stores: AuthorizedClients[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      /* closed by the test */
    }
  }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'openmanager-clients-test-'))
  directories.push(path)
  return path
}

function open(dataDir: string, clock?: () => number) {
  const store = openAuthorizedClients(dataDir, clock)
  stores.push(store)
  return store
}

describe('credential format', () => {
  it('mints prefixed, unpadded base64url credentials with 256 bits of entropy', () => {
    const credentials = Array.from({ length: 16 }, mintCredential)
    expect(new Set(credentials).size).toBe(16)
    for (const credential of credentials) {
      expect(credential).toMatch(CREDENTIAL_PATTERN)
      expect(credential).toHaveLength('omc1.'.length + 43)
      expect(Buffer.from(credential.slice(5), 'base64url')).toHaveLength(32)
    }
    expect(hashCredential(credentials[0]!)).toEqual(hashCredential(credentials[0]!))
    expect(hashCredential(credentials[0]!)).not.toEqual(hashCredential(credentials[1]!))
  })
})

describe('issue and authenticate', () => {
  it('stores only a hash and resolves the credential to its grant', async () => {
    const dataDir = await directory()
    const store = open(dataDir)
    const { client, credential } = store.issue({
      label: '  Phone ',
      kind: 'paired',
      capabilities: ['read', 'operate'],
    })
    expect(client).toEqual({
      clientId: expect.any(String),
      label: 'Phone',
      kind: 'paired',
      capabilities: ['read', 'operate'],
    })
    expect(store.authenticate(credential)).toEqual(client)

    const database = new DatabaseSync(join(dataDir, DATABASE_FILENAME))
    try {
      const row = database
        .prepare('SELECT credential_hash, scopes_json, kind FROM authorized_clients')
        .get() as { credential_hash: Uint8Array; scopes_json: string; kind: string }
      expect(Buffer.from(row.credential_hash)).toEqual(hashCredential(credential))
      expect(row.scopes_json).toBe('["read","operate"]')
      expect(row.kind).toBe('paired')
    } finally {
      database.close()
    }
  })

  it('answers undefined for missing, malformed, legacy, unknown and revoked credentials', async () => {
    const store = open(await directory())
    const { client, credential } = store.issue({
      label: 'Laptop',
      kind: 'paired',
      capabilities: ['read'],
    })
    expect(store.authenticate(undefined)).toBeUndefined()
    expect(store.authenticate('')).toBeUndefined()
    expect(store.authenticate('0'.repeat(64))).toBeUndefined()
    expect(store.authenticate(credential.slice(0, -1))).toBeUndefined()
    expect(store.authenticate(`${credential}=`)).toBeUndefined()
    expect(store.authenticate(mintCredential())).toBeUndefined()
    expect(store.authenticate(credential)).toEqual(client)
    expect(store.revoke(client.clientId)).toBe(true)
    expect(store.revoke(client.clientId)).toBe(false)
    expect(store.revoke('unknown')).toBe(false)
    expect(store.authenticate(credential)).toBeUndefined()
  })

  it('expires after 30 idle days and extends the window on every accepted connection', async () => {
    let now = 1_000_000
    const store = open(await directory(), () => now)
    const { credential } = store.issue({ label: 'Tablet', kind: 'paired', capabilities: ['read'] })
    now += IDLE_EXPIRY_MS - 1
    expect(store.authenticate(credential)).toBeDefined()
    now += IDLE_EXPIRY_MS - 1
    expect(store.authenticate(credential)).toBeDefined()
    now += IDLE_EXPIRY_MS
    expect(store.authenticate(credential)).toBeUndefined()
  })

  it('refuses grants without read, admin on cloud clients and empty labels', async () => {
    const store = open(await directory())
    expect(() =>
      store.issue({ label: 'x', kind: 'paired', capabilities: ['operate'] }),
    ).toThrow()
    expect(() =>
      store.issue({ label: 'x', kind: 'cloud', capabilities: ['read', 'admin'] }),
    ).toThrow('admin')
    expect(() => store.issue({ label: '  ', kind: 'paired', capabilities: ['read'] })).toThrow(
      'label',
    )
    expect(() =>
      store.issue({ label: 'x', kind: 'paired', capabilities: ['read', 'read'] }),
    ).toThrow()
  })

  it('fails closed on a stored grant that does not parse', async () => {
    const dataDir = await directory()
    const store = open(dataDir)
    const credential = mintCredential()
    const database = new DatabaseSync(join(dataDir, DATABASE_FILENAME))
    try {
      database
        .prepare(
          `INSERT INTO authorized_clients (
             client_id, label, kind, credential_hash, scopes_json, created_at, expires_at
           ) VALUES ('legacy', 'Legacy', 'paired', ?, '["environment"]', 1, ?)`,
        )
        .run(hashCredential(credential), Date.now() + IDLE_EXPIRY_MS)
    } finally {
      database.close()
    }
    expect(store.authenticate(credential)).toBeUndefined()
  })
})

describe('local owner credential', () => {
  it('mints the owner once, publishes it owner-only, and reuses it across restarts', async () => {
    const dataDir = await directory()
    const first = open(dataDir)
    const owner = first.ensureOwner()
    expect(owner).toEqual({
      clientId: expect.any(String),
      label: 'Local owner',
      kind: 'owner',
      capabilities: OWNER_GRANT,
    })
    const path = join(dataDir, OWNER_CREDENTIAL_FILENAME)
    const published = (await readFile(path, 'utf8')).trim()
    expect(published).toMatch(CREDENTIAL_PATTERN)
    expect((await readdir(dataDir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(first.authenticate(published)).toEqual(owner)

    // Another process (or the same one, restarted) sees the same owner.
    const second = open(dataDir)
    expect(second.ensureOwner()).toEqual(owner)
    expect(first.ensureOwner()).toEqual(owner)
    expect((await readFile(path, 'utf8')).trim()).toBe(published)
    expect(second.authenticate(published)).toEqual(owner)
  })

  it('re-mints and revokes the previous owner when the published file is gone or corrupt', async () => {
    const dataDir = await directory()
    const store = open(dataDir)
    const path = join(dataDir, OWNER_CREDENTIAL_FILENAME)
    const original = store.ensureOwner()
    const originalCredential = (await readFile(path, 'utf8')).trim()

    await unlink(path)
    const rotated = store.ensureOwner()
    const rotatedCredential = (await readFile(path, 'utf8')).trim()
    expect(rotated.clientId).not.toBe(original.clientId)
    expect(rotatedCredential).not.toBe(originalCredential)
    expect(store.authenticate(originalCredential)).toBeUndefined()
    expect(store.authenticate(rotatedCredential)).toEqual(rotated)

    await writeFile(path, 'not-a-credential\n')
    const replaced = store.ensureOwner()
    expect(replaced.clientId).not.toBe(rotated.clientId)
    expect(store.authenticate(rotatedCredential)).toBeUndefined()
    expect(store.authenticate((await readFile(path, 'utf8')).trim())).toEqual(replaced)

    // A file that names a credential the database never issued is treated the same way.
    await writeFile(path, `${mintCredential()}\n`)
    const reissued = store.ensureOwner()
    expect(reissued.clientId).not.toBe(replaced.clientId)
    expect(store.authenticate((await readFile(path, 'utf8')).trim())).toEqual(reissued)

    const database = new DatabaseSync(join(dataDir, DATABASE_FILENAME))
    try {
      expect(
        database
          .prepare(`SELECT COUNT(*) AS live FROM authorized_clients WHERE kind = 'owner' AND revoked_at IS NULL`)
          .get(),
      ).toEqual({ live: 1 })
      expect(
        database.prepare(`SELECT COUNT(*) AS total FROM authorized_clients WHERE kind = 'owner'`).get(),
      ).toEqual({ total: 4 })
    } finally {
      database.close()
    }
  })

  it('restores owner-only permissions on a reused credential file', async () => {
    if (process.platform === 'win32') return
    const dataDir = await directory()
    const store = open(dataDir)
    const owner = store.ensureOwner()
    const path = join(dataDir, OWNER_CREDENTIAL_FILENAME)
    const credential = (await readFile(path, 'utf8')).trim()
    await chmod(path, 0o644)
    expect(store.ensureOwner()).toEqual(owner)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await readFile(path, 'utf8')).trim()).toBe(credential)
  })

  it('re-mints an owner whose idle window has lapsed', async () => {
    let now = 5_000
    const dataDir = await directory()
    const store = open(dataDir, () => now)
    const original = store.ensureOwner()
    const path = join(dataDir, OWNER_CREDENTIAL_FILENAME)
    const originalCredential = (await readFile(path, 'utf8')).trim()
    now += IDLE_EXPIRY_MS + 1
    expect(store.authenticate(originalCredential)).toBeUndefined()
    const rotated = store.ensureOwner()
    expect(rotated.clientId).not.toBe(original.clientId)
    expect(store.authenticate((await readFile(path, 'utf8')).trim())).toEqual(rotated)
  })
})
