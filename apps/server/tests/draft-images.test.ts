import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DraftContent, DraftTarget, ProofEvent } from '@openmanager/protocol/node'
import { createArtifactStore } from '../src/artifacts.js'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { prepareDraftProjection } from '../src/db/draft-projection.js'
import { createDraftService } from '../src/draft-service.js'
import { HELD_UPLOAD_TTL_MS } from '../src/uploads.js'

const directories: string[] = []
const databases: { close(): void }[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** Artifact ids name files, so they must look like the ones the store mints. */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const A = id(1)
const B = id(2)
const C = id(3)
const D = id(4)

const NOW = 10 * HELD_UPLOAD_TTL_MS

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-draft-images-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  database.exec(`
    INSERT INTO authorized_clients (client_id, label, credential_hash, scopes_json, created_at)
      VALUES ('laptop', 'laptop', X'01', '[]', 1), ('phone', 'phone', X'02', '[]', 1);
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
      VALUES ('ws-1', 'one', '/one', 1, 1), ('ws-2', 'two', '/two', 1, 1);
    INSERT INTO sessions (session_id, workspace_id, provider_id, status, created_at, updated_at)
      VALUES ('session-1', 'ws-1', 'opencode', 'idle', 1, 1),
        ('session-2', 'ws-2', 'opencode', 'idle', 1, 1);
  `)
  const artifacts = createArtifactStore(database, directory)
  const projection = prepareDraftProjection(database)
  const apply = (events: readonly ProofEvent[]) => {
    for (const event of events) {
      if (event.name === 'draft.saved') projection.saved(event.payload.draft)
      if (event.name === 'draft.deleted') {
        projection.deleted(event.payload, Date.parse(event.timestamp))
      }
    }
  }
  const drafts = createDraftService({
    database,
    environmentId: () => 'env',
    now: () => NOW,
    appendAtomic: apply,
    discardImages: (artifactIds) => artifacts.discardHeld(artifactIds),
  })
  let request = 0
  const call = (name: string, payload: unknown) =>
    drafts.dispatch({
      type: 'command',
      requestId: `r${(request += 1)}`,
      name,
      payload,
    } as never) as {
      type: string
      payload?: { draft?: { revision: number; target: DraftTarget } }
      error?: { code: string }
    }
  /** An upload for a draft, held for its workspace; a day old by default, so the sweep may take it. */
  const hold = (artifactId: string, workspaceId = 'ws-1', clientId = 'laptop', createdAt = 1) => {
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
    writeFileSync(artifacts.path(artifactId), 'png')
  }
  const row = (artifactId: string) =>
    database
      .prepare('SELECT workspace_id, session_id FROM attachments WHERE attachment_id = ?')
      .get(artifactId) as { workspace_id: string | null; session_id: string | null } | undefined
  const kept = (artifactId: string) =>
    row(artifactId) !== undefined && existsSync(artifacts.path(artifactId))
  const gone = (artifactId: string) =>
    row(artifactId) === undefined && !existsSync(artifacts.path(artifactId))
  const target = (workspaceId: string | null, sessionId = 'launch-1'): DraftTarget => ({
    type: 'new_session',
    workspaceId,
    sessionId,
  })
  const save = (draftId: string, baseRevision: number, at: DraftTarget, content: DraftContent) => {
    const answer = call('draft.save', { draftId, baseRevision, target: at, content })
    expect(answer.type).toBe('response')
    return answer.payload!.draft!
  }
  const sweep = () => artifacts.expireHeld(NOW - HELD_UPLOAD_TTL_MS)
  return { database, artifacts, drafts, apply, call, hold, row, kept, gone, target, save, sweep }
}

