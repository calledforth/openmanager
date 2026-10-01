import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { DraftTarget, ProofEvent } from '@openmanager/protocol/node'
import { runMigrations } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { prepareDraftProjection } from '../src/db/draft-projection.js'
import { DRAFT_TOMBSTONE_RETENTION_MS, createDraftService } from '../src/draft-service.js'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function setup() {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  database.exec('PRAGMA foreign_keys = ON')
  runMigrations(database, MIGRATIONS)
  database
    .prepare(
      `INSERT INTO workspaces (workspace_id, name, path, availability, created_at, updated_at)
       VALUES ('ws', 'ws', '/ws', 'available', 0, 0)`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO sessions (session_id, workspace_id, provider_id, status, created_at, updated_at)
       VALUES ('session-1', 'ws', 'cursor', 'idle', 0, 0)`,
    )
    .run()
  const projection = prepareDraftProjection(database)
  const apply = (events: readonly ProofEvent[]) => {
    for (const event of events) {
      if (event.name === 'draft.saved') projection.saved(event.payload.draft)
      if (event.name === 'draft.deleted') {
        projection.deleted(event.payload, Date.parse(event.timestamp))
      }
    }
  }
  let clock = 1_000_000
  const service = createDraftService({
    database,
    environmentId: () => 'env',
    now: () => clock,
    appendAtomic: (events: readonly ProofEvent[]) => apply(events),
  })
  let request = 0
  const call = (name: string, payload: unknown) =>
    service.dispatch({
      type: 'command',
      requestId: `r${(request += 1)}`,
      name,
      payload,
    } as never) as { type: string; payload?: any; error?: any }
  return {
    service,
    call,
    append: (events: readonly ProofEvent[]) => apply(events),
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const SESSION: DraftTarget = { type: 'session', sessionId: 'session-1' }

describe('draft service', () => {
  it('forgets old tombstones, session drafts included, and never moves a revision backwards', () => {
    const { service, call, advance } = setup()
    call('draft.save', {
      draftId: 'session-1',
      baseRevision: 0,
      target: SESSION,
      content: { text: 'a' },
    })
    expect(call('draft.delete', { draftId: 'session-1', baseRevision: 1 }).payload).toEqual({
      draftId: 'session-1',
      revision: 2,
    })
    expect(call('draft.list', null).payload.tombstones).toEqual([
      { draftId: 'session-1', revision: 2 },
    ])

    advance(DRAFT_TOMBSTONE_RETENTION_MS + 1)
    expect(service.pruneTombstones()).toBe(1)
    expect(call('draft.list', null).payload).toEqual({ drafts: [], tombstones: [] })

    // A client still holding revision 2 saves on top of it: the draft goes on
    // from there, not from 1.
    const next = call('draft.save', {
      draftId: 'session-1',
      baseRevision: 2,
      target: SESSION,
      content: { text: 'b' },
    })
    expect(next.payload.draft.revision).toBe(3)
  })

  it('puts back a rolled-back first message whole, however long', () => {
    const database = setup()
    const text = 'x'.repeat(62_000)
    const launch = database.service.launch('long', {
      workspaceId: 'ws',
      sessionId: 'minted',
      content: { text },
    })
    if ('error' in launch) throw new Error(launch.error)
    database.append([launch.event])
    launch.restore()
    const [draft] = database.call('draft.list', null).payload.drafts
    expect(draft.content.text).toHaveLength(62_000)
  })

  it('refuses to send a draft as another session, or into another project', () => {
    const { service, call } = setup()
    const target: DraftTarget = { type: 'new_session', workspaceId: 'ws', sessionId: 'minted' }
    call('draft.save', { draftId: 'd', baseRevision: 0, target, content: { text: 'mine' } })
    const sent = (sessionId: string, workspaceId = 'ws') =>
      service.launch('d', { workspaceId, sessionId, content: { text: 'x' } })

    expect(sent('another')).toEqual({ error: 'The draft belongs to another session.' })
    expect(sent('minted', 'elsewhere')).toEqual({ error: 'The draft belongs to another session.' })
    expect(sent('minted')).toHaveProperty('event')
    // A draft the environment never saw can still be sent.
    expect(
      service.launch('unseen', { workspaceId: 'ws', sessionId: 's', content: { text: 'x' } }),
    ).toHaveProperty('event')
  })
})
