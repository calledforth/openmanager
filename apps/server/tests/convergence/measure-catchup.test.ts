/**
 * Catch-up measurements on a COPY of a real environment database (F5).
 * Skipped unless `F5_MEASURE_DIR` names a directory holding `data/openmanager.sqlite`
 * (and its `-wal`), copied from a live environment. The copy is never written:
 * a second copy (`server/`) is made beside it, the server boots on that one
 * (which migrates it), and the in-process part reads it read-only.
 *
 * Writes `measure-<label>.json` into `F5_MEASURE_DIR`.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { it } from 'vitest'
import { WebSocket } from 'ws'
import {
  applySessionHistory,
  applySnapshot,
  cacheState,
  createEnvironmentStore,
  createInitialState,
  createWebSocketEnvironmentClient,
  type EnvironmentState,
  type EnvironmentStore,
  type WebSocketConstructor,
} from '@openmanager/environment-client'
import {
  FragmentAssembler,
  ProofResponseSchemas,
  ReplayResponseSchema,
  parseReplayResult,
  type ReplayCommand,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import { createReplayReader } from '../../src/db/replay.ts'
import { listSessionHistory, listSessionSummaries } from '../../src/db/session-store.ts'
import { readWorkspaces } from '../../src/db/workspace-rows.ts'
import { LinkProxy } from './link-proxy.ts'
import { ServerProcess } from './server-process.ts'

const DIR = process.env.F5_MEASURE_DIR
const LABEL = process.env.F5_MEASURE_LABEL ?? 'before'
const RUNS = 5

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const round = (value: number) => Math.round(value * 100) / 100
const time = <T>(fn: () => T): [T, number] => {
  const started = performance.now()
  const result = fn()
  return [result, performance.now() - started]
}
/** First run (cold, as a phone opening the app) and the median of `RUNS`. */
function bench<T>(fn: () => T): { first: number; median: number; result: T } {
  const samples: number[] = []
  let result!: T
  for (let run = 0; run < RUNS; run++) {
    const [value, ms] = time(fn)
    result = value
    samples.push(ms)
  }
  return { first: round(samples[0]!), median: round(median(samples)), result }
}

async function prepareServerCopy(dir: string) {
  const source = join(dir, 'data')
  const target = join(dir, 'server')
  await rm(target, { recursive: true, force: true })
  await mkdir(join(target, 'workspace'), { recursive: true })
  for (const name of ['openmanager.sqlite', 'openmanager.sqlite-wal']) {
    await copyFile(join(source, name), join(target, name)).catch(() => undefined)
  }
  // The environment id is the one the event log was written under, read from
  // the copy; identity.json itself is not copied.
  const pristine = new DatabaseSync(join(target, 'openmanager.sqlite'), { readOnly: true })
  const row = pristine
    .prepare(`SELECT json_extract(scope_key, '$[1]') AS id FROM event_streams LIMIT 1`)
    .get() as { id: string }
  pristine.close()
  await writeFile(
    join(target, 'identity.json'),
    JSON.stringify({ version: 1, environmentId: row.id, label: 'F5 measurement copy' }),
  )
  return { dataDir: target, workspaceRoot: join(target, 'workspace'), environmentId: row.id }
}

