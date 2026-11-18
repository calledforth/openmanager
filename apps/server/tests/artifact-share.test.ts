import { readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createArtifactStore, ShareRefusedError } from '../src/artifacts.js'
import { openEnvironmentDatabase } from '../src/db/database.js'

const directories: string[] = []
const databases: { close(): void }[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** An MP4 of `size` bytes, as far as the sniff can tell. */
function mp4(directory: string, name: string, size: number) {
  const bytes = Buffer.alloc(size)
  Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')]).copy(bytes)
  const path = join(directory, name)
  writeFileSync(path, bytes)
  return path
}

async function store(sharedBytesPerSession: number) {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-artifact-share-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  database.exec(`
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
      VALUES ('workspace-1', 'one', '/one', 1, 1);
    INSERT INTO sessions (session_id, workspace_id, provider_id, status, created_at, updated_at)
      VALUES ('session-1', 'workspace-1', 'opencode', 'idle', 1, 1);
  `)
  const artifacts = createArtifactStore(database, directory, { sharedBytesPerSession })
  const rows = () =>
    (database.prepare('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }).n
  return { directory, artifacts, rows }
}

describe('sharing into a session', () => {
  it('lets only one of two shares at once take the last of the quota', async () => {
    const { directory, artifacts, rows } = await store(150_000)
    const first = mp4(directory, 'a.mp4', 100_000)
    const second = mp4(directory, 'b.mp4', 100_000)
    const results = await Promise.allSettled([
      artifacts.share('session-1', 'workspace-1', first),
      artifacts.share('session-1', 'workspace-1', second),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((result) => result.status === 'rejected')
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(ShareRefusedError)
    expect(rows()).toBe(1)
    // What was refused or finished leaves nothing reserved: the room is back.
    const kept = results.find((result) => result.status === 'fulfilled')!
    artifacts.discard((kept as PromiseFulfilledResult<{ artifactId: string; sessionId: string }>).value)
    expect(rows()).toBe(0)
    await expect(artifacts.share('session-1', 'workspace-1', first)).resolves.toMatchObject({
      mimeType: 'video/mp4',
    })
  })

  it('removes a discarded copy with its bytes', async () => {
    const { directory, artifacts } = await store(10_000_000)
    const shared = await artifacts.share('session-1', 'workspace-1', mp4(directory, 'c.mp4', 2_000))
    expect(readdirSync(join(directory, 'uploads'))).toContain(shared.artifactId)
    artifacts.discard(shared)
    expect(readdirSync(join(directory, 'uploads'))).not.toContain(shared.artifactId)
  })
})
