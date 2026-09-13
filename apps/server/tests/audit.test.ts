import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuditLog, type AuditLog } from '../src/audit.js'
import { DATABASE_FILENAME } from '../src/db/database.js'
import { mintCredential } from '../src/authorized-clients.js'
import { containsSecret, REDACTED, redactSecrets } from '../src/redact.js'

const directories: string[] = []
const logs: AuditLog[] = []

afterEach(async () => {
  for (const log of logs.splice(0)) {
    try {
      log.close()
    } catch {
      /* closed in the test */
    }
  }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function dataDir() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-audit-test-'))
  directories.push(directory)
  return directory
}

function open(dataDir?: string, clock: () => Date = () => new Date('2026-09-13T12:00:00Z')) {
  const logger = vi.fn()
  const audit = createAuditLog(logger, dataDir ? { clock, dataDir } : clock)
  logs.push(audit)
  return { audit, logger }
}

describe('redaction', () => {
  it('strips credentials, bearer tokens and provider keys from structured values', () => {
    const credential = mintCredential()
    expect(
      redactSecrets({
        token: credential,
        authorization: `Bearer ${credential}`,
        note: `leaked ${credential} and sk-ant-api03-secretvalue`,
        clientId: 'client-1',
        presented: true,
      }),
    ).toEqual({
      token: REDACTED,
      authorization: REDACTED,
      note: `leaked ${REDACTED} and ${REDACTED}`,
      clientId: 'client-1',
      presented: true,
    })
    expect(containsSecret(credential)).toBe(true)
    expect(containsSecret({ clientId: 'client-1', command: 'ws.upgrade' })).toBe(false)
  })
})

describe('in-process audit log', () => {
  it('records client id, command and outcome and never persists a raw credential', () => {
    const { audit, logger } = open()
    const credential = mintCredential()
    const event = audit.record({
      type: 'pairing.rejected',
      command: 'pairing.exchange',
      remoteAddress: '203.0.113.10',
      details: { token: credential, presented: true, reason: 'unknown_or_consumed' },
    })
    expect(event).toMatchObject({
      type: 'pairing.rejected',
      command: 'pairing.exchange',
      outcome: 'rejected',
      remoteAddress: '203.0.113.10',
      details: { token: REDACTED, presented: true, reason: 'unknown_or_consumed' },
    })
    expect(JSON.stringify(event)).not.toContain(credential)
    expect(logger).toHaveBeenCalledWith('warn', 'audit', { audit: event })
    expect(audit.query({ type: 'pairing.rejected' })).toMatchObject([
      { command: 'pairing.exchange', outcome: 'rejected' },
    ])
  })
})

describe('durable audit log', () => {
  it('is queryable from SQLite after a restart and keeps client id, command, outcome', async () => {
    const directory = await dataDir()
    let now = Date.parse('2026-09-13T12:00:00Z')
    const first = open(directory, () => new Date(now))
    const issued = first.audit.record({
      type: 'token.issued',
      clientId: 'client-1',
      command: 'client.issue',
      details: { kind: 'paired', label: 'Phone' },
    })
    now += 1000
    first.audit.record({
      type: 'path.rejected',
      clientId: 'client-1',
      command: 'file.read',
      details: { path: '../secret', reason: 'escape' },
    })
    first.audit.close()

    const database = new DatabaseSync(join(directory, DATABASE_FILENAME))
    try {
      expect(
        database.prepare('SELECT type, outcome, command, client_id FROM audit_events ORDER BY at').all(),
      ).toEqual([
        {
          type: 'token.issued',
          outcome: 'issued',
          command: 'client.issue',
          client_id: 'client-1',
        },
        {
          type: 'path.rejected',
          outcome: 'rejected',
          command: 'file.read',
          client_id: 'client-1',
        },
      ])
    } finally {
      database.close()
    }

    const restarted = open(directory)
    expect(restarted.audit.query({ clientId: 'client-1' })).toMatchObject([
      { type: 'path.rejected', command: 'file.read', outcome: 'rejected', clientId: 'client-1' },
      { type: 'token.issued', command: 'client.issue', outcome: 'issued', clientId: 'client-1' },
    ])
    expect(restarted.audit.query({ type: 'token.issued' })[0]).toMatchObject({
      eventId: expect.any(String),
      at: issued.at,
      details: { kind: 'paired', label: 'Phone' },
    })
  })

  it('filters by type and does not write secrets into the table', async () => {
    const directory = await dataDir()
    const { audit } = open(directory)
    const credential = mintCredential()
    audit.record({
      type: 'auth.failed',
      command: 'ws.upgrade',
      details: { credential, presented: true },
    })
    const rows = audit.query({ type: 'auth.failed' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      command: 'ws.upgrade',
      outcome: 'failed',
      details: { credential: REDACTED, presented: true },
    })
    expect(JSON.stringify(rows)).not.toContain(credential.slice(5))
  })
})
