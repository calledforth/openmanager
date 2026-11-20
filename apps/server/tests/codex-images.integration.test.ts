import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClaudeSdk, FakeConnectionFactory } from '@agentpack/runtime/testing'
import { ProofResponseSchemas } from '@openmanager/protocol/node'
import type { ServerConfig } from '../src/config.js'
import { openEnvironmentDatabase } from '../src/db/database.js'
import {
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  handshake,
  nextResponse,
  startProtocolHost,
  subscribe,
  type ProtocolHost,
} from './helpers/protocol-client.js'

/**
 * Codex's images, end to end: a fake app-server says where an image is (a
 * generated image's temporary file, a file the model looked at), the real
 * runtime reads it, and the environment keeps it as the session's artifact,
 * filed in the reply under the call that produced it.
 */

/** The Codex fakes (`@agentpack/runtime/testing/codex`) are TypeScript
 * source, which this package's typecheck cannot take in (`erasableSyntaxOnly`);
 * vitest loads them, so the specifier is not one the checker follows, and
 * what is used of them is typed here by hand. */
type FakeCodexTurn = {
  started(): void
  imageGeneration(completed?: Record<string, unknown>): unknown
  imageView(path: string): unknown
  agentMessage(text: string, options?: { phase?: 'final_answer' }): unknown
  completed(): void
}
type CodexStart = NonNullable<NonNullable<ServerConfig['runtimeOptions']>['codexStart']>
const CODEX_TESTING: string = '@agentpack/runtime/testing/codex'
const { fakeCodexStarter } = (await import(/* @vite-ignore */ CODEX_TESTING)) as {
  fakeCodexStarter: (
    setup: (server: { serveThreads(onTurn: (turn: FakeCodexTurn) => void): unknown }) => void,
  ) => { start: CodexStart }
}

const directories: string[] = []

afterEach(async () => {
  await cleanupProtocolHosts()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)

async function codexHost(script: (turn: FakeCodexTurn) => void | Promise<void>) {
  const codex = fakeCodexStarter((server) => {
    server.serveThreads((turn) => void script(turn))
  })
  const host = await startProtocolHost({
    runtimeOptions: {
      connections: new FakeConnectionFactory({}),
      claudeSdk: new FakeClaudeSdk(),
      codexStart: codex.start,
      health: { schedule: () => ({ cancel() {} }) },
    },
  })
  return host
}

async function runTurn(host: ProtocolHost) {
  const client = await connectProtocol(host)
  await handshake(client)
  const createId = client.command('session.create', {
    environmentId: host.server.identity.environmentId,
    providerId: 'codex',
    workspaceId: host.workspaceId,
  })
  const { session, thread } = ProofResponseSchemas['session.create'].parse(
    await nextResponse(client, createId),
  ).payload
  const subscriptionId = await subscribe(client, {
    type: 'thread',
    environmentId: host.server.identity.environmentId,
    sessionId: session.sessionId,
    threadId: thread.threadId,
  })
  const sendId = client.command('turn.send', {
    sessionId: session.sessionId,
    threadId: thread.threadId,
    text: 'draw a circle',
  })
  await nextResponse(client, sendId)
  const records = await collectThreadRecords(client, subscriptionId, (seen) =>
    seen.some((record) => /^turn\.(completed|failed|interrupted)$/.test(record.event.name)),
  )
  return { sessionId: session.sessionId, records }
}

function generatedRows(dataDir: string) {
  const database = openEnvironmentDatabase(dataDir)
  try {
    return database
      .prepare(
        `SELECT attachment_id, session_id, source, mime_type, size_bytes, metadata_json
         FROM attachments WHERE source = 'generated'`,
      )
      .all() as Record<string, unknown>[]
  } finally {
    database.close()
  }
}

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-images-test-'))
  directories.push(dir)
  return dir
}

