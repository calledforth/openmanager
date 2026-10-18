/**
 * The §8.4 scenarios of docs/sync-foundations.md against today's server.
 *
 * Three buckets:
 *   - known divergence on main: the scenario passes only when it produced the
 *     documented failure for the documented reason (see evidence.ts). When a
 *     later phase fixes it, it fails with "now converges ... flip it";
 *   - regression guard: the property must hold, now and after every phase;
 *   - not runnable on main: the seam does not exist yet (todo, construction
 *     written out).
 */
import { describe, expect } from 'vitest'
import {
  ENVIRONMENT_SNAPSHOT_NEVER_REMOVES,
  REASONING_BUDGET_MARKER,
  RUNTIME_STAMP,
  SESSION_CREATED_PARTIAL,
  SILENT_RECOVERY,
  SNAPSHOT_MERGE_DROPS_OLDER_ACTIVITY,
  THOUGHT_CLOSED_BY_FOLD,
  WORKSPACE_RECENCY_MIRROR,
} from './causes.ts'
import {
  FlipError,
  demonstrateDiff,
  expectConverges,
  expectConvergesExcept,
  matches,
  recordEvidence,
} from './evidence.ts'
import { Driver, sleep, until, type Rig, type TestClient } from './harness.ts'
import type { FrameFields, FrameRecord } from './link-proxy.ts'
import { notRunnable, scenario } from './scenario.ts'
import {
  createSession,
  scriptedTurn,
  startTurn,
  thread,
  turnState,
  untilThread,
  type Target,
} from './steps.ts'

// ---------------------------------------------------------------------------
// Shared constructions
// ---------------------------------------------------------------------------

const KiB = 1024

/** Text in chunks the size the batcher flushes at, so a big message streams as on a real turn. */
async function emitLargeText(rig: Rig, target: Target, bytes: number, kind: 'text' | 'thought') {
  const chunk = 16_000
  for (let sent = 0; sent < bytes; sent += chunk) {
    const size = Math.min(chunk, bytes - sent)
    await rig.provider({
      op: kind === 'text' ? 'emitText' : 'emitThought',
      sessionId: target.sessionId,
      text: String.fromCharCode(97 + ((sent / chunk) % 26)).repeat(size),
    })
  }
}

async function finish(rig: Rig, client: TestClient, target: Target, turnId: string) {
  await rig.provider({ op: 'completeTurn', sessionId: target.sessionId })
  await untilThread(
    client,
    target,
    (state) => state.turns.some((turn) => turn.turnId === turnId && turn.state === 'completed'),
    `turn ${turnId} completed`,
  )
}

/**
 * A thread longer than one history page (100 messages): the first
 * `activityTurns` turns think and use a tool, the rest only answer. Only the
 * oldest turns have thoughts, so they are the ones a snapshot merge drops and
 * no other cause (S2) shows in the same diff.
 */
async function buildLongThread(
  rig: Rig,
  client: TestClient,
  target: Target,
  options: { turns: number; activityTurns: number },
) {
  await rig.provider({
    op: 'setAutoScript',
    steps: [
      { op: 'thought', text: 'Working out the next step' },
      { op: 'tool', status: 'completed', title: 'Read file' },
      { op: 'text', text: 'Step done.' },
      { op: 'complete' },
    ],
  })
  for (let index = 0; index < options.activityTurns; index++) {
    await scriptedTurn(client, target, `Early step ${index + 1}`)
  }
  await rig.provider({
    op: 'setAutoScript',
    steps: [{ op: 'text', text: 'Short answer.' }, { op: 'complete' }],
  })
  for (let index = options.activityTurns; index < options.turns; index++) {
    await scriptedTurn(client, target, `Step ${index + 1}`)
  }
  await rig.provider({ op: 'setAutoScript', steps: null })
}

/** Walk every older history page, as scrolling to the top of the chat does. */
async function walkHistory(client: TestClient, target: Target) {
  for (;;) {
    const cursor = thread(client, target)?.historyCursor
    if (!cursor) return
    await client.client.commands.loadSessionHistory({ ...target, cursor })
  }
}

const downFrames = (frames: readonly FrameRecord[]) =>
  frames.filter((frame) => frame.direction === 'down' && frame.opcode === 1)

type Json = Record<string, unknown>
const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((current, key) => (current as Json | undefined)?.[key], value)

/**
 * The fields scenarios look for, from a parsed frame or, for one too large
 * for the inspector to keep, from its head.
 */
function info(frame: FrameRecord | undefined): FrameFields {
  if (!frame) return {}
  if (frame.fields) return frame.fields
  const payload = field(frame.json, 'payload')
  const scope = (field(payload, 'snapshot', 'cursor', 'scope') ?? field(payload, 'scope')) as
    Json | undefined
  const text = (key: string, from: unknown = frame.json) => {
    const value = field(from, key)
    return typeof value === 'string' ? value : undefined
  }
  return {
    type: text('type'),
    name: text('name'),
    requestId: text('requestId'),
    mode: text('mode', payload),
    reason: text('reason', payload),
    scopeType: text('type', scope),
    threadId: text('threadId', scope),
  }
}

