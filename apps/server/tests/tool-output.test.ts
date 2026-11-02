import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProofEventSchemas, applyToolUpdate, type ProofEvent } from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { coalesceDeltas, createStreamingEventBatcher } from '../src/db/event-batcher.js'
import { createEventRepository, type DurableProofEvent } from '../src/db/event-repository.js'
import { readThreadState } from '../src/db/session-store.js'
import { createToolOutputStore, withSettledText } from '../src/db/tool-output.js'
import { createAuditLog } from '../src/audit.js'
import type { AuthenticatedClient } from '../src/authorized-clients.js'
import { createRateLimiter } from '../src/rate-limit.js'
import { createUploadService } from '../src/uploads.js'

const scope = {
  type: 'thread',
  environmentId: 'environment-1',
  sessionId: 'session-1',
  threadId: 'thread-1',
} as const

let sequence = 0
const event = (name: ProofEvent['name'], payload: unknown) =>
  (ProofEventSchemas[name] as { parse(input: unknown): DurableProofEvent }).parse({
    type: 'event',
    name,
    eventId: `event-${(sequence += 1)}`,
    timestamp: '2026-11-02T10:00:00.000Z',
    scope,
    payload,
  })
const tool = (payload: Record<string, unknown>, toolCallId = 'tool-1') =>
  event('tool.updated', { toolCallId, turnId: 'turn-1', ...payload }) as Extract<
    DurableProofEvent,
    { name: 'tool.updated' }
  >

describe('coalesceDeltas', () => {
  it('folds bare deltas of one call into one event', () => {
    const merged = coalesceDeltas([
      tool({ outputDelta: 'a' }),
      tool({ outputDelta: 'b' }),
      tool({ outputDelta: 'c' }),
    ])
    expect(merged).toHaveLength(1)
    expect((merged[0] as ReturnType<typeof tool>).payload.outputDelta).toBe('abc')
  })

  it('keeps calls apart, and their order', () => {
    const merged = coalesceDeltas([
      tool({ outputDelta: 'a' }),
      tool({ outputDelta: 'x' }, 'tool-2'),
      tool({ outputDelta: 'b' }),
    ])
    expect(merged.map((item) => (item as ReturnType<typeof tool>).payload.outputDelta)).toEqual([
      'a',
      'x',
      'b',
    ])
  })

  it('never folds an update that says anything else', () => {
    expect(
      coalesceDeltas([
        tool({ outputDelta: 'a' }),
        tool({ status: 'in_progress', outputDelta: 'b' }),
      ]),
    ).toHaveLength(2)
  })
})

describe('the batcher and tool deltas', () => {
  const batcher = () => {
    const writes: DurableProofEvent[][] = []
    const stream = createStreamingEventBatcher<DurableProofEvent>(
      (_, events) => writes.push([...events]),
      { maxWaitMs: 60_000 },
    )
    return { writes, stream }
  }

  it('holds bare deltas and writes them as one record', () => {
    const { writes, stream } = batcher()
    for (const text of ['a', 'b', 'c']) stream.append(tool({ outputDelta: text }))
    expect(writes).toHaveLength(0)
    stream.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toHaveLength(1)
    stream.close()
  })

  it('writes held deltas before an update that settles the call', () => {
    const { writes, stream } = batcher()
    stream.append(tool({ outputDelta: 'a' }))
    stream.append(tool({ status: 'completed', outputBytes: 1 }))
    expect(writes.flat().map((item) => (item as ReturnType<typeof tool>).payload.status)).toEqual([
      undefined,
      'completed',
    ])
    stream.close()
  })
})