describe('Codex images', () => {
  it('copies a generated image into the store before its temporary file goes, with its call', async () => {
    const dir = await scratch()
    const savedPath = join(dir, 'ig-1.png')
    const host = await codexHost(async (turn) => {
      turn.started()
      await writeFile(savedPath, PNG)
      turn.imageGeneration({ savedPath })
      // Codex's temporary file is gone the moment the item has been read.
      await rm(savedPath)
      turn.agentMessage('Here it is.', { phase: 'final_answer' })
      turn.completed()
    })
    const { sessionId, records } = await runTurn(host)

    const rows = generatedRows(host.dataDir)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      session_id: sessionId,
      mime_type: 'image/png',
      size_bytes: PNG.byteLength,
    })
    const artifactId = rows[0]!.attachment_id as string
    expect(await readFile(join(host.dataDir, 'uploads', artifactId))).toEqual(PNG)

    // The row is the generation; the image is filed in the reply after it,
    // under its id, and the store says which call it came from.
    const tool = records.find(
      (record) =>
        record.event.name === 'tool.updated' &&
        (record.event.payload as { toolName?: string }).toolName === 'imageGeneration',
    )
    const toolCallId = (tool!.event.payload as { toolCallId: string }).toolCallId
    expect(JSON.parse(rows[0]!.metadata_json as string)).toEqual({
      sessionId,
      source: 'generated',
      toolCallId,
    })
    const image = records.find(
      (record) =>
        record.event.name === 'message.delta' &&
        (record.event.payload as { content: { type: string } }).content.type === 'artifact',
    )
    expect(image!.event.payload).toMatchObject({
      role: 'assistant',
      content: { type: 'artifact', artifactId, mimeType: 'image/png', toolCallId },
    })
    expect(records.indexOf(tool!)).toBeLessThan(records.indexOf(image!))
    const settled = records.filter(
      (record) =>
        record.event.name === 'tool.updated' &&
        (record.event.payload as { toolCallId: string }).toolCallId === toolCallId,
    )
    expect(settled.at(-1)!.event.payload).toMatchObject({ status: 'completed' })
    // The bytes are in the store, never in the event log.
    expect(JSON.stringify(records)).not.toContain(PNG.toString('base64'))
  })

  it('shows the image the model looked at, and stores nothing for one it cannot show', async () => {
    const dir = await scratch()
    const shot = join(dir, 'shot.png')
    await writeFile(shot, PNG)
    const host = await codexHost((turn) => {
      turn.started()
      turn.imageView(shot)
      turn.imageView(join(dir, 'missing.png'))
      turn.completed()
    })
    const { records } = await runTurn(host)

    const rows = generatedRows(host.dataDir)
    expect(rows).toHaveLength(1)
    const reads = records.filter(
      (record) =>
        record.event.name === 'tool.updated' &&
        (record.event.payload as { toolName?: string }).toolName === 'imageView',
    )
    const ids = [...new Set(reads.map((record) => (record.event.payload as { toolCallId: string }).toolCallId))]
    expect(ids).toHaveLength(2)
    expect(JSON.parse(rows[0]!.metadata_json as string)).toMatchObject({ toolCallId: ids[0] })
    const last = (id: string) =>
      records
        .filter(
          (record) =>
            record.event.name === 'tool.updated' &&
            (record.event.payload as { toolCallId: string }).toolCallId === id,
        )
        .at(-1)!.event.payload
    expect(last(ids[0]!)).toMatchObject({ status: 'completed' })
    // The one it could not show fails with why, which the row opens on.
    expect(last(ids[1]!)).toMatchObject({ status: 'failed', outputBytes: expect.any(Number) })
  })

  it('stores nothing for a generation Codex could not finish, and the row fails', async () => {
    const host = await codexHost((turn) => {
      turn.started()
      turn.imageGeneration({
        status: 'failed',
        failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: null },
      })
      turn.completed()
    })
    const { records } = await runTurn(host)
    expect(generatedRows(host.dataDir)).toEqual([])
    const settled = records
      .filter(
        (record) =>
          record.event.name === 'tool.updated' &&
          (record.event.payload as { status?: string }).status !== undefined,
      )
      .at(-1)
    expect(settled!.event.payload).toMatchObject({
      toolName: 'imageGeneration',
      status: 'failed',
      outputBytes: 'The image generation limit was reached.'.length,
    })
  })
})
