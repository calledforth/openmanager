import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeConnectionFactory } from '@agentpack/runtime/testing'
import {
  ProofEventSchemas,
  ProofResponseSchemas,
  SEARCH_MESSAGES_CAPABILITY,
  SearchResponseSchemas,
  type ProofEvent,
} from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { createEventRepository, type DurableProofEvent } from '../src/db/event-repository.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { createMessageSearch, ftsQueryOf, snippetOf } from '../src/message-search.js'
import { SERVER_CAPABILITIES } from '../src/server.js'
import {
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  handshake,
  nextResponse,
  subscribe,
} from './helpers/protocol-client.js'
import { emitChunk, promptSessionId, startStubHost } from './helpers/proof-slice.js'

const directories: string[] = []
const databases: DatabaseSync[] = []
afterEach(async () => {
  await cleanupProtocolHosts()
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const T = (second: number) => `2026-11-10T10:00:${String(second).padStart(2, '0')}.000Z`

async function createDatabase(migrations = MIGRATIONS) {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-search-test-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory, migrations)
  databases.push(database)
  database.exec(`
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
    VALUES ('workspace-1', 'Workspace', '/workspace', 1, 1);
  `)
  return { database, directory }
}

function addSession(database: DatabaseSync, n: number, title: string | null = `Session ${n}`) {
  database
    .prepare(
      `INSERT INTO sessions (session_id, workspace_id, provider_id, title, status, created_at, updated_at)
       VALUES (?, 'workspace-1', 'cursor', ?, 'idle', 1, 1)`,
    )
    .run(`session-${n}`, title)
  database
    .prepare(
      `INSERT INTO threads (thread_id, session_id, workspace_id, created_at, updated_at)
       VALUES (?, ?, 'workspace-1', 1, 1)`,
    )
    .run(`thread-${n}`, `session-${n}`)
}

const scopeOf = (n: number) =>
  ({
    type: 'thread',
    environmentId: 'environment-1',
    sessionId: `session-${n}`,
    threadId: `thread-${n}`,
  }) as const

const event = (
  n: number,
  name: ProofEvent['name'],
  eventId: string,
  payload: unknown,
  at: string,
) =>
  (ProofEventSchemas[name] as { parse(input: unknown): DurableProofEvent }).parse({
    type: 'event',
    name,
    eventId: `${n}-${eventId}`,
    timestamp: at,
    scope: scopeOf(n),
    payload,
  })

/**
 * A turn in session `n`: the prompt, then the reply in two deltas, ended
 * unless `open`. Each turn of a session needs its own `turn` number.
 */
function turn(
  repository: ReturnType<typeof createEventRepository>,
  n: number,
  prompt: string,
  reply: [string, string] | [string],
  { turn: t = 1, open = false, second = 0 } = {},
) {
  const turnId = `turn-${n}-${t}`
  const at = T(second)
  repository.appendEvents(scopeOf(n), [
    event(
      n,
      'turn.started',
      `${turnId}-started`,
      {
        turn: { turnId, threadId: `thread-${n}`, state: 'running', startedAt: at },
        userMessage: {
          messageId: `user-${n}-${t}`,
          threadId: `thread-${n}`,
          turnId,
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      },
      at,
    ),
    ...reply.map((text, index) =>
      event(
        n,
        'message.delta',
        `${turnId}-delta-${index}`,
        {
          messageId: `assistant-${n}-${t}`,
          turnId,
          role: 'assistant',
          content: { type: 'text', text },
        },
        at,
      ),
    ),
  ])
  if (!open) {
    repository.finalizeTurn(scopeOf(n), [
      event(n, 'turn.completed', `${turnId}-completed`, { turnId }, at),
    ])
  }
  return turnId
}

const indexed = (database: DatabaseSync) =>
  database.prepare('SELECT message_id, body FROM message_text ORDER BY message_id').all()

describe('the search query', () => {
  it('makes every word a quoted prefix term', () => {
    expect(ftsQueryOf('tool pay')).toBe('"tool"* "pay"*')
    expect(ftsQueryOf('  Reconnect\tLOOP \n')).toBe('"Reconnect"* "LOOP"*')
  })

  it('reads nothing typed as FTS syntax', () => {
    expect(ftsQueryOf('a OR b')).toBe('"a"* "OR"* "b"*')
    expect(ftsQueryOf('say "hi" NEAR(x) -y col:z')).toBe(
      '"say"* """hi"""* "NEAR(x)"* "-y"* "col:z"*',
    )
  })

  it('drops words without a letter or digit, and is null when none are left', () => {
    expect(ftsQueryOf('- * " ()')).toBeNull()
    expect(ftsQueryOf('')).toBeNull()
    expect(ftsQueryOf('-- fix')).toBe('"fix"*')
  })

  it('stops at sixteen words', () => {
    expect(
      ftsQueryOf(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '))?.split(' '),
    ).toHaveLength(16)
  })
})

describe('snippets', () => {
  it('turns the markers into highlight ranges on one line', () => {
    expect(snippetOf('…the \u0002reconnect\u0003\n\n  \u0002loop\u0003 again…')).toEqual({
      snippet: '…the reconnect loop again…',
      highlights: [
        [5, 14],
        [15, 19],
      ],
    })
  })

  it('cuts a snippet too long to send and keeps the highlights that fit', () => {
    const long = `\u0002${'a'.repeat(3000)}\u0003`
    const { snippet, highlights } = snippetOf(long)
    expect(snippet).toHaveLength(2048)
    expect(snippet.endsWith('…')).toBe(true)
    expect(highlights).toEqual([[0, 2047]])
  })
})

describe('message search', () => {
  it('finds a turn once it has ended, by the words of the prompt and of the reply', async () => {
    const { database } = await createDatabase()
    addSession(database, 1, 'Sockets')
    const repository = createEventRepository(database)
    const search = createMessageSearch({ database })

    turn(
      repository,
      1,
      'Why does the socket keep dropping?',
      ['The reconnect ', 'loop never backs off.'],
      {
        open: true,
      },
    )
    // Still running: nothing is indexed until the turn ends.
    expect(search.search('reconnect')).toEqual([])

    repository.finalizeTurn(scopeOf(1), [
      event(1, 'turn.completed', 'completed', { turnId: 'turn-1-1' }, T(1)),
    ])
    expect(indexed(database)).toEqual([
      { message_id: 'assistant-1-1', body: 'The reconnect loop never backs off.' },
      { message_id: 'user-1-1', body: 'Why does the socket keep dropping?' },
    ])
    expect(search.search('reconnect loop')).toEqual([
      {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        title: 'Sockets',
        messageId: 'assistant-1-1',
        role: 'assistant',
        at: T(0),
        snippet: 'The reconnect loop never backs off.',
        highlights: [
          [4, 13],
          [14, 18],
        ],
        matches: 1,
      },
    ])
    expect(search.search('socket dropping')[0]).toMatchObject({
      messageId: 'user-1-1',
      role: 'user',
    })
  })

  it('matches in any order, any case and accent, by the start of each word', async () => {
    const { database } = await createDatabase()
    addSession(database, 1)
    const search = createMessageSearch({ database })
    turn(createEventRepository(database), 1, 'Tool Call Payloads', [
      'Running the migrations now, café.',
    ])

    for (const query of [
      'payloads tool',
      'TOOL CALL',
      'tool pay',
      'payload',
      'migration run',
      'cafe',
    ]) {
      expect(
        search.search(query).map((hit) => hit.sessionId),
        query,
      ).toEqual(['session-1'])
    }
    // Every word must appear, as the start of a word.
    expect(search.search('tool zebra')).toEqual([])
    expect(search.search('ayload')).toEqual([])
  })

  it('indexes interrupted and failed turns too', async () => {
    const { database } = await createDatabase()
    addSession(database, 1)
    addSession(database, 2)
    const repository = createEventRepository(database)
    turn(repository, 1, 'first prompt', ['stopped halfway'], { open: true })
    repository.finalizeTurn(scopeOf(1), [
      event(1, 'turn.interrupted', 'stop', { turnId: 'turn-1-1', reason: 'user' }, T(1)),
    ])
    turn(repository, 2, 'second prompt', ['gave up early'], { open: true })
    repository.finalizeTurn(scopeOf(2), [
      event(
        2,
        'turn.failed',
        'fail',
        { turnId: 'turn-2-1', reason: 'provider_error', message: 'boom' },
        T(1),
      ),
    ])
    const search = createMessageSearch({ database })
    expect(search.search('halfway').map((hit) => hit.sessionId)).toEqual(['session-1'])
    expect(search.search('early').map((hit) => hit.sessionId)).toEqual(['session-2'])
  })

  it('returns each session once, at its best message, best session first', async () => {
    const { database } = await createDatabase()
    addSession(database, 1, 'Mentions it once')
    addSession(database, 2, 'All about it')
    const repository = createEventRepository(database)
    turn(repository, 1, 'Something unrelated about the cache and the build.', [
      'We could also look at flicker later, among many other things.',
    ])
    turn(repository, 2, 'flicker', ['The flicker is the row remounting: flicker flicker.'])
    turn(repository, 2, 'is the flicker gone?', ['Yes, no flicker now.'], { turn: 2, second: 5 })

    const hits = createMessageSearch({ database }).search('flicker')
    expect(hits.map((hit) => [hit.sessionId, hit.matches])).toEqual([
      ['session-2', 4],
      ['session-1', 1],
    ])
    // Each snippet is cut from its own hit's message, not the first match's.
    expect(hits[1]?.messageId).toBe('assistant-1-1')
    expect(hits[1]?.snippet).toContain('flicker later')
  })

  it('keeps to the limit', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    for (let n = 1; n <= 5; n += 1) {
      addSession(database, n)
      turn(repository, n, `deploy number ${n}`, ['ok'])
    }
    const search = createMessageSearch({ database })
    expect(search.search('deploy')).toHaveLength(5)
    expect(search.search('deploy', 2)).toHaveLength(2)
  })

  it('finds nothing for a query without words, or one only of syntax', async () => {
    const { database } = await createDatabase()
    addSession(database, 1)
    turn(createEventRepository(database), 1, 'NEAR OR AND NOT', ['- * ( ) "'])
    const search = createMessageSearch({ database })
    expect(search.search('')).toEqual([])
    expect(search.search('   ')).toEqual([])
    expect(search.search('( * -')).toEqual([])
    // Syntax words are words when typed.
    expect(search.search('near or').map((hit) => hit.sessionId)).toEqual(['session-1'])
    expect(() => search.search('"unbalanced')).not.toThrow()
    expect(() => search.search('NEAR(a b')).not.toThrow()
  })

  it('leaves out text that is not message text', async () => {
    const { database } = await createDatabase()
    addSession(database, 1)
    const repository = createEventRepository(database)
    turn(repository, 1, 'hello', ['world'], { open: true })
    repository.appendEvents(scopeOf(1), [
      event(
        1,
        'message.reasoning',
        'thought',
        {
          messageId: 'thought-1',
          turnId: 'turn-1-1',
          phase: 'delta',
          content: { type: 'text', text: 'pondering secretly' },
        },
        T(1),
      ),
      event(
        1,
        'message.reasoning',
        'thought-end',
        { messageId: 'thought-1', turnId: 'turn-1-1', phase: 'stop' },
        T(1),
      ),
    ])
    repository.finalizeTurn(scopeOf(1), [
      event(1, 'turn.completed', 'completed', { turnId: 'turn-1-1' }, T(2)),
    ])
    expect(createMessageSearch({ database }).search('pondering')).toEqual([])
  })

  it('forgets a session when it is deleted, and its messages with it', async () => {
    const { database } = await createDatabase()
    addSession(database, 1)
    addSession(database, 2)
    const repository = createEventRepository(database)
    turn(repository, 1, 'shared word alpha', ['reply'])
    turn(repository, 2, 'shared word beta', ['reply'])
    const search = createMessageSearch({ database })
    expect(search.search('shared')).toHaveLength(2)

    database.prepare('DELETE FROM sessions WHERE session_id = ?').run('session-1')
    expect(search.search('shared').map((hit) => hit.sessionId)).toEqual(['session-2'])
    expect(search.search('alpha')).toEqual([])
    expect(indexed(database).map((row) => (row as { message_id: string }).message_id)).toEqual([
      'assistant-2-1',
      'user-2-1',
    ])
    // The index itself agrees with its content table.
    expect(() =>
      database.exec(`INSERT INTO message_search (message_search) VALUES ('integrity-check')`),
    ).not.toThrow()
  })

  it('keeps marker characters out of the index, so snippets cannot be forged', async () => {
    const { database } = await createDatabase()
    addSession(database, 1)
    turn(createEventRepository(database), 1, 'before \u0002fake\u0003 after', ['ok'])
    const [hit] = createMessageSearch({ database }).search('after')
    expect(hit?.snippet).toBe('before fake after')
    expect(hit?.highlights).toEqual([[12, 17]])
  })
})

describe('migration 29', () => {
  it('indexes every finished message already stored, and leaves open ones for their turn end', async () => {
    const { database, directory } = await createDatabase(MIGRATIONS.slice(0, 28))
    addSession(database, 1)
    // Projected by an older server, before the index existed.
    database.exec(`
      INSERT INTO turns (turn_id, thread_id, workspace_id, state, started_at, updated_at)
      VALUES ('turn-a', 'thread-1', 'workspace-1', 'completed', 1, 1),
             ('turn-b', 'thread-1', 'workspace-1', 'running', 2, 2);
      INSERT INTO messages (message_id, workspace_id, thread_id, turn_id, role, ordinal, is_final, created_at, updated_at)
      VALUES ('done', 'workspace-1', 'thread-1', 'turn-a', 'assistant', 0, 1, 1, 1),
             ('empty', 'workspace-1', 'thread-1', 'turn-a', 'user', 1, 1, 1, 1),
             ('open', 'workspace-1', 'thread-1', 'turn-b', 'assistant', 2, 0, 2, 2);
      INSERT INTO message_parts (part_id, message_id, ordinal, part_type, content_json, created_at, updated_at)
      VALUES ('p2', 'done', 2, 'text', '{"type":"text","text":"second part"}', 1, 1),
             ('p1', 'done', 0, 'text', '{"type":"text","text":"first part"}', 1, 1),
             ('p1b', 'done', 1, 'image', '{"type":"image","url":"x"}', 1, 1),
             ('p3', 'empty', 0, 'text', '{"type":"text","text":"   "}', 1, 1),
             ('p4', 'open', 0, 'text', '{"type":"text","text":"still typing"}', 2, 2);
    `)
    database.close()
    databases.splice(databases.indexOf(database), 1)

    const upgraded = openEnvironmentDatabase(directory)
    databases.push(upgraded)
    expect(indexed(upgraded)).toEqual([{ message_id: 'done', body: 'first part\nsecond part' }])
    const search = createMessageSearch({ database: upgraded })
    expect(search.search('first second').map((hit) => hit.messageId)).toEqual(['done'])
    expect(search.search('typing')).toEqual([])
  })
})

describe('search.messages over the socket', () => {
  it('is advertised, needs only read, and answers with ranked hits', async () => {
    expect(SERVER_CAPABILITIES).toContain(SEARCH_MESSAGES_CAPABILITY)
    const connections: FakeConnectionFactory = new FakeConnectionFactory({
      initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
      newSession: async () => ({ sessionId: 'stub-session' }),
      prompt: async (params) => {
        await emitChunk(
          connections,
          promptSessionId(params),
          'Backoff doubles up to thirty seconds.',
        )
        return { stopReason: 'end_turn' }
      },
    })
    const host = await startStubHost(connections)
    const client = await connectProtocol(host)
    const welcome = await handshake(client)
    expect(JSON.stringify(welcome)).toContain(SEARCH_MESSAGES_CAPABILITY)

    const createId = client.command('session.create', {
      environmentId: host.server.identity.environmentId,
      providerId: 'opencode',
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
    client.command('turn.send', {
      sessionId: session.sessionId,
      threadId: thread.threadId,
      text: 'how long is the reconnect backoff?',
    })
    await collectThreadRecords(client, subscriptionId, (records) =>
      records.some((record) => record.event.name === 'turn.completed'),
    )

    const searchId = client.command(SEARCH_MESSAGES_CAPABILITY, { query: 'backoff' })
    const { hits } = SearchResponseSchemas[SEARCH_MESSAGES_CAPABILITY].parse(
      await nextResponse(client, searchId),
    ).payload
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ sessionId: session.sessionId, matches: 2 })

    const invalidId = client.command(SEARCH_MESSAGES_CAPABILITY, { query: 'x', limit: 500 })
    expect(await nextResponse(client, invalidId)).toMatchObject({
      type: 'error',
      error: { code: 'validation' },
    })
  })
})