describe('text after a call settled', () => {
  const directories: string[] = []
  const databases: DatabaseSync[] = []
  afterEach(async () => {
    for (const database of databases.splice(0)) database.close()
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    )
  })

  async function repository() {
    const directory = await mkdtemp(join(tmpdir(), 'openmanager-tool-output-test-'))
    directories.push(directory)
    const database = openEnvironmentDatabase(directory)
    databases.push(database)
    database.exec(`
      INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
      VALUES ('workspace-1', 'Workspace', '/workspace', 1, 1);
      INSERT INTO sessions (session_id, workspace_id, provider_id, status, created_at, updated_at)
      VALUES ('session-1', 'workspace-1', 'cursor', 'idle', 1, 1);
      INSERT INTO threads (thread_id, session_id, workspace_id, created_at, updated_at)
      VALUES ('thread-1', 'session-1', 'workspace-1', 1, 1);
      INSERT INTO turns (turn_id, thread_id, workspace_id, state, started_at, updated_at)
      VALUES ('turn-1', 'thread-1', 'workspace-1', 'running', 1, 1);
    `)
    return {
      database,
      write: createEventRepository(database),
      store: createToolOutputStore(database),
    }
  }

  it('leaves the store and the row as a client holds them', async () => {
    const { database, write, store } = await repository()
    const events = [
      tool({ status: 'in_progress', outputDelta: 'running' }),
      withSettledText(tool({ status: 'completed', outputBytes: 5 }), 'final'),
      tool({ status: 'in_progress', outputDelta: ' late' }),
      tool({ output: 'replaced late' }),
    ]
    write.appendEvents(scope, events)
    expect(store.read('tool-1')).toBe('final')
    expect(store.bytes('tool-1')).toBe(5)
    const held = events.reduce(
      (state, item) => applyToolUpdate(state, item.payload),
      undefined as ReturnType<typeof applyToolUpdate> | undefined,
    )
    const stored = readThreadState(database, { sessionId: 'session-1', threadId: 'thread-1' })
    expect(stored?.tools[0]).toEqual(held)
    expect(held?.output).toBeUndefined()
  })

  it('keeps the text a call settled with, whatever settles it again', async () => {
    const { write, store } = await repository()
    write.appendEvents(scope, [
      withSettledText(tool({ status: 'completed', outputBytes: 5 }), 'first'),
      withSettledText(tool({ status: 'failed', outputBytes: 7 }), 'another'),
    ])
    expect(store.read('tool-1')).toBe('first')
  })

  it('still takes the text a later failure brings to a refused call', async () => {
    const { write, store } = await repository()
    write.appendEvents(scope, [
      tool({ status: 'in_progress' }),
      tool({ status: 'declined' }),
      withSettledText(tool({ status: 'failed', outputBytes: 7 }), 'refused'),
    ])
    expect(store.read('tool-1')).toBe('refused')
  })
})

describe('GET /tool-output', () => {
  const servers: Server[] = []
  const directories: string[] = []
  const databases: DatabaseSync[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))))
    for (const database of databases.splice(0)) database.close()
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    )
  })

  const clients: Record<string, Partial<AuthenticatedClient>> = {
    reader: { clientId: 'reader', capabilities: ['read'] },
    blind: { clientId: 'blind', capabilities: [] },
  }

  async function route(
    toolOutput: () => { text: string; workspaceId: string } | undefined,
    sessionWorkspace = vi.fn(() => 'workspace-1'),
  ) {
    const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-tool-route-test-'))
    directories.push(dataDir)
    const database = openEnvironmentDatabase(dataDir)
    databases.push(database)
    const log = () => undefined
    const uploads = createUploadService({
      dataDir,
      database,
      audit: createAuditLog(log),
      log,
      rateLimiter: createRateLimiter(),
      authenticate: (credential) => clients[credential ?? ''] as AuthenticatedClient | undefined,
      sessionWorkspace,
      toolOutput,
      resolveWorkspace: () => ({}),
    })
    const server = createServer((request, response) => {
      uploads.handle(request, response)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return (credential?: string) =>
      fetch(`http://127.0.0.1:${port}/tool-output/session-1/tool-1`, {
        headers: credential ? { authorization: `Bearer ${credential}` } : {},
      })
  }

  const found = () => ({ text: 'héllo', workspaceId: 'workspace-1' })

  it('answers the text, uncached, without flushing the write batch', async () => {
    const sessionWorkspace = vi.fn(() => 'workspace-1')
    const read = await route(found, sessionWorkspace)
    const response = await read('reader')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('héllo')
    expect(sessionWorkspace).not.toHaveBeenCalled()
  })

  it('refuses a revoked credential and none at all', async () => {
    const read = await route(found)
    expect((await read('revoked')).status).toBe(401)
    expect((await read()).status).toBe(401)
  })

  it('finds nothing for a client without read', async () => {
    const read = await route(found)
    expect((await read('blind')).status).toBe(404)
  })

  it('finds nothing for a tool with no text', async () => {
    const read = await route(() => undefined)
    expect((await read('reader')).status).toBe(404)
  })

  it('answers 503 when the store fails, and keeps serving', async () => {
    let broken = true
    const read = await route(() => {
      if (broken) throw new Error('database is locked')
      return found()
    })
    const failed = await read('reader')
    expect(failed.status).toBe(503)
    expect(await failed.json()).toMatchObject({ error: { code: 'unavailable' } })
    broken = false
    expect((await read('reader')).status).toBe(200)
  })
})