describe('images kept with a draft', () => {
  it('keeps an image a saved draft names past the held-upload expiry, and still expires the rest', async () => {
    const { hold, save, target, sweep, kept, gone } = await setup()
    hold(A)
    hold(B)
    hold(C, 'ws-1', 'laptop', NOW) // fresh, so not due whatever names it
    save('draft-1', 0, target('ws-1'), { text: 'see attached', artifactIds: [A] })

    expect(sweep()).toEqual([B])
    expect(kept(A)).toBe(true)
    expect(gone(B)).toBe(true)
    expect(kept(C)).toBe(true)
  })

  it('lets an image expire once the draft no longer names it', async () => {
    const { hold, save, target, sweep, kept, gone } = await setup()
    hold(A)
    hold(B)
    const first = save('draft-1', 0, target('ws-1'), { text: '', artifactIds: [A, B] })
    // The user took one out: nothing frees it at once, but nothing keeps it.
    save('draft-1', first.revision, target('ws-1'), { text: '', artifactIds: [B] })

    expect(sweep()).toEqual([A])
    expect(gone(A)).toBe(true)
    expect(kept(B)).toBe(true)
  })

  it("moves a draft's held images to the project it moves to, and never a session's", async () => {
    const { artifacts, hold, save, target, row } = await setup()
    hold(A)
    hold(B)
    hold(C)
    // C was sent in another chat since: the session's now.
    expect(
      artifacts.claim([C], { workspaceId: 'ws-1', clientId: 'laptop', sessionId: 'session-1' }),
    ).toBe(true)
    const first = save('draft-1', 0, target('ws-1'), { text: 'x', artifactIds: [A, C] })

    save('draft-1', first.revision, target('ws-2'), { text: 'x', artifactIds: [A, C] })
    expect(row(A)).toEqual({ workspace_id: 'ws-2', session_id: null })
    expect(row(C)).toEqual({ workspace_id: 'ws-1', session_id: 'session-1' })
    // Not named by the draft: stays where it was uploaded.
    expect(row(B)).toEqual({ workspace_id: 'ws-1', session_id: null })
  })

  it("keeps a draft's images when its project is removed, while a session's go with the session", async () => {
    const { artifacts, database, hold, save, target, row, sweep, kept, gone } = await setup()
    hold(A)
    hold(B)
    hold(C)
    artifacts.claim([C], { workspaceId: 'ws-1', clientId: 'laptop', sessionId: 'session-1' })
    save('draft-1', 0, target('ws-1'), { text: 'x', artifactIds: [A] })

    database.prepare('DELETE FROM workspaces WHERE workspace_id = ?').run('ws-1')

    expect(row(A)).toEqual({ workspace_id: null, session_id: null })
    expect(row(C)).toBeUndefined()
    // Kept for nobody, it still expires.
    expect(row(B)).toEqual({ workspace_id: null, session_id: null })
    expect(sweep()).toEqual([B])
    expect(kept(A)).toBe(true)
    expect(gone(B)).toBe(true)

    // The draft gets another project, and its image follows.
    save('draft-1', 1, target('ws-2'), { text: 'x', artifactIds: [A] })
    expect(row(A)).toEqual({ workspace_id: 'ws-2', session_id: null })
  })

  it('frees the images only a deleted draft named, and nothing a session or another draft holds', async () => {
    const { artifacts, call, hold, save, target, kept, gone } = await setup()
    hold(A)
    hold(B)
    hold(C)
    hold(D)
    const draft = save('draft-1', 0, target('ws-1'), { text: 'x', artifactIds: [A, B, C] })
    save('draft-2', 0, target('ws-1', 'launch-2'), { text: 'y', artifactIds: [B] })
    artifacts.claim([C], { workspaceId: 'ws-1', clientId: 'laptop', sessionId: 'session-1' })

    const answer = call('draft.delete', {
      draftId: 'draft-1',
      baseRevision: draft.revision,
      ifRevision: draft.revision,
    })
    expect(answer.type).toBe('response')
    expect(gone(A)).toBe(true)
    expect(kept(B)).toBe(true)
    expect(kept(C)).toBe(true)
    // Never named by the draft, so not the delete's to take.
    expect(kept(D)).toBe(true)
  })

  it('frees nothing when a discard is refused because the draft changed since', async () => {
    const { call, hold, save, target, kept } = await setup()
    hold(A)
    hold(B)
    const seen = save('draft-1', 0, target('ws-1'), { text: 'x', artifactIds: [A] })
    // Another device attached B since the discard was made.
    const since = save('draft-1', seen.revision, target('ws-1'), { text: 'x', artifactIds: [A, B] })

    const refused = call('draft.delete', {
      draftId: 'draft-1',
      baseRevision: seen.revision,
      ifRevision: seen.revision,
    })
    expect(refused).toMatchObject({ type: 'error', error: { code: 'conflict' } })
    expect(kept(A)).toBe(true)
    expect(kept(B)).toBe(true)

    // A delete from before a deletion is refused too, and frees nothing.
    expect(call('draft.delete', { draftId: 'draft-1', baseRevision: since.revision }).type).toBe(
      'response',
    )
    hold(C)
    save('draft-1', since.revision + 1, target('ws-1'), { text: 'next', artifactIds: [C] })
    expect(call('draft.delete', { draftId: 'draft-1', baseRevision: 0 })).toMatchObject({
      type: 'error',
      error: { code: 'conflict' },
    })
    expect(kept(C)).toBe(true)
  })

  it('leaves the images of a sent draft for its session to claim', async () => {
    const { artifacts, drafts, apply, hold, save, target, kept, row } = await setup()
    hold(A, 'ws-1', 'phone')
    save('draft-1', 0, target('ws-2', 'session-2'), { text: 'x', artifactIds: [A] })
    // Read before the send deletes the draft, as session.create does.
    const shared = artifacts.imagesOf('draft-1')
    expect(shared).toEqual([A])

    const launch = drafts.launch('draft-1', {
      workspaceId: 'ws-2',
      sessionId: 'session-2',
      content: { text: 'x', artifactIds: [A] },
    })
    if ('error' in launch) throw new Error(launch.error)
    apply([launch.event])
    expect(artifacts.imagesOf('draft-1')).toEqual([])
    expect(kept(A)).toBe(true)

    // Another device's upload, taken because the draft named it.
    expect(artifacts.claimable([A], { clientId: 'laptop' })).toBe(false)
    expect(artifacts.claimable([A], { clientId: 'laptop', shared })).toBe(true)
    expect(
      artifacts.claim([A], {
        workspaceId: 'ws-2',
        clientId: 'laptop',
        sessionId: 'session-2',
        shared,
      }),
    ).toBe(true)
    expect(row(A)).toEqual({ workspace_id: 'ws-2', session_id: 'session-2' })
  })

  it('serves a held image only through a live draft that names it', async () => {
    const { artifacts, call, hold, save, target } = await setup()
    hold(A)
    hold(B)
    const draft = save('draft-1', 0, target('ws-1'), { text: 'x', artifactIds: [A] })

    expect(artifacts.getHeld('draft-1', A)).toMatchObject({
      artifactId: A,
      workspaceId: 'ws-1',
      mimeType: 'image/png',
      sizeBytes: 3,
    })
    expect(artifacts.getHeld('draft-1', B)).toBeUndefined()
    expect(artifacts.getHeld('draft-2', A)).toBeUndefined()

    call('draft.delete', { draftId: 'draft-1', baseRevision: draft.revision })
    expect(artifacts.getHeld('draft-1', A)).toBeUndefined()
  })
})