/** The upstream `subscription.replay` commands for a thread scope, in wire order. */
function threadReplays(frames: readonly FrameRecord[], threadId: string) {
  return frames.filter(
    (frame) =>
      frame.direction === 'up' &&
      field(frame.json, 'name') === 'subscription.replay' &&
      field(frame.json, 'payload', 'scope', 'threadId') === threadId,
  )
}

/** Server closes of sockets that came through the proxy (the link under test). */
function proxiedCloses(rig: Rig, reason: string) {
  return rig.server.closes.filter(
    (close) =>
      close.reason === reason &&
      close.remotePort !== undefined &&
      rig.proxy.serverSidePorts.has(close.remotePort),
  )
}

/** A thread whose newest page is about `bytes` of assistant text, built on a direct link. */
async function threadWithAnswer(rig: Rig, bytes: number): Promise<Target> {
  const author = await rig.connect('author', { link: 'direct' })
  const target = await createSession(rig, author)
  const turnId = await startTurn(author, target)
  await emitLargeText(rig, target, bytes, 'text')
  await finish(rig, author, target, turnId)
  await rig.waitQuiet()
  author.dispose()
  return target
}

/**
 * The heartbeat floor on main (S7, S14): a client on a slow link opens a
 * thread right after its handshake; the ping queued at 15 s waits behind the
 * answer, the pong deadline passes at about 25 s, and the server closes with
 * `heartbeat_timeout`. The client reconnects and asks for the thread again.
 */
