import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { type SessionListCursor, type SessionSummary } from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { listSessionSummaries } from '../src/db/session-store.js'
import { pageSessionSummaries, SESSION_PAGE_BYTE_BUDGET } from '../src/session-pagination.js'

const directories: string[] = []
const databases: DatabaseSync[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function summary(index: number, oversized = false): SessionSummary {
  return {
    sessionId: `session-${String(index).padStart(3, '0')}`,
    workspaceId: 'workspace-1',
    providerId: 'opencode',
    title: 'Session',
    status: 'idle',
    // Tied timestamps also exercise the session-id cursor tie-breaker.
    updatedAt: new Date(1_000).toISOString(),
    settledAt: null,
    doneAt: null,
    composer: {
      availableCommands: Array.from({ length: oversized ? 16 : 1 }, (_, i) => ({
        name: `command-${i}`,
        description: '界'.repeat(7_000),
      })),
    },
  }
}

async function pager(kind: 'database' | 'memory', sessions: SessionSummary[]) {
  if (kind === 'memory')
    return (cursor?: SessionListCursor, limit = 100) =>
      pageSessionSummaries(sessions, { cursor, limit, workspaceId: 'workspace-1' })
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-session-budget-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  database.exec(`INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
    VALUES ('workspace-1', 'Workspace', '/workspace', 1, 1)`)
  const insert = database.prepare(`INSERT INTO sessions
    (session_id, workspace_id, provider_id, title, status, composer_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1000, 1000)`)
  for (const session of sessions)
    insert.run(
      session.sessionId,
      session.workspaceId,
      session.providerId!,
      session.title,
      session.status,
      JSON.stringify(session.composer),
    )
  return (cursor?: SessionListCursor, limit = 100) =>
    listSessionSummaries(database, { cursor, limit, workspaceId: 'workspace-1' })
}

const bytes = (sessions: SessionSummary[]) => Buffer.byteLength(JSON.stringify(sessions), 'utf8')

describe.each(['database', 'memory'] as const)('%s session page byte budget', (kind) => {
  it('returns an empty terminal page for an empty catalog', async () => {
    const read = await pager(kind, [])
    expect(read()).toEqual({ sessions: [], nextCursor: null })
  })

  it('includes a page exactly at the byte budget, including array punctuation', async () => {
    const sessions = [summary(2), summary(1)]
    const commands = sessions[0]!.composer!.availableCommands!
    commands.push(
      ...Array.from({ length: 30 }, (_, i) => ({ name: `padding-${i}`, description: '' })),
    )
    const baseline = await pager(kind, sessions)
    let padding = SESSION_PAGE_BYTE_BUDGET - bytes(baseline().sessions)
    for (const command of commands.slice(1)) {
      const added = Math.min(padding, 8_000)
      command.description = 'x'.repeat(added)
      padding -= added
    }
    expect(padding).toBe(0)
    const read = await pager(kind, sessions)
    expect(bytes(read().sessions)).toBe(SESSION_PAGE_BYTE_BUDGET)
    expect(read().nextCursor).toBeNull()

    sessions[0]!.composer!.availableCommands![0]!.description += 'x'
    const over = await pager(kind, sessions)
    const first = over()
    expect(first.sessions.map((session) => session.sessionId)).toEqual(['session-002'])
    expect(first.nextCursor).toEqual({
      updatedAt: sessions[0]!.updatedAt,
      sessionId: 'session-002',
    })
    expect(over(first.nextCursor!).sessions.map((session) => session.sessionId)).toEqual([
      'session-001',
    ])
  })

  it('cuts large composers at the exact cursor and returns all following pages without gaps', async () => {
    const sessions = Array.from({ length: 130 }, (_, i) => summary(i))
    const read = await pager(kind, sessions)
    const expected = [...sessions].reverse()
    const seen: string[] = []
    let cursor: SessionListCursor | undefined
    do {
      const page = read(cursor)
      expect(page.sessions.length).toBeGreaterThan(0)
      expect(page.sessions.length).toBeLessThan(100)
      expect(bytes(page.sessions)).toBeLessThanOrEqual(SESSION_PAGE_BYTE_BUDGET)
      seen.push(...page.sessions.map((session) => session.sessionId))
      const last = page.sessions.at(-1)!
      if (seen.length < sessions.length) {
        expect(page.nextCursor).toEqual({ updatedAt: last.updatedAt, sessionId: last.sessionId })
        expect(bytes([...page.sessions, expected[seen.length]!])).toBeGreaterThan(
          SESSION_PAGE_BYTE_BUDGET,
        )
      } else {
        expect(page.nextCursor).toBeNull()
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor && seen.length <= sessions.length)
    expect(seen).toEqual(expected.map((session) => session.sessionId))
  })

  it('returns an oversized session alone and advances past it', async () => {
    const huge = summary(2, true)
    const small = summary(1)
    const read = await pager(kind, [small, huge])
    const first = read()
    expect(first.sessions.map((session) => session.sessionId)).toEqual([huge.sessionId])
    expect(bytes(first.sessions)).toBeGreaterThan(SESSION_PAGE_BYTE_BUDGET)
    expect(first.nextCursor).toEqual({ updatedAt: huge.updatedAt, sessionId: huge.sessionId })
    const last = read(first.nextCursor!)
    expect(last.sessions.map((session) => session.sessionId)).toEqual([small.sessionId])
    expect(last.nextCursor).toBeNull()
    const single = await pager(kind, [huge])
    expect(single().sessions).toHaveLength(1)
    expect(single().nextCursor).toBeNull()
  })

  it('still honours the row limit when it is reached before the byte budget', async () => {
    const read = await pager(kind, [summary(1), summary(2), summary(3)])
    const first = read(undefined, 2)
    expect(first.sessions.map((session) => session.sessionId)).toEqual([
      'session-003',
      'session-002',
    ])
    expect(first.nextCursor).toEqual({
      updatedAt: new Date(1_000).toISOString(),
      sessionId: 'session-002',
    })
    expect(read(first.nextCursor!, 2).sessions.map((session) => session.sessionId)).toEqual([
      'session-001',
    ])
  })
})
