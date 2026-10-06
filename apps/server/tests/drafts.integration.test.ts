import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClaudeSdk, FakeConnectionFactory } from '@agentpack/runtime/testing'
import {
  DraftResponseSchemas,
  ProofResponseSchemas,
  UploadResponseSchemas,
  UploadResultSchema,
  type Draft,
  type DraftContent,
  type DraftTarget,
  type DurableEvent,
  type ReplayResponse,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import {
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  handshake,
  nextResponse,
  replay,
  startProtocolHost,
  type ProtocolClient,
  type ProtocolHost,
} from './helpers/protocol-client.js'
import { expectCommand } from './helpers/proof-slice.js'

afterEach(cleanupProtocolHosts)

async function startHost({ failSessions = 0 } = {}) {
  let refusals = failSessions
  const connections = new FakeConnectionFactory({
    initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
    newSession: async () => {
      if (refusals-- > 0) throw new Error('provider refused the session')
      return { sessionId: `stub-${randomUUID()}` }
    },
    prompt: async () => ({ stopReason: 'end_turn' }),
  })
  let workspaceRoot = ''
  const host = await startProtocolHost({
    runtimeOptions: {
      connections,
      claudeSdk: new FakeClaudeSdk(),
      health: { schedule: () => ({ cancel() {} }) },
    },
    resolveWorkspace: () => ({ providerId: 'cursor', cwd: workspaceRoot }),
  })
  workspaceRoot = host.workspaceRoot
  const scope: SubscriptionScope = {
    type: 'environment',
    environmentId: host.server.identity.environmentId,
  }
  const first = await connectProtocol(host)
  await handshake(first)
  const second = await connectProtocol(host)
  await handshake(second)
  return { host, scope, first, second }
}

const live = (response: ReplayResponse) => response.payload.subscriptionId

const draftEvents = (records: DurableEvent[]) =>
  records.flatMap((record) =>
    record.event.name === 'draft.saved' || record.event.name === 'draft.deleted'
      ? [record.event]
      : [],
  )

async function save(
  client: ProtocolClient,
  draftId: string,
  baseRevision: number,
  target: DraftTarget,
  content: DraftContent,
) {
  const requestId = client.command('draft.save', { draftId, baseRevision, target, content })
  return nextResponse(client, requestId)
}

async function saved(...args: Parameters<typeof save>): Promise<Draft> {
  const response = await save(...args)
  return DraftResponseSchemas['draft.save'].parse(response).payload.draft
}

async function list(client: ProtocolClient) {
  const requestId = client.command('draft.list', null)
  return DraftResponseSchemas['draft.list'].parse(await nextResponse(client, requestId)).payload
}

async function removeRaw(
  client: ProtocolClient,
  draftId: string,
  baseRevision: number,
  ifRevision?: number,
) {
  const requestId = client.command('draft.delete', {
    draftId,
    baseRevision,
    ...(ifRevision !== undefined ? { ifRevision } : {}),
  })
  return nextResponse(client, requestId)
}

async function remove(client: ProtocolClient, draftId: string, baseRevision: number) {
  return DraftResponseSchemas['draft.delete'].parse(await removeRaw(client, draftId, baseRevision))
    .payload
}

describe('composer drafts across clients', () => {
  it('saves, lists, updates and deletes a new-session draft, and shows every change to another client', async () => {
    const { host, scope, first, second } = await startHost()
    const watching = live(await replay(second, scope, null))
    const target: DraftTarget = {
      type: 'new_session',
      workspaceId: host.workspaceId,
      sessionId: randomUUID(),
    }

    const created = await saved(first, 'draft-a', 0, target, {
      text: 'Plan the release',
      providerId: 'cursor',
      preference: { modelId: 'gpt-5' },
    })
    expect(created).toMatchObject({ draftId: 'draft-a', revision: 1, target })

    const updated = await saved(first, 'draft-a', 1, target, { text: 'Plan the release notes' })
    expect(updated.revision).toBe(2)
    expect(updated.createdAt).toBe(created.createdAt)

    // An unchanged save is answered with what is there, without a new revision.
    expect(
      (await saved(first, 'draft-a', 2, target, { text: 'Plan the release notes' })).revision,
    ).toBe(2)

    expect(await list(second)).toEqual({ drafts: [updated], tombstones: [] })

    expect(await remove(first, 'draft-a', 2)).toEqual({ draftId: 'draft-a', revision: 3 })
    expect(await list(second)).toEqual({ drafts: [], tombstones: [] })

    const records = await collectThreadRecords(second, watching, (seen) =>
      draftEvents(seen).some((event) => event.name === 'draft.deleted'),
    )
    expect(
      draftEvents(records).map((event) =>
        event.name === 'draft.saved'
          ? ['saved', event.payload.draft.revision, event.payload.draft.content.text]
          : ['deleted', event.payload.revision, event.payload.sessionId],
      ),
    ).toEqual([
      ['saved', 1, 'Plan the release'],
      ['saved', 2, 'Plan the release notes'],
      ['deleted', 3, null],
    ])
  })

  it('keeps the newest write whatever revision it was based on', async () => {
    const { host, first, second } = await startHost()
    const target: DraftTarget = {
      type: 'new_session',
      workspaceId: host.workspaceId,
      sessionId: randomUUID(),
    }
    await saved(first, 'draft-b', 0, target, { text: 'one' })
    await saved(first, 'draft-b', 1, target, { text: 'one two' })
    // The second client last saw revision 1; its write still wins.
    const winner = await saved(second, 'draft-b', 1, target, { text: 'from the phone' })
    expect(winner).toMatchObject({ revision: 3, content: { text: 'from the phone' } })
    expect((await list(first)).drafts).toEqual([winner])
  })

  it('refuses a save from before a discard, and never brings the draft back', async () => {
    const { host, first, second } = await startHost()
    const target: DraftTarget = {
      type: 'new_session',
      workspaceId: host.workspaceId,
      sessionId: randomUUID(),
    }
    await saved(first, 'draft-c', 0, target, { text: 'keep typing' })
    await remove(second, 'draft-c', 1)

    const late = await save(first, 'draft-c', 1, target, { text: 'keep typing more' })
    expect(late).toMatchObject({
      type: 'error',
      error: { code: 'conflict', details: { draftId: 'draft-c', revision: 2 } },
    })
    expect((await list(first)).drafts).toEqual([])

    // A first save still on the wire behind a discard of a draft never saved.
    expect(await remove(first, 'draft-unsaved', 0)).toEqual({
      draftId: 'draft-unsaved',
      revision: 1,
    })
    expect(await save(first, 'draft-unsaved', 0, target, { text: 'late' })).toMatchObject({
      type: 'error',
      error: { code: 'conflict' },
    })
  })

  it('refuses a discard of a draft another client wrote since, and keeps its text', async () => {
    const { host, first, second } = await startHost()
    const target: DraftTarget = {
      type: 'new_session',
      workspaceId: host.workspaceId,
      sessionId: randomUUID(),
    }
    const mine = await saved(first, 'draft-d', 0, target, { text: 'mine' })
    const theirs = await saved(second, 'draft-d', mine.revision, target, { text: 'from the phone' })

    // The first client discards the draft as it last wrote it.
    expect(await removeRaw(first, 'draft-d', mine.revision, mine.revision)).toMatchObject({
      type: 'error',
      error: {
        code: 'conflict',
        details: { draftId: 'draft-d', revision: theirs.revision, changed: true },
      },
    })
    expect((await list(first)).drafts).toEqual([theirs])

    // Named at the revision it now has, the discard goes.
    expect(await removeRaw(first, 'draft-d', theirs.revision, theirs.revision)).toMatchObject({
      type: 'response',
      payload: { draftId: 'draft-d', revision: theirs.revision + 1 },
    })
    expect((await list(first)).drafts).toEqual([])
  })

  it("clears a session's draft on send and accepts the next one typed after it", async () => {
    const { host, first, second } = await startHost()
    const session = await expectCommand(
      first,
      'session.create',
      {
        environmentId: host.server.identity.environmentId,
        providerId: 'cursor',
        workspaceId: host.workspaceId,
      },
      'create',
    )
    const sessionId = session.payload.session.sessionId
    const target: DraftTarget = { type: 'session', sessionId }

    expect(await save(first, 'not-the-session', 0, target, { text: 'x' })).toMatchObject({
      error: { code: 'validation' },
    })
    expect(
      await save(first, sessionId, 0, target, { text: 'x', preference: { modelId: 'gpt-5' } }),
    ).toMatchObject({ error: { code: 'validation' } })

    await saved(first, sessionId, 0, target, { text: 'Fix the flaky test' })
    // The phone saved on top of revision 1 too, then the laptop sent the message.
    await saved(second, sessionId, 1, target, { text: 'Fix the flaky test please' })
    expect(await remove(first, sessionId, 2)).toEqual({ draftId: sessionId, revision: 3 })

    // The phone's next keystroke was based on what it had before the send.
    expect(
      await save(second, sessionId, 2, target, { text: 'Fix the flaky test please!' }),
    ).toMatchObject({ error: { code: 'conflict', details: { revision: 3 } } })
    expect(await list(second)).toEqual({
      drafts: [],
      tombstones: [{ draftId: sessionId, revision: 3 }],
    })

    // Typed after the send was seen: the session's next draft.
    const next = await saved(first, sessionId, 3, target, { text: 'Now the docs' })
    expect(next).toMatchObject({ revision: 4, target })
    expect((await list(second)).drafts).toEqual([next])

    // A save or a clear from before the send, arriving late, is still
    // refused: it would replace or delete the draft written since.
    expect(
      await save(second, sessionId, 2, target, { text: 'Fix the flaky test please!' }),
    ).toMatchObject({ error: { code: 'conflict', details: { revision: 3 } } })
    expect(await removeRaw(second, sessionId, 2)).toMatchObject({
      error: { code: 'conflict', details: { draftId: sessionId, revision: 3 } },
    })
    expect((await list(second)).drafts).toEqual([next])
  })

  it('sends a new-session draft as the session it named, deleting it in the same write', async () => {
    const { host, scope, first, second } = await startHost()
    const watching = live(await replay(second, scope, null))
    const sessionId = randomUUID()
    const target: DraftTarget = { type: 'new_session', workspaceId: host.workspaceId, sessionId }
    await saved(first, 'draft-d', 0, target, { text: 'Ship it' })

    const created = await expectCommand(
      first,
      'session.create',
      {
        environmentId: host.server.identity.environmentId,
        providerId: 'cursor',
        workspaceId: host.workspaceId,
        firstMessage: 'Ship it',
        sessionId,
        draftId: 'draft-d',
      },
      'create',
    )
    expect(created.payload.session.sessionId).toBe(sessionId)

    // An autosave that was in flight when the send went out.
    expect(await save(second, 'draft-d', 1, target, { text: 'Ship it now' })).toMatchObject({
      error: { code: 'conflict' },
    })
    expect((await list(second)).drafts).toEqual([])

    const records = await collectThreadRecords(second, watching, (seen) =>
      draftEvents(seen).some((event) => event.name === 'draft.deleted'),
    )
    const created_ = records.findIndex((record) => record.event.name === 'session.created')
    const deleted = records.findIndex((record) => record.event.name === 'draft.deleted')
    expect(created_).toBeGreaterThanOrEqual(0)
    // One transaction: the deletion lands right behind the announcement.
    expect(deleted).toBeGreaterThan(created_)

    // The id is taken now.
    const again = first.command('session.create', {
      environmentId: host.server.identity.environmentId,
      providerId: 'cursor',
      workspaceId: host.workspaceId,
      sessionId,
    })
    expect(await nextResponse(first, again)).toMatchObject({ error: { code: 'conflict' } })
  })

  it('puts the draft back, as sent, when the session it was sent as is rolled back', async () => {
    const { host, scope, first, second } = await startHost({ failSessions: 1 })
    const watching = live(await replay(second, scope, null))
    const sessionId = randomUUID()
    const target: DraftTarget = { type: 'new_session', workspaceId: host.workspaceId, sessionId }
    // The last autosave; the send carries more than it did.
    await saved(first, 'draft-e', 0, target, { text: 'Try this' })

    const requestId = first.command('session.create', {
      environmentId: host.server.identity.environmentId,
      providerId: 'cursor',
      workspaceId: host.workspaceId,
      sessionId,
      draftId: 'draft-e',
      firstMessage: 'Try this, with the logs',
      preference: { modelId: 'gpt-5' },
    })
    expect(await nextResponse(first, requestId)).toMatchObject({ type: 'response' })

    // The provider refuses the session after the create answered.
    const records = await collectThreadRecords(second, watching, (seen) =>
      draftEvents(seen).some(
        (event) => event.name === 'draft.saved' && event.payload.draft.revision === 3,
      ),
    )
    expect(records.map((record) => record.event.name)).toEqual(
      expect.arrayContaining([
        'session.created',
        'draft.deleted',
        'session.deleted',
        'draft.saved',
      ]),
    )
    const [restored] = (await list(first)).drafts
    expect(restored).toMatchObject({
      draftId: 'draft-e',
      revision: 3,
      content: {
        text: 'Try this, with the logs',
        providerId: 'cursor',
        preference: { modelId: 'gpt-5' },
      },
      target,
    })

    // The retry may reuse the id the rolled-back session had.
    const retry = first.command('session.create', {
      environmentId: host.server.identity.environmentId,
      providerId: 'cursor',
      workspaceId: host.workspaceId,
      sessionId,
    })
    // Not refused as a taken id. (The fake provider is marked unhealthy by
    // the refusal, which is what answers here.)
    expect(await nextResponse(first, retry)).not.toMatchObject({ error: { code: 'conflict' } })
  })

  it("keeps a new-session draft when its project is removed, and drops a session's with the session", async () => {
    const { host, first } = await startHost()
    const session = await expectCommand(
      first,
      'session.create',
      {
        environmentId: host.server.identity.environmentId,
        providerId: 'cursor',
        workspaceId: host.workspaceId,
      },
      'create',
    )
    const sessionId = session.payload.session.sessionId
    await saved(first, sessionId, 0, { type: 'session', sessionId }, { text: 'goes with it' })
    const draft = await saved(
      first,
      'draft-f',
      0,
      { type: 'new_session', workspaceId: host.workspaceId, sessionId: randomUUID() },
      { text: 'stays' },
    )

    const requestId = first.command('workspace.remove', { workspaceId: host.workspaceId })
    expect(await nextResponse(first, requestId)).toMatchObject({ type: 'response' })

    expect((await list(first)).drafts).toEqual([
      { ...draft, target: { ...draft.target, workspaceId: null } },
    ])
    // A save naming the removed project keeps the draft, without the project.
    const after = await saved(first, 'draft-f', 1, draft.target, { text: 'still here' })
    expect(after.target).toMatchObject({ workspaceId: null })
  })
})

const IMAGE = Buffer.from('the bytes of a screenshot, as far as anyone can tell')

/** Upload an image for a draft in `workspaceId`, as the client holding `token`. */
async function uploadHeld(
  host: ProtocolHost,
  client: ProtocolClient,
  token: string,
  workspaceId: string,
) {
  const requestId = client.command('upload.ticket.create', {
    workspaceId,
    name: 'screenshot.png',
    mimeType: 'image/png',
    sizeBytes: IMAGE.byteLength,
  })
  const ticket = UploadResponseSchemas['upload.ticket.create'].parse(
    await nextResponse(client, requestId),
  ).payload
  const response = await fetch(`${host.server.url}${ticket.uploadPath}`, {
    method: 'PUT',
    headers: { 'content-type': 'image/png', authorization: `Bearer ${token}` },
    body: IMAGE,
  })
  expect(response.status).toBe(201)
  return UploadResultSchema.parse(await response.json()).artifactId
}

const read = (host: ProtocolHost, path: string, token: string) =>
  fetch(`${host.server.url}${path}`, { headers: { authorization: `Bearer ${token}` } })

/** The owner's laptop and a paired phone, as two clients of one environment. */
async function startDevices({ failSessions = 0 } = {}) {
  const started = await startHost({ failSessions })
  const { host } = started
  const phoneGrant = host.server.clients.issue({
    label: 'Phone',
    kind: 'paired',
    capabilities: ['read', 'operate', 'agent'],
  })
  const phone = await connectProtocol({ ...host, token: phoneGrant.credential })
  await handshake(phone)
  return { ...started, laptop: started.first, phone, phoneToken: phoneGrant.credential }
}

describe('images kept with a draft, across clients', () => {
  it('shows an image attached on one device on another, follows a project move, and is sent from there', async () => {
    const { host, laptop, phone, phoneToken } = await startDevices()
    const sessionId = randomUUID()
    const artifactId = await uploadHeld(host, laptop, host.token, host.workspaceId)
    const draft = await saved(
      laptop,
      'draft-img',
      0,
      { type: 'new_session', workspaceId: host.workspaceId, sessionId },
      { text: 'What is wrong here?', artifactIds: [artifactId] },
    )

    // The other device lists the draft and reads its image through it.
    const listed = (await list(phone)).drafts.find((each) => each.draftId === 'draft-img')
    expect(listed?.content.artifactIds).toEqual([artifactId])
    const bytes = await read(host, `/draft-artifacts/draft-img/${artifactId}`, phoneToken)
    expect(bytes.status).toBe(200)
    expect(bytes.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await bytes.arrayBuffer())).toEqual(IMAGE)
    const metadata = await read(
      host,
      `/draft-artifacts/draft-img/${artifactId}/metadata`,
      phoneToken,
    )
    expect(await metadata.json()).toMatchObject({ artifactId, mimeType: 'image/png' })
    // Only through a draft that names it, and never without a credential.
    expect(
      (await read(host, `/draft-artifacts/other-draft/${artifactId}`, phoneToken)).status,
    ).toBe(404)
    expect((await fetch(`${host.server.url}/draft-artifacts/draft-img/${artifactId}`)).status).toBe(
      401,
    )

    // The phone moves the draft to another project, and sends it from there.
    const otherRoot = join(host.dataDir, 'other-project')
    await mkdir(otherRoot)
    const added = ProofResponseSchemas['workspace.add'].parse(
      await nextResponse(laptop, laptop.command('workspace.add', { path: otherRoot })),
    ).payload
    const otherId = added.workspace.workspaceId
    await saved(
      phone,
      'draft-img',
      draft.revision,
      { type: 'new_session', workspaceId: otherId, sessionId },
      { text: 'What is wrong here?', artifactIds: [artifactId] },
    )
    const createId = phone.command('session.create', {
      environmentId: host.server.identity.environmentId,
      providerId: 'cursor',
      workspaceId: otherId,
      firstMessage: 'What is wrong here?',
      sessionId,
      draftId: 'draft-img',
      artifactIds: [artifactId],
    })
    const created = ProofResponseSchemas['session.create'].parse(
      await nextResponse(phone, createId),
    ).payload
    expect(created.session).toMatchObject({ sessionId, workspaceId: otherId })
    expect(created.firstTurn?.userMessage.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'artifact', artifactId })]),
    )
    // The session's now: read through the session, no longer through the draft.
    expect((await read(host, `/artifacts/${sessionId}/${artifactId}`, phoneToken)).status).toBe(200)
    expect((await read(host, `/draft-artifacts/draft-img/${artifactId}`, phoneToken)).status).toBe(
      404,
    )
  })

  it('frees the images of a discarded draft, and keeps them when the discard is refused', async () => {
    const { host, laptop, phone } = await startDevices()
    const target: DraftTarget = {
      type: 'new_session',
      workspaceId: host.workspaceId,
      sessionId: randomUUID(),
    }
    const first = await uploadHeld(host, laptop, host.token, host.workspaceId)
    const second = await uploadHeld(host, laptop, host.token, host.workspaceId)
    const seen = await saved(laptop, 'draft-gone', 0, target, { text: '', artifactIds: [first] })
    // The phone attaches another image after the laptop's discard was made.
    const since = await saved(phone, 'draft-gone', seen.revision, target, {
      text: '',
      artifactIds: [first, second],
    })
    const blob = (artifactId: string) => join(host.dataDir, 'uploads', artifactId)

    expect(await removeRaw(laptop, 'draft-gone', seen.revision, seen.revision)).toMatchObject({
      error: { code: 'conflict', details: { changed: true } },
    })
    expect(existsSync(blob(first))).toBe(true)
    expect(existsSync(blob(second))).toBe(true)

    // Discarded as it stands now: both go, bytes and all.
    expect(await removeRaw(laptop, 'draft-gone', since.revision, since.revision)).toMatchObject({
      type: 'response',
    })
    expect(existsSync(blob(first))).toBe(false)
    expect(existsSync(blob(second))).toBe(false)
    expect((await read(host, `/draft-artifacts/draft-gone/${first}`, host.token)).status).toBe(404)
  })

  it('puts a rolled-back draft back with its images', async () => {
    const { host, laptop, phone, phoneToken } = await startDevices({ failSessions: 1 })
    const sessionId = randomUUID()
    const target: DraftTarget = { type: 'new_session', workspaceId: host.workspaceId, sessionId }
    const artifactId = await uploadHeld(host, laptop, host.token, host.workspaceId)
    await saved(laptop, 'draft-back', 0, target, { text: 'Look', artifactIds: [artifactId] })

    // Sent from the phone, which did not upload it.
    const createId = phone.command('session.create', {
      environmentId: host.server.identity.environmentId,
      providerId: 'cursor',
      workspaceId: host.workspaceId,
      firstMessage: 'Look',
      sessionId,
      draftId: 'draft-back',
      artifactIds: [artifactId],
    })
    expect(await nextResponse(phone, createId)).toMatchObject({ type: 'response' })

    // The provider refuses the session after the create answered.
    let restored: Draft | undefined
    for (let attempt = 0; attempt < 100 && !restored; attempt += 1) {
      restored = (await list(laptop)).drafts.find((each) => each.draftId === 'draft-back')
      if (!restored) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(restored?.content).toMatchObject({ text: 'Look', artifactIds: [artifactId] })
    // Held again rather than deleted with the session, and readable through the draft.
    expect(existsSync(join(host.dataDir, 'uploads', artifactId))).toBe(true)
    expect((await read(host, `/draft-artifacts/draft-back/${artifactId}`, phoneToken)).status).toBe(
      200,
    )
  })
})