async function demonstrateHeartbeatLoop(
  name: string,
  rig: Rig,
  target: Target,
  link: { bytesPerSecond: number; bufferBytes: number },
) {
  rig.proxy.throttle('down', link.bytesPerSecond, link.bufferBytes)
  rig.proxy.record(true)
  const client = await rig.connect('C')
  const connectedAt = rig.now()
  void client.client.commands.openSession(target.sessionId).catch(() => undefined)
  let ready = false
  const unsubscribe = client.store.subscribe(() => {
    if (thread(client, target)?.hydration === 'ready') ready = true
  })
  try {
    // A loop: two sockets in a row closed as dead while the answer was still arriving.
    await until(
      () => ready || (proxiedCloses(rig, 'heartbeat_timeout').length >= 2 && client.dials >= 2),
      `${name}: two heartbeat closes in a row`,
      140_000,
      100,
    )
  } finally {
    unsubscribe()
  }
  if (ready) {
    throw new FlipError(
      name,
      'The thread loaded over the slow link; assert zero heartbeat closes now.',
    )
  }
  recordEvidence({
    scenario: name,
    bucket: 'known-divergence',
    cause:
      'The pong deadline runs from when the ping was queued, behind the answer (heartbeat.ts:12-16, ' +
      ':121-131; websocket.ts:259-273), so a slow but healthy download is closed as dead.',
    observed: {
      link,
      clientConnectedAtMs: connectedAt,
      heartbeatCloses: proxiedCloses(rig, 'heartbeat_timeout').map(({ at, code, reason }) => ({
        atMs: rig.since(at),
        code,
        reason,
      })),
      clientDials: client.dials,
      clientCloses: client.closes,
      threadReplayRequests: threadReplays(rig.proxy.frames, target.threadId).map((frame) => ({
        connection: frame.connection,
        atMs: frame.at,
      })),
    },
  })
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('§8.4 scenarios on main', () => {
  scenario('S1 crash mid-turn: the client resumes from its cursor (W1)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a)
    const turnId = await startTurn(a, target)
    await rig.provider({ op: 'openTool', sessionId: target.sessionId, toolCallId: 'tool-s1' })
    await rig.provider({ op: 'emitThought', sessionId: target.sessionId, text: 'Considering it' })
    await rig.provider({ op: 'askPermission', sessionId: target.sessionId, toolCallId: 'edit-s1' })
    await untilThread(
      a,
      target,
      (state) =>
        state.interactions.length === 1 &&
        state.tools.length === 1 &&
        state.reasoning.length === 1 &&
        turnState(a, target, turnId) === 'waiting',
      'A to hold the open tool, thought and question',
    )
    await rig.waitQuiet()
    const before = a.connects
    await rig.crash()
    await until(() => a.connects > before, 'A to reconnect after the crash', 20_000)
    await demonstrateDiff('S1', rig, a, SILENT_RECOVERY)
  })

  scenario('S2 a thought followed by text, connected throughout', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a)
    const turnId = await startTurn(a, target)
    await rig.provider({ op: 'emitThought', sessionId: target.sessionId, text: 'Thinking' })
    await rig.provider({ op: 'emitText', sessionId: target.sessionId, text: 'The answer.' })
    await finish(rig, a, target, turnId)
    await demonstrateDiff('S2', rig, a, THOUGHT_CLOSED_BY_FOLD)
  })

  scenario('S3 a tool left open when the turn completes (guard)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a)
    const turnId = await startTurn(a, target)
    await rig.provider({ op: 'openTool', sessionId: target.sessionId, toolCallId: 'tool-s3' })
    await finish(rig, a, target, turnId)
    const result = await expectConverges('S3', rig, a)
    // Both sides agree today because neither settles the tool; after F3 both say cancelled.
    const tools = Object.values(result.fresh.active?.threads ?? {}).flatMap((view) =>
      Object.values(view.tools),
    )
    recordEvidence({
      scenario: 'S3',
      bucket: 'regression-guard',
      cause: 'tool status',
      observed: tools,
    })
  })

  scenario(
    'S4 a long thread, a gap past the replay cap, then a reconnect (W2)',
    { timeoutMs: 180_000 },
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a)
      await buildLongThread(rig, a, target, { turns: 52, activityTurns: 2 })
      await walkHistory(a, target)
      expect(thread(a, target)?.messages.length).toBe(104)
      await rig.waitQuiet()
      rig.proxy.down()
      rig.proxy.cut()
      await until(() => a.client.getState().connection.phase !== 'connected', 'A to notice the cut')
      // 300 KB in one turn: past the 256 KiB replay budget, only two messages more.
      const driver = await rig.connect('driver', { link: 'direct' })
      const turnId = await startTurn(driver, target, 'One long answer, please')
      await emitLargeText(rig, target, 300_000, 'text')
      await rig.provider({ op: 'completeTurn', sessionId: target.sessionId })
      await rig.waitQuiet()
      rig.proxy.record(true)
      rig.proxy.up()
      await untilThread(
        a,
        target,
        (state) => state.turns.some((turn) => turn.turnId === turnId && turn.state === 'completed'),
        'A to catch up after the gap',
        20_000,
      )
      const answer = downFrames(rig.proxy.frames).find(
        (frame) => info(frame).reason === 'gap_expired' && info(frame).threadId === target.threadId,
      )
      expect(answer, 'the catch-up was a gap_expired snapshot').toBeDefined()
      await demonstrateDiff('S4', rig, a, SNAPSHOT_MERGE_DROPS_OLDER_ACTIVITY)
    },
  )

  scenario('S5 a notice published while text waits in the batcher (W3)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a)
    const turnId = await startTurn(a, target)
    rig.proxy.record(true)
    await rig.provider({ op: 'emitText', sessionId: target.sessionId, text: 'first words' })
    // The artifact store refuses this image, and the server says so with a
    // transient `turn.notice` (thread-service.ts:865-880). No recoverable
    // `rpc_error` exists on the ACP path: the runtime never sets `recoverable`
    // there (AcpSessionRuntimeImpl.ts:415), so this is the doc's fallback.
    await rig.provider({ op: 'emitUnstorableImage', sessionId: target.sessionId })
    await rig.provider({ op: 'emitText', sessionId: target.sessionId, text: ' then more' })
    await finish(rig, a, target, turnId)
    await rig.waitQuiet()
    const frames = downFrames(rig.proxy.frames)
    const notice = frames.findIndex((frame) => field(frame.json, 'name') === 'turn.notice')
    const firstText = frames.findIndex(
      (frame) =>
        field(frame.json, 'name') === 'subscription.event' &&
        field(frame.json, 'payload', 'record', 'event', 'name') === 'message.delta' &&
        field(frame.json, 'payload', 'record', 'event', 'payload', 'role') === 'assistant',
    )
    expect(notice, 'the server published a turn.notice').toBeGreaterThanOrEqual(0)
    expect(firstText, 'the first text reached the client').toBeGreaterThanOrEqual(0)
    if (notice > firstText)
      throw new FlipError('S5', 'The notice now follows the text it came after.')
    recordEvidence({
      scenario: 'S5',
      bucket: 'known-divergence',
      cause:
        'Transient events go out at once (thread-service.ts:885 → server.ts:757 → websocket.ts:609-613) ' +
        'while durable ones wait up to 100 ms in the batcher (event-batcher.ts:11). W3.',
      observed: frames
        .slice(Math.min(notice, firstText), Math.max(notice, firstText) + 1)
        .map((frame) => ({
          atMs: frame.at,
          frame: field(frame.json, 'name'),
          event: field(frame.json, 'payload', 'record', 'event', 'name'),
          text: field(frame.json, 'payload', 'record', 'event', 'payload', 'content', 'text'),
          notice: field(frame.json, 'payload', 'message'),
        })),
    })
    // The comparison leaves notices out, so the state itself still converges.
    await expectConverges('S5 (state, notices excluded)', rig, a)
  })

  scenario('S6(a) a 1.2 MB message, then a fresh client opens the thread (W4)', {}, async (rig) => {
    const target = await threadWithAnswer(rig, 1_200_000)
    const fresh = await rig.connect('F', { link: 'direct' })
    void fresh.client.commands.openSession(target.sessionId).catch(() => undefined)
    let ready = false
    const unsubscribe = fresh.store.subscribe(() => {
      if (thread(fresh, target)?.hydration === 'ready') ready = true
    })
    try {
      await until(
        () => ready || fresh.closes.filter((close) => close.reason === 'slow_consumer').length >= 2,
        'S6(a): two slow_consumer closes',
        30_000,
        50,
      )
    } finally {
      unsubscribe()
    }
    if (ready) throw new FlipError('S6(a)', 'The thread loaded; evaluate the property instead.')
    recordEvidence({
      scenario: 'S6(a)',
      bucket: 'known-divergence',
      cause:
        'send() closes with slow_consumer when bufferedAmount + frame > 1 MiB (websocket.ts:248-251); ' +
        'a single snapshot frame over 1 MiB on an idle socket trips it, on every retry. W4.',
      observed: {
        clientCloses: fresh.closes,
        serverCloses: rig.server.closes.map(({ at, code, reason }) => ({
          atMs: rig.since(at),
          code,
          reason,
        })),
        clientDials: fresh.dials,
      },
    })
  })

  scenario('S6(b) thoughts over 384 KiB (§7.1)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a)
    await startTurn(a, target)
    // The turn stays open: any end of it would also close the thought in A's
    // fold (S2), and this scenario shows the budget alone.
    await emitLargeText(rig, target, 400 * KiB, 'thought')
    await untilThread(
      a,
      target,
      (state) =>
        state.reasoning.some((entry) =>
          entry.content.some((block) => block.type === 'text' && block.text.length >= 400 * KiB),
        ),
      'A to hold the whole thought',
    )
    await demonstrateDiff('S6(b)', rig, a, REASONING_BUDGET_MARKER)
  })

  scenario(
    'S7 a 600 KB answer over a 10 KB/s link (heartbeat floor)',
    { nightly: true, timeoutMs: 150_000 },
    async (rig) => {
      const target = await threadWithAnswer(rig, 600_000)
      await demonstrateHeartbeatLoop('S7', rig, target, {
        bytesPerSecond: 10_000,
        bufferBytes: 256 * KiB,
      })
    },
  )

  scenario(
    'S8 a session created while another client watches (§4.4)',
    { newSessionDelayMs: 500 },
    async (rig) => {
      const a = await rig.connect('A')
      const b = await rig.connect('B')
      const older = await createSession(rig, a, { title: 'Older', open: false })
      // Its own stamp lands 500 ms after its creation; let that pass first.
      await rig.waitQuiet()
      await until(
        () => b.client.getState().sessions[older.sessionId] !== undefined,
        'B to list the older session',
      )
      const created = await createSession(rig, a, { title: 'New', open: false })
      // Inside the 500 ms before the new session's stamp: the older one moves above it.
      await a.client.commands.renameSession(older.sessionId, 'Older, renamed')
      await until(
        () => b.client.getState().sessions[created.sessionId] !== undefined,
        'B to list the new session',
      )
      // B heard of both sessions only through session.created, which names no
      // provider (X2); that shows in the same diff and is not this cause.
      await demonstrateDiff('S8', rig, b, RUNTIME_STAMP, {
        alsoExplainedBy: [SESSION_CREATED_PARTIAL],
      })
    },
  )

  /**
   * Not deterministic on main, so neither a demonstration nor a guard: the
   * stamp follows the child's insert in the same synchronous step
   * (thread-service.ts:1338-1352), so whether its `updatedAt` moves depends on
   * the clock crossing a millisecond in between. The run records which
   * happened, and fails only on a divergence no known cause explains.
   */
  scenario(
    'S8 (child) a child session registered through subtask_update (observed)',
    {},
    async (rig) => {
      const a = await rig.connect('A')
      const b = await rig.connect('B')
      const parent = await createSession(rig, a)
      const turnId = await startTurn(a, parent)
      await rig.provider({
        op: 'emitSubtask',
        sessionId: parent.sessionId,
        toolCallId: 'task-1',
        childProviderSessionId: 'fake-child-1',
      })
      const child = await until(
        () =>
          Object.values(b.client.getState().sessions).find(
            (session) => session.parentSessionId === parent.sessionId,
          ),
        'B to list the child session',
      )
      await finish(rig, a, parent, turnId)
      const result = await rig.checkConvergence(b)
      const allowed = [RUNTIME_STAMP, SESSION_CREATED_PARTIAL, WORKSPACE_RECENCY_MIRROR]
      const unexplained = result.entries.filter(
        (entry) =>
          !allowed.some((cause) => cause.explains.some((matcher) => matches(matcher, entry))),
      )
      expect(unexplained, 'only the stamp, the bare session.created and recency may show').toEqual(
        [],
      )
      const stamped = result.entries.some(
        (entry) => entry.path === `sessions[${child.sessionId}].updatedAt`,
      )
      recordEvidence({
        scenario: 'S8 (child)',
        bucket: 'regression-guard',
        cause: 'observation: did the child stamp cross a millisecond?',
        observed: { childStampDiverged: stamped, entries: result.entries },
      })
    },
  )

  /**
   * The S9 setup: a parent with a child, 110 other sessions (more than one
   * catalog page, and enough to move a whole page between any two reads), B
   * holding the whole catalog, then B cut while the parent is deleted and
   * 501 renames push the environment stream past the replay cap.
   */
  async function s9Setup(rig: Rig, childProviderSessionId: string) {
    const driver = new Driver(rig)
    const author = await driver.client(10)
    const parent = await createSession(rig, author, { title: 'Parent' })
    const turnId = await startTurn(author, parent)
    await rig.provider({
      op: 'emitSubtask',
      sessionId: parent.sessionId,
      toolCallId: 'task-1',
      childProviderSessionId,
    })
    await finish(rig, author, parent, turnId)
    const child = await until(
      () =>
        Object.values(author.client.getState().sessions).find(
          (session) => session.parentSessionId === parent.sessionId,
        ),
      'the child session',
    )
    const others: string[] = []
    for (let index = 0; index < 110; index++) {
      const client = await driver.client()
      others.push((await createSession(rig, client, { title: `S${index}`, open: false })).sessionId)
    }
    const total = others.length + 2
    const b = await rig.connect('B')
    await until(
      () => Object.keys(b.client.getState().sessions).length === total,
      'B to list the whole catalog',
      20_000,
    )
    // B holds an environment cursor only once a live environment event
    // reached it; without one it would not replay that scope at all
    // (websocket.ts:807-811) and the gap below would not matter.
    await (await driver.client()).client.commands.renameSession(others[0]!, 'Seen by B')
    await until(
      () => b.client.getState().sessions[others[0]!]?.title === 'Seen by B',
      'B to apply a live environment event',
    )
    await rig.waitQuiet()
    rig.proxy.down()
    rig.proxy.cut()
    await until(() => b.client.getState().connection.phase !== 'connected', 'B to notice the cut')
    await (await driver.client()).client.commands.deleteSession(parent.sessionId)
    for (let index = 0; index < 501; index++) {
      await (await driver.client()).client.commands.renameSession(others[0]!, `Gap ${index}`)
    }
    return { driver, b, parent, child: child.sessionId, others, total }
  }

  scenario(
    'S9 a deleted parent and child, a gap past the replay cap, a moving catalog',
    { timeoutMs: 180_000 },
    async (rig) => {
      const { driver, b, parent, child, others, total } = await s9Setup(rig, 'fake-child-s9')
      let renames = 0
      const movePage = async () => {
        // A whole page of sessions moves above wherever B's read began.
        for (let index = 0; index < 101; index++) {
          const sessionId = others[renames++ % others.length]!
          await (await driver.client()).client.commands.renameSession(sessionId, `Moved ${renames}`)
        }
      }
      let listReads = 0
      // Every catalog read B makes waits until a page of sessions has moved.
      rig.proxy.gate((text) => {
        const message = JSON.parse(text) as { type?: string; name?: string }
        if (message.type !== 'command' || message.name !== 'session.list') return undefined
        listReads += 1
        return movePage()
      })
      rig.proxy.record(true)
      rig.proxy.up()
      // Two pages for the first walk, then three passes of two pages each;
      // or reconciliation settled and the parent is gone (then the property holds).
      await until(
        () => listReads >= 8 || !b.client.getState().sessions[parent.sessionId],
        'B to make every catalog read',
        60_000,
        50,
      )
      await rig.waitQuiet()
      const environmentReplay = downFrames(rig.proxy.frames).find(
        (frame) => info(frame).mode === 'snapshot' && info(frame).scopeType === 'environment',
      )
      expect(
        info(environmentReplay).reason,
        'B caught up with a gap_expired environment snapshot',
      ).toBe('gap_expired')
      // The renames that move the catalog also move the workspace's recency
      // with no event (X1); that shows in the same diff and is not this cause.
      await demonstrateDiff('S9', rig, b, ENVIRONMENT_SNAPSHOT_NEVER_REMOVES, {
        alsoExplainedBy: [WORKSPACE_RECENCY_MIRROR],
      })
      recordEvidence({
        scenario: 'S9',
        bucket: 'known-divergence',
        cause: 'construction',
        observed: {
          sessions: total,
          catalogReads: listReads,
          renames: 501 + renames,
          parent: parent.sessionId,
          child,
        },
      })
      driver.dispose()
    },
  )

  scenario(
    'S9 (settles) the same gap without a moving catalog (guard)',
    { timeoutMs: 180_000 },
    async (rig) => {
      const { driver, b } = await s9Setup(rig, 'fake-child-s9g')
      rig.proxy.up()
      await expectConverges('S9 (settles)', rig, b)
      driver.dispose()
    },
  )

  scenario(
    'S10 a long thread, all pages walked, then a reload (W2)',
    { timeoutMs: 180_000 },
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a)
      await buildLongThread(rig, a, target, { turns: 52, activityTurns: 2 })
      await walkHistory(a, target)
      expect(thread(a, target)?.messages.length).toBe(104)
      await rig.waitQuiet()
      rig.proxy.record(true)
      const reloaded = await rig.reload(a)
      // The cache already says "ready"; wait for the reload's own initial snapshot.
      await until(
        () =>
          downFrames(rig.proxy.frames).some(
            (frame) => info(frame).reason === 'initial' && info(frame).threadId === target.threadId,
          ),
        'the reload to receive its initial thread snapshot',
      )
      await demonstrateDiff('S10', rig, reloaded, SNAPSHOT_MERGE_DROPS_OLDER_ACTIVITY)
    },
  )

  scenario(
    'S11 a 30 s blackhole while idle (guard)',
    { nightly: true, timeoutMs: 120_000 },
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a)
      const turnId = await startTurn(a, target)
      await rig.provider({
        op: 'emitText',
        sessionId: target.sessionId,
        text: 'Before the blackhole.',
      })
      await finish(rig, a, target, turnId)
      await rig.waitQuiet()
      const holeStarted = rig.now()
      const before = a.connects
      rig.proxy.blackhole()
      await until(
        () => proxiedCloses(rig, 'heartbeat_timeout').length > 0,
        'the server to close the silent socket',
        40_000,
        100,
      )
      // The construction is a 30 s blackhole; the close above is what it causes.
      await sleep(Math.max(0, 30_000 - (rig.now() - holeStarted)))
      rig.proxy.unblackhole()
      await until(() => a.connects > before, 'A to reconnect', 30_000)
      await expectConverges('S11', rig, a, {
        heartbeatCloses: proxiedCloses(rig, 'heartbeat_timeout').map(
          ({ at }) => rig.since(at) - holeStarted,
        ),
        clientCloses: a.closes,
      })
    },
  )

  scenario('S12 a short cut while streaming, under the replay cap (guard)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a)
    const turnId = await startTurn(a, target)
    for (let index = 0; index < 5; index++) {
      await rig.provider({ op: 'emitText', sessionId: target.sessionId, text: `Part ${index}. ` })
    }
    await rig.waitQuiet()
    rig.proxy.down()
    rig.proxy.cut()
    await until(() => a.client.getState().connection.phase !== 'connected', 'A to notice the cut')
    for (let index = 5; index < 40; index++) {
      await rig.provider({ op: 'emitText', sessionId: target.sessionId, text: `Part ${index}. ` })
    }
    await rig.provider({ op: 'completeTurn', sessionId: target.sessionId })
    await rig.waitQuiet()
    rig.proxy.record(true)
    rig.proxy.up()
    await untilThread(
      a,
      target,
      (state) => state.turns.some((turn) => turn.turnId === turnId && turn.state === 'completed'),
      'A to catch up',
      20_000,
    )
    const replay = threadReplays(rig.proxy.frames, target.threadId)[0]
    const requestId = field(replay?.json, 'requestId')
    const answer = downFrames(rig.proxy.frames).find((frame) => info(frame).requestId === requestId)
    expect(info(answer).mode, 'an incremental replay, not a snapshot').toBe('replay')
    await expectConverges('S12', rig, a, {
      replayedEvents: (field(answer?.json, 'payload', 'events') as unknown[] | undefined)?.length,
    })
  })

  notRunnable(
    'S13 a lost durable record, then a notice for the same scope',
    'F4 (the delivery-queue seam)',
    'with A subscribed to a thread, the seam drops one durable record for A only; the server then ' +
      'publishes a turn.notice for that scope whose `after` is ahead of A’s cursor; A must recover, ' +
      'replay the missing record, apply the notice and converge (§5.5)',
  )

  scenario(
    'S14 a 30 KB answer over a 300 B/s link, on main (heartbeat floor)',
    { nightly: true, timeoutMs: 150_000 },
    async (rig) => {
      const target = await threadWithAnswer(rig, 30_000)
      await demonstrateHeartbeatLoop('S14', rig, target, {
        bytesPerSecond: 300,
        bufferBytes: 64 * KiB,
      })
    },
  )

  notRunnable(
    'S14 after F5a: the same answer completes with no reconnect',
    'F5a (beats, rate-sized fragments)',
    'threadWithAnswer(30 KB); proxy.throttle(down, 300 B/s, 64 KiB); a fresh client opens the thread ' +
      'right after its handshake; it must reach ready on its first socket (about 100 s; nightly: 300 KB, ' +
      'about 17 min), with zero heartbeat closes on either side, then converge',
  )

  scenario(
    'S15 a fast producer and a slow consumer, on main',
    { nightly: true, timeoutMs: 150_000 },
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a)
      const turnId = await startTurn(a, target)
      rig.proxy.throttle('down', 10 * KiB, 256 * KiB)
      const streaming = rig
        .provider({
          op: 'streamText',
          sessionId: target.sessionId,
          bytesPerSecond: 100 * KiB,
          durationMs: 60_000,
        })
        .catch(() => undefined)
      const samples: Array<{ atMs: number; bufferedAmount: number }> = []
      const started = rig.now()
      while (proxiedCloses(rig, 'slow_consumer').length === 0 && rig.now() - started < 70_000) {
        const sockets = await rig.server.sampleSockets()
        const proxied = sockets.filter(
          (socket) =>
            socket.remotePort !== undefined && rig.proxy.serverSidePorts.has(socket.remotePort),
        )
        samples.push({
          atMs: rig.now() - started,
          bufferedAmount: proxied.reduce((total, socket) => total + socket.bufferedAmount, 0),
        })
        await sleep(1_000)
      }
      await rig.provider({ op: 'completeTurn', sessionId: target.sessionId }).catch(() => undefined)
      await streaming
      const closes = proxiedCloses(rig, 'slow_consumer')
      if (closes.length === 0) {
        throw new FlipError(
          'S15',
          'No slow_consumer close in 70 s; assert the window and backlog bounds now.',
        )
      }
      recordEvidence({
        scenario: 'S15',
        bucket: 'known-divergence',
        cause:
          'With no flow control, the server buffers what the slow link cannot take until ' +
          'bufferedAmount + frame passes 1 MiB, then closes with slow_consumer (websocket.ts:248-251).',
        observed: {
          samples,
          closes: closes.map(({ at, code, reason }) => ({
            atMs: rig.since(at) - started,
            code,
            reason,
          })),
        },
      })
      void turnId
    },
  )

  notRunnable(
    'S15 after F5a: the backlog stays bounded and A catches up',
    'F5a (send window, lagging, catch-up)',
    'same construction; sampled queued + in-flight bytes never exceed window + 1 MiB backlog + one ' +
      'materialized answer; A sees subscription.lagging then subscription.catchup; after the producer ' +
      'stops, A converges',
  )

  notRunnable(
    'S16 a sudden rate drop mid-answer',
    'F5a (8 KiB fragment cap, browser watchdog per frame)',
    'start a ~2 MB answer on throttle(5 MB/s, 256 KiB); once ~1 MB is delivered switch to ' +
      'throttle(1 KiB/s, 256 KiB); every in-flight fragment (≤ 8 KiB) arrives within ~8 s, the watchdog ' +
      'never fires, later fragments shrink to ~2 KiB, the answer completes with no reconnect (nightly; ' +
      'the CI variant drops with only ~64 KiB left)',
  )

  for (const [id, pair] of [
    ['W1', 'workspace register (workspaces.ts:178-179 upsert, then :397-398 emit)'],
    ['W2', 'workspace rename (workspaces.ts:166, then the event)'],
    ['W3', 'workspace availability (workspaces.ts:309 refresh write, then emit)'],
    ['W4', 'workspace recency (markUsed, workspaces.ts:523, then emit)'],
    ['W5', 'workspace removal (workspaces.ts:145, :404-413 DELETE, then workspace.removed)'],
    [
      'W6',
      'composer preferences and profiles (composer-store.ts:47-75, then composer-service.ts:111, :137)',
    ],
    ['W7', 'the runtime stamp (thread-service.ts:419-426, after session.created)'],
  ] as const) {
    notRunnable(
      `${id} crash window: ${pair}`,
      'F3 (a beforeCommit seam reachable from startServer)',
      'kill the server child between the row write and its event; after the restart the row and the ' +
        'event must be both present or both absent, and a client replaying from its bookmark converges',
    )
  }
})

