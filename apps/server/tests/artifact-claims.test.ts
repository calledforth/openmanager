import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createArtifactStore } from '../src/artifacts.js'
import { openEnvironmentDatabase } from '../src/db/database.js'

const directories: string[] = []
const databases: { close(): void }[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-artifact-claims-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  database.exec(`
    INSERT INTO authorized_clients (client_id, label, credential_hash, scopes_json, created_at)
      VALUES ('owner', 'owner', X'01', '[]', 1), ('paired', 'paired', X'02', '[]', 1);
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
      VALUES ('workspace-1', 'one', '/one', 1, 1), ('workspace-2', 'two', '/two', 1, 1);
    INSERT INTO sessions (session_id, workspace_id, provider_id, status, created_at, updated_at)
      VALUES ('session-1', 'workspace-1', 'opencode', 'idle', 1, 1),
        ('session-2', 'workspace-1', 'opencode', 'idle', 1, 1);
  `)
  const artifacts = createArtifactStore(database, directory)
  // A draft's upload: no session, held for the workspace and the client.
  const hold = (
    artifactId: string,
    clientId = 'owner',
    workspaceId = 'workspace-1',
    createdAt = 1,
  ) =>
    artifacts.record(
      {
        artifactId,
        workspaceId,
        name: `${artifactId}.png`,
        mimeType: 'image/png',
        sizeBytes: 3,
        createdAt,
        source: 'prompt',
      },
      clientId,
    )
  const sessionOf = (artifactId: string) =>
    (
      database
        .prepare('SELECT session_id FROM attachments WHERE attachment_id = ?')
        .get(artifactId) as { session_id: string | null } | undefined
    )?.session_id
  return { database, directory, artifacts, hold, sessionOf }
}

const OWNER_CLAIM = { workspaceId: 'workspace-1', clientId: 'owner', sessionId: 'session-1' }

describe('held uploads', () => {
  it('holds a draft upload for its workspace until a session claims it', async () => {
    const { artifacts, hold, sessionOf } = await store()
    hold('a')
    expect(sessionOf('a')).toBeNull()
    // Not a session's artifact yet, so no session can read it.
    expect(artifacts.get('session-1', 'a')).toBeUndefined()

    expect(artifacts.claimable(['a'], OWNER_CLAIM)).toBe(true)
    expect(artifacts.claim(['a'], OWNER_CLAIM)).toBe(true)
    expect(sessionOf('a')).toBe('session-1')
    expect(artifacts.get('session-1', 'a')).toMatchObject({
      artifactId: 'a',
      sessionId: 'session-1',
    })

    // Claimed once: a second launch cannot take it.
    expect(artifacts.claimable(['a'], OWNER_CLAIM)).toBe(false)
    expect(artifacts.claim(['a'], { ...OWNER_CLAIM, sessionId: 'session-2' })).toBe(false)
    expect(sessionOf('a')).toBe('session-1')
  })

  it("refuses another client's upload and one held for another workspace", async () => {
    const { artifacts, hold, sessionOf } = await store()
    hold('paired-upload', 'paired')
    hold('elsewhere', 'owner', 'workspace-2')
    for (const artifactId of ['paired-upload', 'elsewhere']) {
      expect(artifacts.claimable([artifactId], OWNER_CLAIM)).toBe(false)
      expect(artifacts.claim([artifactId], OWNER_CLAIM)).toBe(false)
      expect(sessionOf(artifactId)).toBeNull()
    }
    expect(artifacts.claimable(['missing'], OWNER_CLAIM)).toBe(false)
  })

  it('claims all of a launch or none of it', async () => {
    const { artifacts, hold, sessionOf } = await store()
    hold('mine')
    hold('theirs', 'paired')
    expect(artifacts.claim(['mine', 'theirs'], OWNER_CLAIM)).toBe(false)
    expect(sessionOf('mine')).toBeNull()
    // A repeated id is one attachment.
    expect(artifacts.claim(['mine', 'mine'], OWNER_CLAIM)).toBe(true)
  })

  it('gives a failed launch its images back so a retry can claim them', async () => {
    const { artifacts, database, hold, sessionOf } = await store()
    hold('a')
    artifacts.claim(['a'], OWNER_CLAIM)
    artifacts.release(['a'], 'session-1')
    expect(sessionOf('a')).toBeNull()
    // Released before the session goes, so its deletion no longer takes the row.
    database.prepare('DELETE FROM sessions WHERE session_id = ?').run('session-1')
    expect(sessionOf('a')).toBeNull()
    expect(artifacts.claim(['a'], { ...OWNER_CLAIM, sessionId: 'session-2' })).toBe(true)
  })

  it('removes held uploads no launch claimed in time, with their bytes', async () => {
    const { artifacts, database, hold, sessionOf } = await store()
    const OLD = '00000000-0000-4000-8000-000000000001'
    const FRESH = '00000000-0000-4000-8000-000000000002'
    const CLAIMED = '00000000-0000-4000-8000-000000000003'
    hold(OLD, 'owner', 'workspace-1', 100)
    hold(FRESH, 'owner', 'workspace-1', 5_000)
    hold(CLAIMED, 'owner', 'workspace-1', 100)
    artifacts.claim([CLAIMED], OWNER_CLAIM)
    // A row migrated with a session it no longer matches is not a draft's.
    database.exec(`
      INSERT INTO attachments (attachment_id, workspace_id, storage_key, name, mime_type,
        size_bytes, metadata_json, created_at)
      VALUES ('migrated', 'workspace-1', 'uploads/migrated', 'm.png', 'image/png', 1,
        '{"sessionId":"session-gone","source":"prompt"}', 100)
    `)
    for (const id of [OLD, FRESH, CLAIMED]) writeFileSync(artifacts.path(id), 'png')

    expect(artifacts.expireHeld(1_000)).toEqual([OLD])
    expect(existsSync(artifacts.path(OLD))).toBe(false)
    expect(sessionOf(OLD)).toBeUndefined()
    expect(existsSync(artifacts.path(FRESH))).toBe(true)
    expect(sessionOf(FRESH)).toBeNull()
    expect(sessionOf(CLAIMED)).toBe('session-1')
    expect(sessionOf('migrated')).toBeNull()
  })

  it('refuses to hold an upload for a workspace that is gone', async () => {
    const { hold } = await store()
    expect(() => hold('a', 'owner', 'workspace-gone')).toThrow()
  })
})
