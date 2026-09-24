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
  const hold = (artifactId: string, clientId = 'owner', workspaceId = 'workspace-1') =>
    artifacts.record(
      {
        artifactId,
        workspaceId,
        name: `${artifactId}.png`,
        mimeType: 'image/png',
        sizeBytes: 3,
        createdAt: 1,
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
  return { database, artifacts, hold, sessionOf }
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

  it('refuses to hold an upload for a workspace that is gone', async () => {
    const { hold } = await store()
    expect(() => hold('a', 'owner', 'workspace-gone')).toThrow()
  })
})