describe('divergences on main that §8.4 does not list', () => {
  scenario(
    'X1 a rename moves the workspace’s recency with no event (§3.6 row 14)',
    {},
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a)
      const turnId = await startTurn(a, target)
      await finish(rig, a, target, turnId)
      await rig.waitQuiet()
      await a.client.commands.renameSession(target.sessionId, 'Renamed later')
      await demonstrateDiff('X1', rig, a, WORKSPACE_RECENCY_MIRROR)
    },
  )

  scenario(
    'X2 a second client hears of a session only through session.created (§6.3)',
    {},
    async (rig) => {
      const a = await rig.connect('A')
      const b = await rig.connect('B')
      const target = await createSession(rig, a, { open: false })
      await until(() => b.client.getState().sessions[target.sessionId], 'B to list the new session')
      // Nothing follows the creation, so the runtime stamp (S8's cause) shows too.
      await demonstrateDiff('X2', rig, b, SESSION_CREATED_PARTIAL, {
        alsoExplainedBy: [RUNTIME_STAMP],
      })
    },
  )

  /**
   * #219's `waitingOn`: a question outranks a permission, and answering it
   * hands the session back to the permission. Each change rides a
   * `session.updated` whose status does not change (event-repository.ts,
   * `activityChanged`). A sidebar-only client must follow every step.
   */
  scenario('G1 waitingOn follows a question over a permission (#219, guard)', {}, async (rig) => {
    const a = await rig.connect('A')
    const b = await rig.connect('B')
    // Cursor is the provider whose agent asks questions (cursor/ask_question).
    const target = await createSession(rig, a, { providerId: 'cursor' })
    // B lists the session once, so it knows its provider (not X2's subject here).
    await b.client.commands.listSessions()
    await startTurn(a, target)
    const waitingOn = () => b.client.getState().sessions[target.sessionId]?.waitingOn
    const steps: Array<{ step: string; waitingOn: unknown }> = []
    const settle = async (step: string, expected: string | undefined) => {
      await until(() => waitingOn() === expected || undefined, `B to show waitingOn ${expected}`)
      // Interaction events move sessions.updated_at, and with it the
      // workspace's recency, with no workspace event (X1): named, not ignored.
      await expectConvergesExcept(`G1 ${step} (sidebar)`, rig, b, [WORKSPACE_RECENCY_MIRROR])
      await expectConvergesExcept(`G1 ${step} (chat)`, rig, a, [WORKSPACE_RECENCY_MIRROR])
      steps.push({ step, waitingOn: waitingOn() })
    }
    await rig.provider({ op: 'askPermission', sessionId: target.sessionId, toolCallId: 'edit-g1' })
    await settle('permission asked', 'permission')
    await rig.provider({ op: 'askQuestion', sessionId: target.sessionId, questionId: 'q1' })
    await settle('question asked', 'question')
    const pending = (kind: string) =>
      until(
        () => thread(a, target)?.interactions.find((item) => item.interaction.kind === kind),
        `A to show the pending ${kind}`,
      )
    const question = await pending('question')
    await a.client.commands.respondToInteraction({
      ...target,
      response: {
        kind: 'question',
        interactionId: question.interaction.interactionId,
        outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }] },
      },
    })
    await settle('question answered', 'permission')
    const permission = await pending('permission')
    await a.client.commands.respondToInteraction({
      ...target,
      response: {
        kind: 'permission',
        interactionId: permission.interaction.interactionId,
        outcome: { outcome: 'selected', optionId: 'allow' },
      },
    })
    await settle('permission answered', undefined)
    recordEvidence({
      scenario: 'G1',
      bucket: 'regression-guard',
      cause: 'waitingOn',
      observed: steps,
    })
  })

  /**
   * Persisted drafts and composer preferences (normalize compares both, and
   * the composer read the app makes): B follows them live, across a short gap
   * that replays, and across one past the replay cap, after which the client
   * forgets its preferences (websocket.ts:875-881) and lists drafts again.
   */
  scenario(
    'G2 drafts and composer preferences across both kinds of gap (guard)',
    {},
    async (rig) => {
      const a = await rig.connect('A', { link: 'direct' })
      const b = await rig.connect('B')
      const target = await createSession(rig, a, { title: 'With a draft' })
      await b.client.commands.openSession(target.sessionId)
      // A turn, so the session's last change is one every client mirrors, not
      // the runtime stamp (S8) or the recency it moves (X1).
      const turnId = await startTurn(a, target)
      await finish(rig, a, target, turnId)
      const pair = { workspaceId: rig.workspaceId, providerId: 'opencode' }
      let revision = 0
      const saveDraft = async (text: string) => {
        const draft = await a.client.commands.saveDraft({
          draftId: target.sessionId,
          baseRevision: revision,
          target: { type: 'session', sessionId: target.sessionId },
          content: { text },
        })
        revision = draft.revision
      }
      const newDraftId = '00000000-0000-4000-8000-00000000d0d0'
      await saveDraft('first words')
      await a.client.commands.setComposerPreference({ ...pair, preference: { modeId: 'plan' } })
      await until(() => b.client.getState().drafts[target.sessionId], 'B to hear of the draft')
      await expectConverges('G2 live', rig, b)

      // A short gap: replayed.
      rig.proxy.down()
      rig.proxy.cut()
      await until(() => b.client.getState().connection.phase !== 'connected', 'B to notice the cut')
      await saveDraft('second words')
      await a.client.commands.setComposerPreference({ ...pair, preference: { modeId: 'build' } })
      await a.client.commands.saveDraft({
        draftId: newDraftId,
        baseRevision: 0,
        target: { type: 'new_session', workspaceId: rig.workspaceId, sessionId: newDraftId },
        content: { text: 'a new chat' },
      })
      await rig.waitQuiet()
      rig.proxy.up()
      await expectConverges('G2 after a replayed gap', rig, b)

      // A gap past the replay cap: a snapshot, then preferences forgotten and drafts listed again.
      rig.proxy.down()
      rig.proxy.cut()
      await until(() => b.client.getState().connection.phase !== 'connected', 'B to notice the cut')
      const driver = new Driver(rig)
      for (let index = 0; index < 501; index++) {
        await (
          await driver.client()
        ).client.commands.renameSession(target.sessionId, `Gap ${index}`)
      }
      await saveDraft('third words')
      await a.client.commands.deleteDraft({ draftId: newDraftId, baseRevision: 1 })
      await a.client.commands.setComposerPreference({ ...pair, preference: { modeId: 'plan' } })
      await rig.waitQuiet()
      rig.proxy.record(true)
      rig.proxy.up()
      await expectConverges('G2 after a snapshot gap', rig, b)
      const environment = downFrames(rig.proxy.frames).find(
        (frame) => info(frame).mode === 'snapshot' && info(frame).scopeType === 'environment',
      )
      expect(info(environment).reason, 'the second gap was caught up by snapshot').toBe(
        'gap_expired',
      )
      driver.dispose()
    },
  )
})
