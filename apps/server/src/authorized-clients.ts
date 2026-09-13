import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { AccessGrantSchema, type AccessCapability } from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from './db/database.ts'
import { ACTIVE_OWNER_CLIENT_SQL, AUTHORIZED_CLIENT_BY_HASH_SQL } from './db/queries.ts'

/**
 * Per-client credentials backed by `authorized_clients`, as fixed by
 * `docs/decisions/capability-scopes-and-credentials.md`.
 *
 * A credential is opaque: `omc1.` plus 32 CSPRNG bytes in unpadded base64url.
 * The server keeps only its SHA-256; capabilities, kind and expiry live on the
 * row, so revoking or narrowing a client takes effect on its next request.
 */
export const CREDENTIAL_PREFIX = 'omc1.'
export const CREDENTIAL_PATTERN = /^omc1\.[A-Za-z0-9_-]{43}$/
export const IDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
export const OWNER_CREDENTIAL_FILENAME = 'owner-credential'
export const OWNER_LABEL = 'Local owner'
export const CLIENT_KINDS = ['owner', 'paired', 'cloud'] as const
export type ClientKind = (typeof CLIENT_KINDS)[number]
export const OWNER_GRANT: readonly AccessCapability[] = Object.freeze([
  'read',
  'operate',
  'agent',
  'terminal',
  'admin',
])

export interface AuthenticatedClient {
  readonly clientId: string
  readonly label: string
  readonly kind: ClientKind
  readonly capabilities: readonly AccessCapability[]
}

export interface ClientGrantRequest {
  label: string
  kind: ClientKind
  capabilities: readonly AccessCapability[]
}

type ClientRow = {
  client_id: string
  label: string
  kind: ClientKind
  credential_hash: Uint8Array
  scopes_json: string
  expires_at: number
  revoked_at: number | null
}

