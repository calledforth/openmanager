import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ProofEventSchemas } from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { createEventRepository, type DurableProofEvent } from '../src/db/event-repository.js'
import { sessionDeletionEvents, workspaceRemovalEvents } from '../src/db/deletions.js'

const directories: string[] = []
const databases: DatabaseSync[] = []
const environment = { type: 'environment', environmentId: 'environment-1' } as const

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

/** A root with a child and a grandchild, the child's draft, and a new-session draft. */
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-deletions-test-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  database.exec(`
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
      VALUES ('workspace-1', 'Workspace', '/workspace', 1, 1);
    INSERT INTO sessions (session_id, workspace_id, provider_id, status, created_at, updated_at)
      VALUES ('root', 'workspace-1', 'cursor', 'idle', 1, 1);
    INSERT INTO sessions (
      session_id, workspace_id, parent_session_id, provider_id, status, created_at, updated_at
    ) VALUES ('child', 'workspace-1', 'root', 'cursor', 'idle', 2, 2),
             ('grandchild', 'workspace-1', 'child', 'cursor', 'idle', 3, 3);
    INSERT INTO drafts (draft_id, session_id, content_json, revision, created_at, updated_at)
      VALUES ('child', 'child', '{"text":"typed in the child"}', 3, 1, 1);
    INSERT INTO drafts (
      draft_id, workspace_id, launch_session_id, content_json, revision, created_at, updated_at
    ) VALUES ('new-draft', 'workspace-1', 'launch-1', '{"text":"kept"}', 4, 1, 1);
  `)
  return { database, repository: createEventRepository(database) }
}

const commit = (repository: ReturnType<typeof createEventRepository>, events: readonly unknown[]) =>
  repository.appendGroups([{ scope: environment, events: events as DurableProofEvent[] }])

const summarize = (events: readonly { name: string; payload: unknown }[]) =>
  events.map((event) => {
    const payload = event.payload as Record<string, unknown>
    if (event.name === 'draft.saved') {
      const draft = payload.draft as { draftId: string; revision: number }
      return `${event.name} ${draft.draftId}@${draft.revision}`
    }
    if (event.name === 'draft.deleted')
      return `${event.name} ${payload.draftId}@${payload.revision}`
    return `${event.name} ${(payload.sessionId ?? payload.workspaceId) as string}`
  })

const count = (database: DatabaseSync, sql: string) =>
  (database.prepare(sql).get() as { count: number }).count

describe('cascades as events', () => {
  it('deletes a session with every session under it, deepest first, each draft first', async () => {
    const { database, repository } = await setup()
    const events = sessionDeletionEvents(database, 'environment-1', ['root'], 0)
    expect(summarize(events)).toEqual([
      'session.deleted grandchild',
      'draft.deleted child@4',
      'session.deleted child',
      'session.deleted root',
    ])
    commit(repository, events)
    expect(count(database, 'SELECT COUNT(*) AS count FROM sessions')).toBe(0)
    // The new-session draft belongs to the project, not to any session.
    expect(count(database, 'SELECT COUNT(*) AS count FROM drafts WHERE deleted_at IS NULL')).toBe(1)
  })

  it('removes a workspace after its sessions, detaching what the user typed for it', async () => {
    const { database, repository } = await setup()
    const events = workspaceRemovalEvents(database, 'environment-1', 'workspace-1', 10)
    expect(summarize(events)).toEqual([
      'session.deleted grandchild',
      'draft.deleted child@4',
      'session.deleted child',
      'session.deleted root',
      'draft.saved new-draft@5',
      'workspace.removed workspace-1',
    ])
    expect(events[4]?.payload).toMatchObject({
      draft: {
        target: { type: 'new_session', workspaceId: null, sessionId: 'launch-1' },
        content: { text: 'kept' },
        updatedByClientId: null,
      },
    })
    commit(repository, events)
    expect(count(database, 'SELECT COUNT(*) AS count FROM workspaces')).toBe(0)
    expect(
      database
        .prepare("SELECT workspace_id, revision FROM drafts WHERE draft_id = 'new-draft'")
        .get(),
    ).toEqual({ workspace_id: null, revision: 5 })
  })

  it('refuses a deletion that would leave a foreign key to remove a row silently', async () => {
    const { database, repository } = await setup()
    const bare = (name: 'session.deleted' | 'workspace.removed', payload: object) =>
      ProofEventSchemas[name].parse({
        type: 'event',
        name,
        eventId: `${name}-bare`,
        timestamp: new Date(0).toISOString(),
        scope: environment,
        payload,
      })
    expect(() => commit(repository, [bare('session.deleted', { sessionId: 'root' })])).toThrow(
      /still has child sessions/,
    )
    expect(() => commit(repository, [bare('session.deleted', { sessionId: 'child' })])).toThrow(
      /still has child sessions/,
    )
    database.exec("DELETE FROM sessions WHERE session_id = 'grandchild'")
    expect(() => commit(repository, [bare('session.deleted', { sessionId: 'child' })])).toThrow(
      /still has a draft/,
    )
    expect(() =>
      commit(repository, [bare('workspace.removed', { workspaceId: 'workspace-1' })]),
    ).toThrow(/still has sessions/)
    // Each refusal rolled its transaction back.
    expect(count(database, 'SELECT COUNT(*) AS count FROM sessions')).toBe(2)
    expect(count(database, 'SELECT COUNT(*) AS count FROM event_log')).toBe(0)
  })
})