/** The server's and the client's costs for every catch-up shape, in one process. */
function inProcess(dataDir: string, environmentId: string) {
  const database = new DatabaseSync(join(dataDir, 'openmanager.sqlite'), { readOnly: true })
  const reader = createReplayReader(database, {
    epoch: 'measure',
    environment: () => ({ environmentId, name: 'measure' }),
    workspaces: () => readWorkspaces(database),
  })
  const threads = database
    .prepare(
      `SELECT t.thread_id, t.session_id,
         (SELECT COALESCE(SUM(LENGTH(CAST(p.content_json AS BLOB))), 0) FROM message_parts p
            JOIN messages m ON m.message_id = p.message_id WHERE m.thread_id = t.thread_id)
       + (SELECT COALESCE(SUM(LENGTH(CAST(a.state_json AS BLOB))), 0) FROM turn_activity a
            WHERE a.thread_id = t.thread_id) AS lower_bound
       FROM threads t ORDER BY lower_bound DESC`,
    )
    .all() as Array<{ thread_id: string; session_id: string; lower_bound: number }>

  const threadScope = (row: (typeof threads)[number]): SubscriptionScope => ({
    type: 'thread',
    environmentId,
    sessionId: row.session_id,
    threadId: row.thread_id,
  })
  const replayCommand = (scope: SubscriptionScope): ReplayCommand => ({
    type: 'command',
    requestId: 'measure',
    name: 'subscription.replay',
    payload: { scope, cursor: null },
  })
  /** The `subscription.replay` answer exactly as the socket builds and sends it. */
  const answerOf = (scope: SubscriptionScope) => {
    const result = reader.read(scope, null)
    if (result.mode !== 'snapshot') throw new Error('expected a snapshot')
    return JSON.stringify(
      ReplayResponseSchema.parse({
        type: 'response',
        requestId: 'measure',
        payload: {
          mode: 'snapshot',
          subscriptionId: 'measure',
          reason: 'initial',
          snapshot: result.snapshot,
        },
      }),
    )
  }
  /** Every history page of a thread, newest first, as `session.history` answers them. */
  const pagesOf = (row: (typeof threads)[number], limit?: number) => {
    const pages: string[] = []
    let cursor: { ordinal: number } | undefined
    for (;;) {
      const page = listSessionHistory(database, {
        sessionId: row.session_id,
        threadId: row.thread_id,
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit } : { limit: 100 }),
      })!
      pages.push(
        JSON.stringify(
          ProofResponseSchemas['session.history'].parse({
            type: 'response',
            requestId: 'measure',
            payload: page,
          }),
        ),
      )
      if (!page.nextCursor) return pages
      cursor = page.nextCursor
    }
  }

  // Sizes over every chat: the newest-100 snapshot main sends, and the whole chat.
  const sizes = threads.map((row) => {
    const first = Buffer.byteLength(answerOf(threadScope(row)))
    const whole = pagesOf(row, 1_000_000).reduce(
      (total, page) => total + Buffer.byteLength(page),
      0,
    )
    return { threadId: row.thread_id, first, whole }
  })
  const quantile = (values: number[], q: number) =>
    [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))]!
  const wholeSizes = sizes.map((size) => size.whole)

  const largest = threads.slice(0, 3).map((row) => {
    const scope = threadScope(row)
    const build = bench(() => answerOf(scope))
    const text = build.result
    const parse = bench(() => JSON.parse(text) as unknown)
    const validate = bench(() => parseReplayResult(replayCommand(scope), parse.result))
    const payload = validate.result
    if (payload.type !== 'response' || payload.payload.mode !== 'snapshot') throw new Error('shape')
    const snapshot = payload.payload.snapshot
    const apply = bench(() => applySnapshot(createInitialState(), snapshot))
    // Main's whole chat: the snapshot, then every older page loaded on scroll.
    const pageBuild = bench(() => pagesOf(row))
    const older = pageBuild.result.slice(1)
    const olderBytes = older.reduce((total, page) => total + Buffer.byteLength(page), 0)
    const olderClient = bench(() => {
      let state: EnvironmentState = applySnapshot(createInitialState(), snapshot)
      for (const page of older) {
        const parsed = ProofResponseSchemas['session.history'].parse(JSON.parse(page))
        state = applySessionHistory(
          state,
          { threadId: row.thread_id, sessionId: row.session_id },
          parsed.payload,
          true,
        )
      }
      return state
    })
    // The whole chat as one answer (what F5 sends): one page with no limit.
    const whole = pagesOf(row, 1_000_000)[0]!
    const wholeParse = bench(() => ProofResponseSchemas['session.history'].parse(JSON.parse(whole)))
    return {
      threadId: row.thread_id,
      messages: (
        database
          .prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?')
          .get(row.thread_id) as {
          n: number
        }
      ).n,
      firstPage: {
        bytes: Buffer.byteLength(text),
        serverBuildMs: build,
        clientParseMs: { first: parse.first, median: parse.median },
        clientValidateMs: { first: validate.first, median: validate.median },
        clientApplyMs: { first: apply.first, median: apply.median },
      },
      olderPages: {
        count: older.length,
        bytes: olderBytes,
        serverBuildAllPagesMs: { first: pageBuild.first, median: pageBuild.median },
        clientParseValidateApplyMs: { first: olderClient.first, median: olderClient.median },
      },
      wholeAsOneAnswer: {
        bytes: Buffer.byteLength(whole),
        clientParseValidateMs: { first: wholeParse.first, median: wholeParse.median },
      },
    }
  })

  // The environment: main's snapshot (newest 100) and every session.
  const environment: SubscriptionScope = { type: 'environment', environmentId }
  const envBuild = bench(() => answerOf(environment))
  const envParse = bench(() =>
    parseReplayResult(replayCommand(environment), JSON.parse(envBuild.result)),
  )
  const envPayload = envParse.result
  if (envPayload.type !== 'response' || envPayload.payload.mode !== 'snapshot')
    throw new Error('env')
  const envSnapshot = envPayload.payload.snapshot
  const envApply = bench(() => applySnapshot(createInitialState(), envSnapshot))
  const everySession = bench(() =>
    JSON.stringify(listSessionSummaries(database, { limit: 1_000_000 })),
  )
  const counts = {
    sessions: (database.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
    threads: threads.length,
    events: (database.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n,
  }
  database.close()
  return {
    counts,
    chatSizes: {
      firstSnapshotBytes: {
        p50: quantile(
          sizes.map((s) => s.first),
          0.5,
        ),
        p90: quantile(
          sizes.map((s) => s.first),
          0.9,
        ),
        max: Math.max(...sizes.map((s) => s.first)),
      },
      wholeChatBytes: {
        p50: quantile(wholeSizes, 0.5),
        p90: quantile(wholeSizes, 0.9),
        max: Math.max(...wholeSizes),
        total: wholeSizes.reduce((a, b) => a + b, 0),
      },
      chatsLargerThanFirstSnapshot: sizes.filter((s) => s.whole > s.first * 1.05).length,
    },
    largest,
    environment: {
      snapshotBytes: Buffer.byteLength(envBuild.result),
      sessionsInSnapshot:
        envSnapshot.cursor.scope.type === 'environment'
          ? (envSnapshot.state as { sessions: unknown[] }).sessions.length
          : 0,
      serverBuildMs: { first: envBuild.first, median: envBuild.median },
      clientParseValidateMs: { first: envParse.first, median: envParse.median },
      clientApplyMs: { first: envApply.first, median: envApply.median },
      everySessionBytes: Buffer.byteLength(everySession.result),
      everySessionBuildMs: { first: everySession.first, median: everySession.median },
    },
    largestThread: threads[0]!,
  }
}

// ---------------------------------------------------------------------------
// End to end: the real server on the copy, a shaped link, the real client.
// ---------------------------------------------------------------------------

type Received = { at: number; bytes: number; listenerMs: number; tag: string }

function instrumentedClient(
  url: string,
  credential: string,
  environmentId: string,
  store: EnvironmentStore,
  log: { received: Received[]; updateMs: number; inListener: boolean; sentAt: Map<string, string> },
) {
  const update = store.update.bind(store)
  store.update = (reducer) => {
    if (log.inListener) return update(reducer)
    const started = performance.now()
    update(reducer)
    log.updateMs += performance.now() - started
  }
  class MeasuredWebSocket extends WebSocket {
    constructor(_url: string, protocols?: string[]) {
      super(url, protocols)
      const assembler = new FragmentAssembler()
      const partial = { bytes: 0, listenerMs: 0 }
      const add = this.addEventListener.bind(this) as (
        type: string,
        listener: (event: unknown) => void,
      ) => void
      ;(this as unknown as { addEventListener: typeof add }).addEventListener = (type, listener) =>
        add(
          type,
          type === 'message'
            ? (event) => {
                const data = (event as { data: unknown }).data
                // A binary frame is a fragment (protocol v19): the message it
                // belongs to is counted once, at its last fragment.
                let text: string | undefined
                let bytes: number
                if (typeof data === 'string') {
                  text = data
                  bytes = Buffer.byteLength(data)
                } else {
                  const frame =
                    data instanceof ArrayBuffer
                      ? new Uint8Array(data)
                      : new Uint8Array(
                          (data as Uint8Array).buffer,
                          (data as Uint8Array).byteOffset,
                          (data as Uint8Array).byteLength,
                        )
                  bytes = frame.byteLength
                  const whole = assembler.push(frame.slice())
                  if (whole) text = Buffer.from(whole).toString('utf8')
                }
                const started = performance.now()
                log.inListener = true
                try {
                  listener(event)
                } finally {
                  log.inListener = false
                }
                partial.bytes += bytes
                partial.listenerMs += performance.now() - started
                if (text === undefined) return
                log.received.push({
                  at: started,
                  bytes: partial.bytes,
                  listenerMs: partial.listenerMs,
                  tag: tagOf(text, log.sentAt),
                })
                partial.bytes = 0
                partial.listenerMs = 0
              }
            : listener,
        )
    }
    override send(data: unknown, ...rest: unknown[]): void {
      try {
        const message = JSON.parse(String(data)) as {
          requestId?: string
          name?: string
          payload?: { scope?: { type?: string } }
        }
        if (message.requestId && message.name) {
          const scope = message.payload?.scope?.type
          log.sentAt.set(message.requestId, scope ? `${message.name}:${scope}` : message.name)
        }
      } catch {
        // not JSON
      }
      ;(super.send as (...args: unknown[]) => void)(data, ...rest)
    }
  }
  return createWebSocketEnvironmentClient({
    url,
    credential,
    environmentId,
    store,
    WebSocket: MeasuredWebSocket as unknown as WebSocketConstructor,
    reconnect: { initialDelayMs: 100, maxDelayMs: 2_000 },
  })
}

function tagOf(text: string, sentAt: Map<string, string>): string {
  const head = text.slice(0, 200)
  const id = /"requestId":"([^"]+)"/.exec(head)?.[1]
  if (id && sentAt.has(id)) return sentAt.get(id)!
  const name = /"name":"([^"]+)"/.exec(head)?.[1]
  return name ?? (head.startsWith('{"type":"ping"') ? 'ping' : 'other')
}