export function mintCredential(): string {
  return `${CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function hashCredential(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest()
}

function hashesMatch(stored: Uint8Array, candidate: Buffer): boolean {
  return stored.byteLength === candidate.byteLength && timingSafeEqual(Buffer.from(stored), candidate)
}

/** Fail closed: a row whose grant does not parse authenticates nobody. */
function parseGrant(scopesJson: string): readonly AccessCapability[] | undefined {
  try {
    const parsed = AccessGrantSchema.safeParse(JSON.parse(scopesJson))
    return parsed.success ? Object.freeze(parsed.data) : undefined
  } catch {
    return undefined
  }
}

function readOwnerFile(path: string): string | undefined {
  try {
    const credential = readFileSync(path, 'utf8').trim()
    return CREDENTIAL_PATTERN.test(credential) ? credential : undefined
  } catch {
    return undefined
  }
}

/** Publish the owner credential owner-readable, replacing any previous file atomically. */
function writeOwnerFile(path: string, credential: string): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  const content = Buffer.from(`${credential}\n`, 'utf8')
  const file = openSync(temporaryPath, 'wx', 0o600)
  try {
    // writeSync may return short. A truncated file would strand the owner
    // behind a hash the database already committed, so write until complete.
    let written = 0
    while (written < content.byteLength) {
      const count = writeSync(file, content, written)
      if (count <= 0) throw new Error('Failed to write the complete owner credential.')
      written += count
    }
    fsyncSync(file)
  } catch (error) {
    closeSync(file)
    unlinkSync(temporaryPath)
    throw error
  }
  closeSync(file)
  try {
    renameSync(temporaryPath, path)
  } catch (error) {
    unlinkSync(temporaryPath)
    throw error
  }
}

export type AuthorizedClients = ReturnType<typeof openAuthorizedClients>

/** Open the credential store on the environment database. All operations are synchronous point reads and writes. */
export function openAuthorizedClients(dataDir: string, clock: () => number = Date.now) {
  const database = openEnvironmentDatabase(dataDir)
  const ownerPath = join(dataDir, OWNER_CREDENTIAL_FILENAME)
  const byHash = database.prepare(AUTHORIZED_CLIENT_BY_HASH_SQL)
  const activeOwner = database.prepare(ACTIVE_OWNER_CLIENT_SQL)
  const insert = database.prepare(`
    INSERT INTO authorized_clients (
      client_id, label, kind, credential_hash, scopes_json, created_at, last_seen_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `)
  const touch = database.prepare(`
    UPDATE authorized_clients
    SET last_seen_at = ?, expires_at = ?
    WHERE client_id = ? AND revoked_at IS NULL
  `)
  const revokeOne = database.prepare(`
    UPDATE authorized_clients SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL
  `)
  const revokeOwners = database.prepare(`
    UPDATE authorized_clients SET revoked_at = ? WHERE kind = 'owner' AND revoked_at IS NULL
  `)

  const toClient = (row: Pick<ClientRow, 'client_id' | 'label' | 'kind' | 'scopes_json'>) => {
    const capabilities = parseGrant(row.scopes_json)
    if (!capabilities) return undefined
    return Object.freeze({
      clientId: row.client_id,
      label: row.label,
      kind: row.kind,
      capabilities,
    }) satisfies AuthenticatedClient
  }

  const issue = (request: ClientGrantRequest, now: number) => {
    const capabilities = AccessGrantSchema.parse([...request.capabilities])
    if (request.kind === 'cloud' && capabilities.includes('admin')) {
      throw new Error('Cloud-enrolled clients cannot hold the admin capability.')
    }
    const label = request.label.trim()
    if (label.length === 0 || label.length > 128) {
      throw new Error('Client label must be 1 to 128 characters.')
    }
    const credential = mintCredential()
    const client: AuthenticatedClient = Object.freeze({
      clientId: randomUUID(),
      label,
      kind: request.kind,
      capabilities: Object.freeze(capabilities),
    })
    insert.run(
      client.clientId,
      client.label,
      client.kind,
      hashCredential(credential),
      JSON.stringify(capabilities),
      now,
      now + IDLE_EXPIRY_MS,
    )
    return { client, credential }
  }

  return {
    /** Mint a credential for a new client. The raw credential is returned once and never stored. */
    issue(request: ClientGrantRequest) {
      return issue(request, clock())
    },

    /**
     * Resolve a presented credential to its live client, moving its idle expiry
     * forward. Malformed, unknown, revoked and expired credentials all return
     * `undefined` so callers cannot distinguish them.
     */
    authenticate(candidate: string | undefined): AuthenticatedClient | undefined {
      if (candidate === undefined || !CREDENTIAL_PATTERN.test(candidate)) return undefined
      const hash = hashCredential(candidate)
      const row = byHash.get(hash) as ClientRow | undefined
      if (!row || !hashesMatch(row.credential_hash, hash) || row.revoked_at !== null) {
        return undefined
      }
      const now = clock()
      if (row.expires_at <= now) return undefined
      const client = toClient(row)
      if (!client) return undefined
      // The update is conditional on `revoked_at IS NULL`; zero rows means
      // another process revoked the client after the read above.
      if (touch.run(now, now + IDLE_EXPIRY_MS, row.client_id).changes === 0) return undefined
      return client
    },

    /** Mark a client revoked. Returns false when it was unknown or already revoked. */
    revoke(clientId: string): boolean {
      return revokeOne.run(clock(), clientId).changes > 0
    },

    /**
     * Make sure the local owner can connect without a pairing UI. The owner
     * credential is minted by this process and handed to local clients through
     * an owner-only file in the data directory; the database holds only its hash.
     * Restarts reuse the existing credential. A missing, corrupt or mismatched
     * file, or an expired or absent owner row, re-mints: the old owner row is
     * revoked in the same transaction, so deleting the file rotates the owner.
     */
    ensureOwner(): AuthenticatedClient {
      database.exec('BEGIN IMMEDIATE')
      try {
        const now = clock()
        const existing = activeOwner.get() as
          | Pick<ClientRow, 'client_id' | 'label' | 'credential_hash' | 'scopes_json' | 'expires_at'>
          | undefined
        const published = readOwnerFile(ownerPath)
        if (existing && existing.expires_at > now && published !== undefined) {
          const client = toClient({ ...existing, kind: 'owner' })
          if (client && hashesMatch(existing.credential_hash, hashCredential(published))) {
            // A restored backup or manual chmod may have widened the file;
            // a reused credential is only ever reused owner-only.
            chmodSync(ownerPath, 0o600)
            database.exec('COMMIT')
            return client
          }
        }
        revokeOwners.run(now)
        const minted = issue({ label: OWNER_LABEL, kind: 'owner', capabilities: OWNER_GRANT }, now)
        writeOwnerFile(ownerPath, minted.credential)
        database.exec('COMMIT')
        return minted.client
      } catch (error) {
        try {
          database.exec('ROLLBACK')
        } catch {
          /* The failed statement may already have aborted the transaction. */
        }
        throw error
      }
    },

    close(): void {
      database.close()
    },
  }
}