const until = async (check: () => boolean, label: string, timeoutMs = 600_000) => {
  const started = performance.now()
  while (!check()) {
    if (performance.now() - started > timeoutMs) throw new Error(`timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const PROFILES = [
  { name: 'loopback', shape: undefined },
  { name: 'mobile (2 Mbit/s, 75 ms)', shape: { down: 250_000, up: 100_000, latencyMs: 75 } },
  { name: 'slow (320 kbit/s, 150 ms)', shape: { down: 40_000, up: 20_000, latencyMs: 150 } },
] as const

async function endToEnd(
  proxies: LinkProxy[],
  server: ServerProcess,
  credential: string,
  environmentId: string,
  largest: { session_id: string; thread_id: string },
) {
  const results: unknown[] = []
  for (const [index, profile] of PROFILES.entries()) {
    const proxy = proxies[index]!
    proxy.setTarget(server.port)
    if (profile.shape) {
      proxy.throttle('down', profile.shape.down, 256 * 1024)
      proxy.throttle('up', profile.shape.up, 64 * 1024)
      proxy.latency(profile.shape.latencyMs)
    }
    const run = async (seed: EnvironmentState | undefined) => {
      const log = { received: [] as Received[], updateMs: 0, inListener: false, sentAt: new Map() }
      const store = createEnvironmentStore(seed)
      const client = instrumentedClient(proxy.url, credential, environmentId, store, log)
      const started = performance.now()
      const marks: Record<string, number> = {}
      const mark = (name: string) => {
        marks[name] = round(performance.now() - started)
      }
      client.connect()
      await until(() => client.getState().connection.phase === 'connected', 'connected')
      mark('handshake')
      const total = (await server.readSessions()).length
      await until(
        () => Object.keys(client.getState().sessions).length >= Math.min(total, 100),
        'sidebar',
      )
      mark('sidebarFirstPage')
      await until(() => Object.keys(client.getState().sessions).length >= total, 'every session')
      mark('sidebarEverySession')
      const opened = performance.now()
      await client.commands.openSession(largest.session_id)
      mark('chatOpenNewestPage')
      const openMs = performance.now() - opened
      for (;;) {
        const cursor = client.getState().threads[largest.thread_id]?.historyCursor
        if (!cursor) break
        await client.commands.loadSessionHistory({
          sessionId: largest.session_id,
          threadId: largest.thread_id,
          cursor,
        })
      }
      mark('chatWhole')
      const state = client.getState()
      const received = log.received
      const sum = (filter: (r: Received) => boolean, key: 'bytes' | 'listenerMs') =>
        round(received.filter(filter).reduce((t, r) => t + r[key], 0))
      const byTag: Record<string, { count: number; bytes: number; listenerMs: number }> = {}
      for (const r of received) {
        const entry = (byTag[r.tag] ??= { count: 0, bytes: 0, listenerMs: 0 })
        entry.count += 1
        entry.bytes += r.bytes
        entry.listenerMs = round(entry.listenerMs + r.listenerMs)
      }
      client.dispose()
      return {
        marksMs: marks,
        openLargestMs: round(openMs),
        bytesDown: sum(() => true, 'bytes'),
        clientListenerMs: sum(() => true, 'listenerMs'),
        clientUpdateOutsideListenerMs: round(log.updateMs),
        byTag,
        messages: state.threads[largest.thread_id]?.messages.length ?? 0,
        finalState: state,
      }
    }
    const cold = await run(undefined)
    const seeded = cacheState(cold.finalState)
    const reload = await run(seeded)
    const strip = ({ finalState: _, ...rest }: typeof cold) => rest
    results.push({
      profile: profile.name,
      shape: profile.shape ?? null,
      cold: strip(cold),
      reloadWithCache: strip(reload),
    })
  }
  return results
}

const run = DIR ? it : it.skip

run('catch-up measurements on a copy of a real database', { timeout: 3_600_000 }, async () => {
  const dir = DIR!
  const { dataDir, workspaceRoot, environmentId } = await prepareServerCopy(dir)
  const proxies = await Promise.all(PROFILES.map(() => LinkProxy.start()))
  // Boot: migrates the copy, raises replay floors, and runs boot recovery.
  const server = await ServerProcess.start({
    dataDir,
    workspaceRoot,
    allowedHosts: proxies.flatMap((proxy) => [
      `127.0.0.1:${proxy.port}`,
      `localhost:${proxy.port}`,
    ]),
    newSessionDelayMs: 0,
  })
  try {
    const credential = (await readFile(join(dataDir, 'owner-credential'), 'utf8')).trim()
    const measured = inProcess(dataDir, environmentId)
    const e2e = await endToEnd(proxies, server, credential, environmentId, measured.largestThread)
    const strip = (value: unknown) =>
      JSON.parse(JSON.stringify(value, (key, inner) => (key === 'result' ? undefined : inner)))
    const report = {
      label: LABEL,
      node: process.version,
      measuredAt: new Date().toISOString(),
      inProcess: strip(measured),
      endToEnd: e2e,
    }
    await writeFile(join(dir, `measure-${LABEL}.json`), JSON.stringify(report, null, 2))
  } finally {
    await server.stop()
    for (const proxy of proxies) await proxy.close()
  }
})
