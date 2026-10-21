/**
 * The §8.4 scenarios of docs/sync-foundations.md against today's server, and
 * the divergences found beside them.
 *
 * Buckets:
 *   - known divergence on main: the diff is judged against the primary cause
 *     instantiated with the fixture's own ids and captured values, plus the
 *     residual causes the scenario names, each as tight (evidence.ts). Primary
 *     gone: "flip it to a guard". Anything else: wrong cause;
 *   - regression guard: the property must hold, now and after every phase;
 *   - future tests: a body written against today's harness but asserting a
 *     later phase (skipped), or no body yet because the seam does not exist
 *     (todo).
 */
import { describe, expect } from 'vitest'
import {
  environmentSnapshotNeverRemoves,
  reasoningBudgetMarker,
  runtimeStamp,
  sessionCreatedPartial,
  snapshotMergeDropsOlderActivity,
  stampMovesRecency,
} from './causes.ts'
import {
  FlipError,
  demonstrateDiff,
  expectConverges,
  expectConvergesExcept,
  recordEvidence,
  verdictOf,
} from './evidence.ts'
import { Driver, sleep, until, type Rig, type TestClient } from './harness.ts'
import type { FrameFields, FrameRecord } from './link-proxy.ts'
import { serverSessionsView, serverThreadView, type ThreadView } from './normalize.ts'
import { recencyMirror, s8Causes, witnessOf, x2Causes } from './fixtures.ts'
import { createdAt, mirroredRecency } from './mirror.ts'
import { afterPhase, futureTest, scenario } from './scenario.ts'
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

/**
 * Text in chunks the size the batcher flushes at, so a big message streams
 * as on a real turn. Returns what was sent.
 */
async function emitLargeText(
  rig: Rig,
  target: Target,
  bytes: number,
  kind: 'text' | 'thought',
): Promise<string> {
  const chunk = 16_000
  let sent = ''
  for (let offset = 0; offset < bytes; offset += chunk) {
    const text = String.fromCharCode(97 + ((offset / chunk) % 26)).repeat(
      Math.min(chunk, bytes - offset),
    )
    await rig.provider({
      op: kind === 'text' ? 'emitText' : 'emitThought',
      sessionId: target.sessionId,
      text,
    })
    sent += text
  }
  return sent
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
 * oldest turns have thoughts, so they are the ones a snapshot merge drops.
 * Returns those turns' ids.
 */
async function buildLongThread(
  rig: Rig,
  client: TestClient,
  target: Target,
  options: { turns: number; activityTurns: number },
): Promise<string[]> {
  await rig.provider({
    op: 'setAutoScript',
    steps: [
      { op: 'thought', text: 'Working out the next step' },
      { op: 'tool', status: 'completed', title: 'Read file' },
      { op: 'text', text: 'Step done.' },
      { op: 'complete' },
    ],
  })
  const early: string[] = []
  for (let index = 0; index < options.activityTurns; index++) {
    early.push(await scriptedTurn(client, target, `Early step ${index + 1}`))
  }
  await rig.provider({
    op: 'setAutoScript',
    steps: [{ op: 'text', text: 'Short answer.' }, { op: 'complete' }],
  })
  for (let index = options.activityTurns; index < options.turns; index++) {
    await scriptedTurn(client, target, `Step ${index + 1}`)
  }
  await rig.provider({ op: 'setAutoScript', steps: null })
  return early
}

/** Walk every older history page, as scrolling to the top of the chat does. */
async function walkHistory(client: TestClient, target: Target) {
  for (;;) {
    const cursor = thread(client, target)?.historyCursor
    if (!cursor) return
    await client.client.commands.loadSessionHistory({ ...target, cursor })
  }
}

/** The server's own read of a thread, normalized. */
async function serverThread(rig: Rig, target: Target): Promise<ThreadView> {
  return serverThreadView(await rig.server.readThread(target.sessionId, target.threadId))
}

/**
 * The server's read of the activity of `turnIds`: what the snapshot merge
 * drops, as the fresh load must show it.
 */
function olderActivity(server: ThreadView, threadId: string, turnIds: readonly string[]) {
  const inTurns = (value: unknown) => turnIds.includes((value as { turnId: string }).turnId)
  const pick = (record: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(record).filter(([, value]) => inTurns(value)))
  const reasoning = pick(server.reasoning)
  const tools = pick(server.tools)
  const refs = (server.order as Array<{ kind: string; id: string; turnId: string }>).filter(
    (ref) => (ref.kind === 'reasoning' || ref.kind === 'tool') && turnIds.includes(ref.turnId),
  ) as Array<{ kind: 'reasoning' | 'tool'; id: string; turnId: string }>
  if (Object.keys(reasoning).length === 0 || Object.keys(tools).length === 0) {
    throw new Error('The fixture has no older activity to lose.')
  }
  return { threadId, reasoning, tools, refs }
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
  const scope = (field(payload, 'snapshot', 'cursor', 'scope') ??
    field(payload, 'to', 'scope') ??
    field(payload, 'scope')) as Json | undefined
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
  const target = await createSession(rig, author, QUIET)
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
 * answer, the pong deadline passes, and the server closes with
 * `heartbeat_timeout`. The client reconnects and asks for the thread again.
 */
async function demonstrateHeartbeatLoop(
  name: string,
  rig: Rig,
  target: Target,
  link: { bytesPerSecond: number; bufferBytes: number },
) {
  rig.proxy.throttle('down', link.bytesPerSecond, link.bufferBytes)
  // Recording is always on; what follows is judged from here.
  const mark = rig.proxy.frames.length
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
    throw new FlipError(name, 'The thread loaded over the slow link; enable its after-F5a half.')
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
      threadReplayRequests: threadReplays(rig.proxy.frames.slice(mark), target.threadId).map(
        (frame) => ({
          connection: frame.connection,
          atMs: frame.at,
        }),
      ),
    },
  })
}

/**
 * Scripted fixtures create sessions quietly, each by its own choice: the
 * provider session has resolved and its runtime stamp has landed before the
 * fixture goes on, so a scenario about something else does not also race
 * the stamp. That race is real (session.created is announced before the
 * provider completes); S8 and X2 demonstrate it, creating without waiting,
 * and the seeded runs cover it at random (asynchronous creation and a
 * delayed provider, model.test.ts).
 */
const QUIET = { quiet: true } as const

/**
 * Tool status at turn end. Main never settled a tool, on either side; F3
 * writes `tool.updated {cancelled}` before the terminal (§4.3, turn-closure.ts).
 */
const TOOL_STATUS_AFTER_TURN_END = 'cancelled'

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('§8.4 scenarios on main', () => {
  /**
   * Guard since F3 (§4.1): the restarted server ends the turn with events on
   * the thread's own stream, closing its tool, thought and question first, so
   * the client's replay from its cursor brings exactly that. On main the
   * replay came back empty (SILENT_RECOVERY).
   */
  scenario('S1 crash mid-turn: the client resumes from its cursor (W1, guard)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
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
    // A valid baseline: before the crash A agrees with the server, except for
    // the workspace recency the question moved (X1, an interaction event is
    // not one the client mirrors it on), named with its fingerprint.
    await expectConvergesExcept('S1 baseline', rig, a, [recencyMirror(rig, a)])
    const held = await serverThread(rig, target)
    const openTurn = (held.turns as Array<{ turnId: string; state: string }>).find(
      (turn) => turn.turnId === turnId,
    )
    expect(openTurn?.state).toBe('waiting')
    const before = a.connects
    await rig.crash()
    await until(() => a.connects > before, 'A to reconnect after the crash', 20_000)
    await until(() => !a.busy(), 'A to finish its reconnect')
    const result = await expectConverges('S1', rig, a)
    // Equal is not enough: everything recovery closed is closed on all three.
    const views = [result.view, result.fresh].map((view) => view.active!.threads[target.threadId]!)
    views.push(result.server.threads[target.threadId]!)
    for (const view of views) {
      expect(view.turns).toContainEqual(
        expect.objectContaining({
          turnId,
          state: 'interrupted',
          interruptedBy: 'server_restarted',
        }),
      )
      expect(Object.values(view.tools).map((tool) => (tool as { status?: string }).status)).toEqual(
        ['cancelled'],
      )
      expect(
        Object.values(view.reasoning).map((thought) => (thought as { phase?: string }).phase),
      ).toEqual(['stop'])
      expect(view.interactions).toEqual({})
    }
    recordEvidence({
      scenario: 'S1',
      bucket: 'regression-guard',
      cause: 'recovery events replayed from the cursor',
      observed: { turn: 'interrupted (server_restarted)', tool: 'cancelled', thought: 'stop' },
    })
  })

  /**
   * Guard since F3 (§4.3.3): the server closes the thought with its own
   * `message.reasoning {phase: 'stop'}` where the text begins, so the client,
   * a fresh load and the rows all hold it closed. On main the fold closed it
   * and the row kept `delta` (THOUGHT_CLOSED_BY_FOLD).
   */
  scenario('S2 a thought followed by text, connected throughout (guard)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    const turnId = await startTurn(a, target)
    await rig.provider({ op: 'emitThought', sessionId: target.sessionId, text: 'Thinking' })
    await rig.provider({ op: 'emitText', sessionId: target.sessionId, text: 'The answer.' })
    await finish(rig, a, target, turnId)
    const thoughts = Object.keys((await serverThread(rig, target)).reasoning)
    expect(thoughts).toHaveLength(1)
    const result = await expectConverges('S2', rig, a)
    const phases = [result.view, result.fresh].map((view) =>
      Object.values(view.active!.threads[target.threadId]!.reasoning).map(
        (thought) => (thought as { phase?: string }).phase,
      ),
    )
    phases.push(
      Object.values(result.server.threads[target.threadId]!.reasoning).map(
        (thought) => (thought as { phase?: string }).phase,
      ),
    )
    for (const seen of phases) expect(seen, 'the thought is closed everywhere').toEqual(['stop'])
    recordEvidence({ scenario: 'S2', bucket: 'regression-guard', cause: 'phase', observed: phases })
  })

  scenario('S3 a tool left open when the turn completes (guard)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    const turnId = await startTurn(a, target)
    await rig.provider({ op: 'openTool', sessionId: target.sessionId, toolCallId: 'tool-s3' })
    await finish(rig, a, target, turnId)
    const result = await expectConverges('S3', rig, a)
    // Equal is not enough: the tool must be there, with this build's status.
    const statuses = [result.view, result.fresh].map((view) =>
      Object.values(view.active!.threads[target.threadId]!.tools).map(
        (tool) => (tool as { status?: string }).status,
      ),
    )
    statuses.push(
      Object.values(result.server.threads[target.threadId]!.tools).map(
        (tool) => (tool as { status?: string }).status,
      ),
    )
    for (const seen of statuses) {
      expect(seen, `one tool, ${TOOL_STATUS_AFTER_TURN_END} after the turn ended`).toEqual([
        TOOL_STATUS_AFTER_TURN_END,
      ])
    }
    recordEvidence({
      scenario: 'S3',
      bucket: 'regression-guard',
      cause: 'tool status',
      observed: statuses,
    })
  })

  scenario(
    'S4 a long thread, a gap past the replay cap, then a reconnect (W2)',
    { timeoutMs: 180_000 },
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a, QUIET)
      const early = await buildLongThread(rig, a, target, { turns: 52, activityTurns: 2 })
      await walkHistory(a, target)
      expect(thread(a, target)?.messages.length).toBe(104)
      // A valid baseline: before the gap A agrees with the server (since F3
      // the server closes the thoughts, so S2's cause no longer shows here).
      const server = await serverThread(rig, target)
      const older = olderActivity(server, target.threadId, early)
      await expectConverges('S4 baseline', rig, a)
      rig.proxy.down()
      rig.proxy.cut()
      await until(() => a.client.getState().connection.phase !== 'connected', 'A to notice the cut')
      // 300 KB in one turn: past the 256 KiB replay budget, only two messages more.
      const driver = await rig.connect('driver', { link: 'direct' })
      const turnId = await startTurn(driver, target, 'One long answer, please')
      await emitLargeText(rig, target, 300_000, 'text')
      await rig.provider({ op: 'completeTurn', sessionId: target.sessionId })
      await rig.waitQuiet()
      // Recording is always on; what follows is judged from here.
      const mark = rig.proxy.frames.length
      rig.proxy.up()
      await untilThread(
        a,
        target,
        (state) => state.turns.some((turn) => turn.turnId === turnId && turn.state === 'completed'),
        'A to catch up after the gap',
        20_000,
      )
      const answer = downFrames(rig.proxy.frames.slice(mark)).find(
        (frame) => info(frame).reason === 'gap_expired' && info(frame).threadId === target.threadId,
      )
      expect(answer, 'the catch-up was a gap_expired snapshot').toBeDefined()
      await demonstrateDiff('S4', rig, a, snapshotMergeDropsOlderActivity(older))
    },
  )

  scenario('S5 a notice published while text waits in the batcher (W3)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    const turnId = await startTurn(a, target)
    // Recording is always on; what follows is judged from here.
    const mark = rig.proxy.frames.length
    // One child step: the text enters the batcher and the image is refused
    // before any timer runs, so the order does not depend on how fast the
    // host schedules two separate requests against the 100 ms window. The
    // artifact store refuses the image and the server says so with a
    // transient `turn.notice` (thread-service.ts:865-880). No recoverable
    // `rpc_error` exists on the ACP path (AcpSessionRuntimeImpl.ts:415), so
    // this is the doc's fallback.
    await rig.provider({
      op: 'emitTextThenUnstorableImage',
      sessionId: target.sessionId,
      text: 'first words',
    })
    await rig.provider({ op: 'emitText', sessionId: target.sessionId, text: ' then more' })
    await finish(rig, a, target, turnId)
    await rig.waitQuiet()
    const frames = downFrames(rig.proxy.frames.slice(mark))
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
    // Quiet creation isolates the reasoning budget. Before connect() waited
    // for the client's own resync, this fixture once (1 run in 75, under
    // load) also showed a recency-only entry: no live turn.started had
    // reached A, though the session.updated committed with it had. A's open
    // had been overtaken by its resync's open of the same session, so it
    // resolved before the chat was subscribed and the turn arrived in the
    // thread snapshot, which carries no recency. Not a lost event: S19
    // demonstrates it deterministically.
    const target = await createSession(rig, a, QUIET)
    await startTurn(a, target)
    // The turn stays open: any end of it would also close the thought in A's
    // fold (S2), and this scenario shows the budget alone.
    const text = await emitLargeText(rig, target, 400 * KiB, 'thought')
    await untilThread(
      a,
      target,
      (state) =>
        state.reasoning.some((item) =>
          item.content.some((block) => block.type === 'text' && block.text.length === text.length),
        ),
      'A to hold the whole thought',
    )
    await rig.waitQuiet()
    const [messageId] = Object.keys((await serverThread(rig, target)).reasoning)
    await demonstrateDiff(
      'S6(b)',
      rig,
      a,
      reasoningBudgetMarker({
        threadId: target.threadId,
        messageId: messageId!,
        text,
      }),
    )
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
      // A direct, so the proxy carries only B: what B was sent is B's alone.
      const a = await rig.connect('A', { link: 'direct' })
      const b = await rig.connect('B')
      // B's own catalog read and environment subscription are done before anything is created.
      await rig.settle()
      // Its own stamp lands 500 ms after its creation; quiet creation waits for it.
      const older = await createSession(rig, a, { title: 'Older', open: false, quiet: true })
      await until(
        () => b.client.getState().sessions[older.sessionId],
        'B to list the older session',
      )
      // A valid baseline before the new session's stamp is induced: B agrees
      // with the server except for the older session's own X2 diff (its
      // provider, its stamp), instantiated from what B was sent.
      const baseline = async () =>
        x2Causes({
          sessionId: older.sessionId,
          workspaceId: rig.workspaceId,
          providerId: 'opencode',
          createdAt: createdAt(rig.framesOf(b), older.sessionId),
          heldRecency: mirroredRecency(rig.framesOf(b), rig.workspaceId),
          witness: await witnessOf(rig, b),
        })
      await expectConvergesExcept('S8 baseline', rig, b, [
        async () => (await baseline()).primary,
        ...[0, 1].map((index) => async () => (await baseline()).residuals[index]!),
      ])
      const created = await createSession(rig, a, { title: 'New', open: false, quiet: false })
      // Inside the 500 ms before the new session's stamp: the older one moves above it.
      await a.client.commands.renameSession(older.sessionId, 'Older, renamed')
      await until(
        () => b.client.getState().sessions[created.sessionId],
        'B to list the new session',
      )
      await rig.waitQuiet()
      const causes = async () =>
        s8Causes({
          olderId: older.sessionId,
          newId: created.sessionId,
          workspaceId: rig.workspaceId,
          providerId: 'opencode',
          createdAt: createdAt(rig.framesOf(b), created.sessionId),
          heldRecency: mirroredRecency(rig.framesOf(b), rig.workspaceId),
          witness: await witnessOf(rig, b),
        })
      await demonstrateDiff(
        'S8',
        rig,
        b,
        async () => (await causes()).primary,
        [0, 1].map((index) => async () => (await causes()).residuals[index]!),
      )
    },
  )

  /**
   * Not deterministic on main, so neither a demonstration nor a guard: the
   * stamp follows the child's insert in the same synchronous step
   * (thread-service.ts:1338-1352), so whether its `updatedAt` moves depends on
   * the clock crossing a millisecond in between. The run records which
   * happened, and fails on anything the instantiated causes do not explain.
   */
  scenario(
    'S8 (child) a child session registered through subtask_update (observed)',
    {},
    async (rig) => {
      const a = await rig.connect('A', { link: 'direct' })
      const b = await rig.connect('B')
      const parent = await createSession(rig, a, { quiet: true })
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
      // The child's stamp: its provider identity written with no event, right
      // after the insert; provenance names the write.
      const witness = await witnessOf(rig, b)
      const verdict = verdictOf(result, undefined, [
        runtimeStamp({
          sessionId: child.sessionId,
          heldUpdatedAt: createdAt(rig.framesOf(b), child.sessionId),
          witness,
        }),
        stampMovesRecency({
          workspaceId: rig.workspaceId,
          held: mirroredRecency(rig.framesOf(b), rig.workspaceId),
          witness,
        }),
        sessionCreatedPartial({
          sessionIds: [parent.sessionId, child.sessionId],
          providerId: 'opencode',
        }),
        await recencyMirror(rig, b)(),
      ])
      expect(verdict.residual, 'only the instantiated causes may show').toEqual([])
      recordEvidence({
        scenario: 'S8 (child)',
        bucket: 'regression-guard',
        cause: 'observation: did the child stamp cross a millisecond?',
        observed: {
          childStampDiverged: verdict.residualCauses.includes('RUNTIME_STAMP'),
          entries: result.entries,
        },
      })
    },
  )

  /**
   * The S9 setup: a parent with a child, 110 other sessions (more than one
   * catalog page, and enough to move a whole page between any two reads), B
   * holding the whole catalog and an environment cursor, then B cut while
   * the parent is deleted and 501 renames push the environment stream past
   * the replay cap.
   */
  async function s9Setup(rig: Rig, childProviderSessionId: string) {
    const driver = new Driver(rig)
    const author = await driver.client(10)
    const parent = await createSession(rig, author, { title: 'Parent', quiet: true })
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
      others.push(
        (await createSession(rig, client, { title: `S${index}`, open: false, quiet: false }))
          .sessionId,
      )
    }
    await rig.waitQuiet()
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
    // A valid baseline: B agrees with the server before the cut, except for
    // the recency the rename above moved (X1), from what B was sent.
    await expectConvergesExcept('S9 baseline', rig, b, [recencyMirror(rig, b)])
    // The rows B will keep, as the server's own summaries give them.
    const summaries = serverSessionsView(await rig.server.readSessions()) as Array<{
      sessionId: string
    }>
    const rows = Object.fromEntries(
      [parent.sessionId, child.sessionId].map((id) => [
        id,
        summaries.find((row) => row.sessionId === id),
      ]),
    )
    rig.proxy.down()
    rig.proxy.cut()
    await until(() => b.client.getState().connection.phase !== 'connected', 'B to notice the cut')
    await (await driver.client()).client.commands.deleteSession(parent.sessionId)
    for (let index = 0; index < 501; index++) {
      await (await driver.client()).client.commands.renameSession(others[0]!, `Gap ${index}`)
    }
    return { driver, b, parent, child: child.sessionId, others, total, rows }
  }

  scenario(
    'S9 a deleted parent and child, a gap past the replay cap, a moving catalog',
    { timeoutMs: 180_000 },
    async (rig) => {
      const { driver, b, parent, child, others, total, rows } = await s9Setup(rig, 'fake-child-s9')
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
      // Recording is always on; what follows is judged from here.
      const mark = rig.proxy.frames.length
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
      const environmentReplay = downFrames(rig.proxy.frames.slice(mark)).find(
        (frame) => info(frame).mode === 'snapshot' && info(frame).scopeType === 'environment',
      )
      expect(
        info(environmentReplay).reason,
        'B caught up with a gap_expired environment snapshot',
      ).toBe('gap_expired')
      await demonstrateDiff('S9', rig, b, environmentSnapshotNeverRemoves({ rows }), [
        // The renames that move the catalog also move the workspace's recency
        // with no event (X1): named, from what B was sent and a server read.
        recencyMirror(rig, b),
      ])
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
      const target = await createSession(rig, a, QUIET)
      const early = await buildLongThread(rig, a, target, { turns: 52, activityTurns: 2 })
      await walkHistory(a, target)
      expect(thread(a, target)?.messages.length).toBe(104)
      const older = olderActivity(await serverThread(rig, target), target.threadId, early)
      await expectConverges('S10 baseline', rig, a)
      // Recording is always on; what follows is judged from here.
      const mark = rig.proxy.frames.length
      const reloaded = await rig.reload(a)
      // The cache already says "ready"; wait for the reload's own initial snapshot.
      await until(
        () =>
          downFrames(rig.proxy.frames.slice(mark)).some(
            (frame) => info(frame).reason === 'initial' && info(frame).threadId === target.threadId,
          ),
        'the reload to receive its initial thread snapshot',
      )
      await demonstrateDiff('S10', rig, reloaded, snapshotMergeDropsOlderActivity(older))
    },
  )

  scenario(
    'S11 a 30 s blackhole while idle (guard)',
    { nightly: true, timeoutMs: 120_000 },
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a, QUIET)
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
    const target = await createSession(rig, a, QUIET)
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
    // Recording is always on; what follows is judged from here.
    const mark = rig.proxy.frames.length
    rig.proxy.up()
    await untilThread(
      a,
      target,
      (state) => state.turns.some((turn) => turn.turnId === turnId && turn.state === 'completed'),
      'A to catch up',
      20_000,
    )
    const replay = threadReplays(rig.proxy.frames.slice(mark), target.threadId)[0]
    const requestId = field(replay?.json, 'requestId')
    const answer = downFrames(rig.proxy.frames.slice(mark)).find(
      (frame) => info(frame).requestId === requestId,
    )
    expect(info(answer).mode, 'an incremental replay, not a snapshot').toBe('replay')
    await expectConverges('S12', rig, a, {
      replayedEvents: (field(answer?.json, 'payload', 'events') as unknown[] | undefined)?.length,
    })
  })

  futureTest(
    'S13 a lost durable record, then a notice for the same scope',
    'F4 (a delivery-queue seam that drops one record for one connection)',
    'with A subscribed to a thread, the seam drops one durable record for A only; the server then ' +
      'publishes a turn.notice for that scope whose `after` is ahead of A’s cursor; A must recover, ' +
      'replay the missing record, apply the notice and converge (§5.5). There is nothing on main to ' +
      'drop a record for one connection, so there is no body yet.',
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

  afterPhase(
    'S14 the same answer completes over 300 B/s with no reconnect',
    'F5a (beats, rate-sized fragments)',
    { timeoutMs: 300_000 },
    async (rig) => {
      const target = await threadWithAnswer(rig, 30_000)
      rig.proxy.throttle('down', 300, 64 * KiB)
      const client = await rig.connect('C')
      await client.client.commands.openSession(target.sessionId)
      await untilThread(
        client,
        target,
        (state) => state.hydration === 'ready',
        'the answer',
        240_000,
      )
      expect(client.dials, 'the first socket carried it').toBe(1)
      expect(proxiedCloses(rig, 'heartbeat_timeout'), 'no server heartbeat close').toEqual([])
      expect(client.closes, 'no client close').toEqual([])
      await expectConverges('S14 after F5a', rig, client)
    },
  )

  scenario(
    'S15 a fast producer and a slow consumer, on main',
    { nightly: true, timeoutMs: 150_000 },
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a, QUIET)
      await startTurn(a, target)
      rig.proxy.throttle('down', 10 * KiB, 256 * KiB)
      const streaming = rig
        .provider({
          op: 'streamText',
          sessionId: target.sessionId,
          bytesPerSecond: 100 * KiB,
          durationMs: 60_000,
        })
        .catch(() => undefined)
      const samples: Array<{ atMs: number; bufferedAmount: number; proxyQueued: number }> = []
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
          proxyQueued: rig.proxy
            .backlog()
            .reduce((total, entry) => total + entry.down + entry.inspecting, 0),
        })
        await sleep(1_000)
      }
      await rig.provider({ op: 'completeTurn', sessionId: target.sessionId }).catch(() => undefined)
      await streaming
      const closes = proxiedCloses(rig, 'slow_consumer')
      if (closes.length === 0) {
        throw new FlipError('S15', 'No slow_consumer close in 70 s; enable its after-F5a half.')
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
    },
  )

  afterPhase(
    'S15 the backlog stays bounded, the scope lags and catches up',
    'F5a (send window, backlog bound, subscription.lagging and .catchup)',
    { timeoutMs: 200_000 },
    async (rig) => {
      // §7.3 FLOW_POLICY: 4 MiB maximum window, 1 MiB backlog bound.
      const bound = 4 * 1024 * KiB + 1024 * KiB
      const a = await rig.connect('A')
      const target = await createSession(rig, a, QUIET)
      await startTurn(a, target)
      rig.proxy.throttle('down', 10 * KiB, 256 * KiB)
      // Recording is always on; what follows is judged from here.
      const mark = rig.proxy.frames.length
      const streaming = rig.provider({
        op: 'streamText',
        sessionId: target.sessionId,
        bytesPerSecond: 100 * KiB,
        durationMs: 60_000,
      })
      let largest = 0
      const started = rig.now()
      while (rig.now() - started < 61_000) {
        const sockets = await rig.server.sampleSockets()
        const held = sockets.reduce((total, socket) => total + socket.bufferedAmount, 0)
        largest = Math.max(largest, held)
        // One materialized catch-up answer may come on top; the thread is the only scope here.
        expect(held, 'server buffering stays within window + backlog + one answer').toBeLessThan(
          bound + 8 * 1024 * KiB,
        )
        await sleep(1_000)
      }
      await streaming
      await rig.provider({ op: 'completeTurn', sessionId: target.sessionId })
      const names = downFrames(rig.proxy.frames.slice(mark)).map((frame) => info(frame).name)
      const lagging = names.indexOf('subscription.lagging')
      expect(lagging, 'A was told the scope is lagging').toBeGreaterThanOrEqual(0)
      expect(names.indexOf('subscription.catchup', lagging), 'then caught up').toBeGreaterThan(
        lagging,
      )
      expect(proxiedCloses(rig, 'slow_consumer'), 'never closed').toEqual([])
      recordEvidence({
        scenario: 'S15 after F5a',
        bucket: 'regression-guard',
        cause: 'bounded',
        observed: { largest },
      })
      await expectConverges('S15 after F5a', rig, a)
    },
  )

  afterPhase(
    'S16 a sudden rate drop mid-answer',
    'F5a (8 KiB fragment cap, per-frame browser watchdog)',
    { timeoutMs: 1_800_000 },
    async (rig) => {
      // Nightly shape: drop with about 1 MB left. The CI variant drops with
      // about 64 KiB left (set `leftAtDrop` to 64 KiB).
      const answer = 2_000_000
      const leftAtDrop = 1_000_000
      const target = await threadWithAnswer(rig, answer)
      rig.proxy.throttle('down', 5_000_000, 256 * KiB)
      const client = await rig.connect('C')
      void client.client.commands.openSession(target.sessionId)
      const before = rig.proxy.delivered().down
      await until(
        () => rig.proxy.delivered().down - before >= answer - leftAtDrop,
        'the first part of the answer at 5 MB/s',
        60_000,
        5,
      )
      rig.proxy.throttle('down', KiB, 256 * KiB)
      await untilThread(
        client,
        target,
        (state) => state.hydration === 'ready',
        'the rest',
        1_500_000,
      )
      expect(client.dials, 'no reconnect').toBe(1)
      expect(client.closes, 'the watchdog never fired').toEqual([])
      await expectConverges('S16', rig, client)
    },
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
    futureTest(
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
      const target = await createSession(rig, a, { quiet: true })
      const turnId = await startTurn(a, target)
      await finish(rig, a, target, turnId)
      // A valid baseline: A agrees with the server before the rename.
      await expectConverges('X1 baseline', rig, a)
      await a.client.commands.renameSession(target.sessionId, 'Renamed later')
      // Held: what A was sent (mirror.ts); newest: a server read after the check.
      await demonstrateDiff('X1', rig, a, recencyMirror(rig, a))
    },
  )

  scenario(
    'X2 a second client hears of a session only through session.created (§6.3)',
    {},
    async (rig) => {
      // A direct, so the proxy carries only B.
      const a = await rig.connect('A', { link: 'direct' })
      const b = await rig.connect('B')
      // A valid baseline before anything is created.
      await expectConverges('X2 baseline', rig, b)
      const target = await createSession(rig, a, { open: false, quiet: false })
      await until(() => b.client.getState().sessions[target.sessionId], 'B to list the new session')
      await rig.waitQuiet()
      // Nothing follows the creation, so the runtime stamp (S8's cause) shows
      // too: named for this session, by provenance.
      const causes = async () =>
        x2Causes({
          sessionId: target.sessionId,
          workspaceId: rig.workspaceId,
          providerId: 'opencode',
          createdAt: createdAt(rig.framesOf(b), target.sessionId),
          heldRecency: mirroredRecency(rig.framesOf(b), rig.workspaceId),
          witness: await witnessOf(rig, b),
        })
      await demonstrateDiff(
        'X2',
        rig,
        b,
        async () => (await causes()).primary,
        [0, 1].map((index) => async () => (await causes()).residuals[index]!),
      )
    },
  )

  /**
   * After a restart, the open chat refuses a send. A reconnecting client
   * does not send `session.open` again for a session whose scopes it still
   * subscribes to (websocket.ts:1073-1083); the restarted server serves
   * `turn.send` only for threads in memory, which only `session.open`
   * restores (thread-service.ts:1420-1422, :2231-2314). F3 owns the fix.
   * Nothing here compares state before the send: a fresh load opens the
   * session itself, which would restore the thread and hide the bug.
   */
  scenario('S17 a send in the open chat after a server restart (F3)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    const turnId = await startTurn(a, target)
    await finish(rig, a, target, turnId)
    const before = a.connects
    await rig.restart()
    await until(() => a.connects > before, 'A to reconnect after the restart', 20_000)
    await until(() => !a.busy(), 'A to finish its reconnect')
    const refused = await a.client.commands
      .sendTurn({ ...target, text: 'And now?' })
      .then(() => undefined)
      .catch((error: unknown) => error as { code?: string; message?: string })
    if (!refused) throw new FlipError('S17', 'The send was accepted after the restart.')
    expect(refused, 'refused as a missing thread').toMatchObject({
      code: 'not_found',
      message: 'Thread not found.',
    })
    // What the user must do today, and what the seeded runs do (model.test.ts):
    // reopen the chat, which restores the thread, then send.
    await a.client.commands.openSession(target.sessionId)
    const retried = await startTurn(a, target, 'And now, reopened?')
    await finish(rig, a, target, retried)
    recordEvidence({
      scenario: 'S17',
      bucket: 'known-divergence',
      cause:
        'turn.send serves only threads in memory (thread-service.ts:1420-1422); a reconnecting ' +
        'client does not reopen its session (websocket.ts:1073-1083), so after a restart the open ' +
        'chat refuses a send until it is reopened.',
      observed: { refused, afterReopen: 'accepted' },
    })
  })

  /**
   * S19 (S6(b)'s stray entry): a client's own resync opens its active session
   * once its catalog reads are answered (websocket.ts:1073-1083). An open the
   * user started meanwhile is overtaken: `openSession` bumps a generation
   * (:1243) and the older call returns as soon as its answer lands (:1281),
   * before the chat is hydrated or subscribed. A turn sent then is published
   * before the client holds the thread's subscription, so `turn.started`
   * is never owed to it live; the newer open's snapshot carries the turn,
   * and no recency (X1). No durable event is lost. The gate fixes the order
   * the race needs: the user's open goes out before the resync's reads are
   * answered, is answered after the resync's open began, and the turn goes
   * out before the resync's open is answered. F3 owns the fix (it rebuilds
   * this reopen path for S17, and derives recency on the server).
   */
  scenario(
    'S19 an open overtaken by the client’s own resync open resolves before the chat is subscribed (F3)',
    {},
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a, QUIET)
      const holds = new Map<string, () => void>()
      const hold = (name: string) =>
        new Promise<void>((resolve) => {
          holds.set(name, resolve)
        })
      const release = (name: string) => holds.get(name)?.()
      let opens = 0
      rig.proxy.gate((text) => {
        const message = JSON.parse(text) as { type?: string; name?: string }
        if (message.type !== 'command') return undefined
        if (message.name === 'session.list' && !holds.has('reads')) return hold('reads')
        if (message.name === 'session.open') {
          opens += 1
          if (opens === 1) {
            // The user's open: the resync's reads may now be answered.
            release('reads')
            return hold('user')
          }
          if (opens === 2) {
            // The resync's open has begun: the user's is answered now.
            release('user')
            return hold('resync')
          }
        }
        if (message.name === 'turn.send') release('resync')
        return undefined
      })
      // A reload: the new client holds the session as its active one, so its
      // resync opens it; the user opens it too, as soon as it is connected.
      const b = await rig.reload(a, 'proxy', 'connected')
      await b.client.commands.openSession(target.sessionId)
      const hydration = b.client.getState().threads[target.threadId]?.hydration
      if (opens < 2 || hydration === 'ready') {
        throw new FlipError('S19', `The user's open resolved with the chat ${hydration}.`)
      }
      const turnId = await startTurn(b, target)
      await untilThread(
        b,
        target,
        (state) => state.turns.some((turn) => turn.turnId === turnId),
        'B to hold the turn',
      )
      rig.proxy.gate(undefined)
      await rig.settle()
      // What the server owed B: nothing live for the turn's start, then a
      // snapshot that already held it.
      const { provenance, wire } = await witnessOf(rig, b)
      const threadKey = JSON.stringify([
        'thread',
        rig.environmentId,
        target.sessionId,
        target.threadId,
      ])
      const started = provenance.audit.find(
        (row) => row.kind === 'event' && row.name === 'turn.started' && row.scopeKey === threadKey,
      ) as { sequence: number; seq: number } | undefined
      const sockets = new Set(
        provenance.deliveries
          .filter((line) => line.port !== undefined && wire.ports.has(line.port))
          .map((line) => line.s),
      )
      const published = provenance.deliveries.find(
        (line) => line.k === 'publish' && line.key === threadKey && line.seq === started?.sequence,
      ) as { owed: string[]; sent: string[] } | undefined
      const grant = provenance.deliveries.find(
        (line) => line.k === 'grant' && line.key === threadKey && sockets.has(line.s),
      ) as { mode: string; base: number | null; a: number } | undefined
      expect(started, 'turn.started was appended').toBeDefined()
      expect(
        published?.owed.filter((socket) => sockets.has(socket)),
        'owed to B live',
      ).toEqual([])
      expect(grant, 'B subscribed to the chat afterwards, by snapshot').toMatchObject({
        mode: 'snapshot',
      })
      expect(grant!.base!, 'the snapshot already held the turn').toBeGreaterThanOrEqual(
        started!.sequence,
      )
      expect(grant!.a, 'granted after the turn was committed').toBeGreaterThan(started!.seq)
      const liveStarts = rig.framesOf(b).filter((frame) => {
        const event = (
          frame.json as { payload?: { record?: { event?: { name?: string } } } } | undefined
        )?.payload?.record?.event
        return frame.direction === 'down' && event?.name === 'turn.started'
      })
      expect(liveStarts, 'no live turn.started reached B').toEqual([])
      await demonstrateDiff('S19', rig, b, recencyMirror(rig, b))
      recordEvidence({
        scenario: 'S19',
        bucket: 'known-divergence',
        cause:
          'openSession returns when a newer open of the same session overtakes it ' +
          '(websocket.ts:1243, :1281), before the chat is subscribed; the resync opens the active ' +
          'session after its reads (:1073-1083). A turn sent then reaches the chat only through ' +
          "the newer open's thread snapshot, which carries no recency (X1). F3 owns the fix.",
        observed: {
          hydrationWhenOpenResolved: hydration,
          sessionOpens: opens,
          turnStarted: { sequence: started!.sequence, owedToB: false },
          grant: { mode: grant!.mode, base: grant!.base },
        },
      })
    },
  )

  /**
   * S18: a session announced and durable before its provider identity exists
   * cannot survive a hard crash in between. `session.create` persists and
   * announces the session (thread-service.ts:1844-1862) and only stamps the
   * provider session once `session/new` resolves (:1867-1880, :435-443);
   * restoring it after a restart needs that identity (:2297-2303). A crash
   * inside that window leaves a session every client lists and none can
   * open, through any number of restarts. Not a sync property but a
   * durability one, outside F2's tests-only scope: F3 owns the fix
   * (initialization that a restart can resume, or an explicit failure that
   * removes or marks the session). A graceful restart does not show it: the
   * shutdown waits for pending starts.
   */
  scenario(
    'S18 a hard crash while the provider creates the session; it never opens again (F3)',
    { newSessionDelayMs: 3_000 },
    async (rig) => {
      const a = await rig.connect('A')
      // Announced and durable at once; its provider answers 3 s later.
      const target = await createSession(rig, a, { open: false, quiet: false })
      expect(await rig.server.readUnidentified(), 'durable without a provider identity').toContain(
        target.sessionId,
      )
      const before = a.connects
      await rig.crash()
      await until(() => a.connects > before, 'A to reconnect after the crash', 20_000)
      await until(() => !a.busy(), 'A to finish its reconnect')
      const attempts: Array<{ when: string; who: string; outcome: unknown }> = []
      const open = async (who: string, client: TestClient, when: string) => {
        const outcome = await client.client.commands
          .openSession(target.sessionId)
          .then(() => 'opened')
          .catch((error: unknown) => {
            const { code, message } = error as { code?: string; message?: string }
            return { code, message }
          })
        attempts.push({ when, who, outcome })
        return outcome
      }
      const refusal = {
        code: 'unavailable',
        message: 'The provider session identity is unavailable.',
      }
      if ((await open('A', a, 'after the crash')) === 'opened') {
        throw new FlipError('S18', 'The interrupted session opened after the crash.')
      }
      // A fresh client is refused the same way, and the session is still listed.
      const fresh = await rig.connect('F', { link: 'direct' })
      await open('fresh client', fresh, 'after the crash')
      fresh.dispose()
      const listed = (await rig.server.readSessions()) as Array<{ sessionId: string }>
      expect(listed.map((session) => session.sessionId)).toContain(target.sessionId)
      // A graceful restart does not repair it: the identity never comes.
      const again = a.connects
      await rig.restart()
      await until(() => a.connects > again, 'A to reconnect after the restart', 20_000)
      await until(() => !a.busy(), 'A to finish its reconnect')
      await open('A', a, 'after a later graceful restart')
      expect(await rig.server.readUnidentified()).toContain(target.sessionId)
      for (const attempt of attempts) {
        expect(attempt.outcome, `${attempt.who} ${attempt.when}`).toEqual(refusal)
      }
      recordEvidence({
        scenario: 'S18',
        bucket: 'known-divergence',
        cause:
          'session.create persists and announces the session before the provider identity exists ' +
          '(thread-service.ts:1844-1862, :1867-1880); restoration requires it (:2297-2303), so a ' +
          'hard crash in between leaves a listed session no client can ever open. F3 owns the fix.',
        observed: { attempts, stillListed: true },
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
    const target = await createSession(rig, a, { providerId: 'cursor', quiet: true })
    // B lists the session once, so it knows its provider (not X2's subject here).
    await b.client.commands.listSessions()
    await startTurn(a, target)
    const waitingOn = () => b.client.getState().sessions[target.sessionId]?.waitingOn
    const steps: Array<{ step: string; waitingOn: unknown }> = []
    const settle = async (step: string, expected: string | undefined) => {
      await until(() => waitingOn() === expected || undefined, `B to show waitingOn ${expected}`)
      // Interaction events move sessions.updated_at, and with it the
      // workspace's recency, with no workspace event (X1): named, from what
      // each client was sent and a server read.
      await expectConvergesExcept(`G1 ${step} (sidebar)`, rig, b, [recencyMirror(rig, b)])
      await expectConvergesExcept(`G1 ${step} (chat)`, rig, a, [recencyMirror(rig, a)])
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
   * #219's `inBackground`: a Claude Code turn ends with a background task
   * still running, so the session stays running for that work alone; the
   * roster empties and it rests; a restart while work runs clears it
   * (forgetStaleBackgroundWork). A sidebar-only client must follow each step.
   */
  scenario(
    'G3 inBackground follows background-only work, and a restart (#219, guard)',
    {},
    async (rig) => {
      const a = await rig.connect('A')
      const b = await rig.connect('B')
      const target = await createSession(rig, a, { providerId: 'claude', quiet: true })
      await b.client.commands.listSessions()
      const row = () => b.client.getState().sessions[target.sessionId]
      const steps: Array<{ step: string; status: unknown; inBackground: unknown }> = []
      const settle = async (step: string, status: string, inBackground: true | undefined) => {
        await until(
          () => (row()?.status === status && row()?.inBackground === inBackground) || undefined,
          `B to show ${status}${inBackground ? ', in the background' : ''}`,
        )
        await expectConvergesExcept(`G3 ${step} (sidebar)`, rig, b, [recencyMirror(rig, b)])
        await expectConvergesExcept(`G3 ${step} (chat)`, rig, a, [recencyMirror(rig, a)])
        steps.push({ step, status: row()?.status, inBackground: row()?.inBackground })
      }
      const shell = { task_id: 'bg-1', task_type: 'local_bash', description: 'Run the build' }
      let prompts = 0
      const turnWithBackgroundWork = async () => {
        await startTurn(a, target, `Build it ${prompts + 1}`)
        await rig.provider({ op: 'claudeWaitPrompt', prompts: ++prompts })
        await rig.provider({ op: 'claudeBackground', tasks: [shell] })
        await rig.provider({ op: 'claudeComplete' })
      }
      await turnWithBackgroundWork()
      await settle('turn ended, work still running', 'running', true)
      await rig.provider({ op: 'claudeBackground', tasks: [] })
      await settle('work finished', 'idle', undefined)
      await turnWithBackgroundWork()
      await settle('second turn ended, work still running', 'running', true)
      const before = b.connects
      await rig.restart()
      await until(() => b.connects > before, 'B to reconnect after the restart', 20_000)
      await settle('server restarted while work ran', 'idle', undefined)
      recordEvidence({
        scenario: 'G3',
        bucket: 'regression-guard',
        cause: 'inBackground',
        observed: steps,
      })
    },
  )

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
      const target = await createSession(rig, a, { title: 'With a draft', quiet: true })
      await b.client.commands.openSession(target.sessionId)
      // A turn, so the session's last change is one every client mirrors.
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
      // Equal is not enough: B holds what A asked for.
      const held = () => ({
        draft: b.client.getState().drafts[target.sessionId]?.content.text,
        newDraft: b.client.getState().drafts[newDraftId]?.content.text,
        mode: b.client.getState().composerPreferences[pair.workspaceId]?.[pair.providerId]?.modeId,
      })
      expect(held()).toEqual({ draft: 'first words', newDraft: undefined, mode: 'plan' })

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
      const replayedFrom = rig.proxy.frames.length
      rig.proxy.up()
      await expectConverges('G2 after a replayed gap', rig, b)
      expect(held()).toEqual({ draft: 'second words', newDraft: 'a new chat', mode: 'build' })
      const replayed = downFrames(rig.proxy.frames.slice(replayedFrom)).find(
        (frame) => info(frame).type === 'response' && info(frame).scopeType === 'environment',
      )
      expect(info(replayed).mode, 'the first gap was caught up by replay').toBe('replay')

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
      // Recording is always on; what follows is judged from here.
      const mark = rig.proxy.frames.length
      rig.proxy.up()
      await expectConverges('G2 after a snapshot gap', rig, b)
      const environment = downFrames(rig.proxy.frames.slice(mark)).find(
        (frame) => info(frame).mode === 'snapshot' && info(frame).scopeType === 'environment',
      )
      expect(info(environment).reason, 'the second gap was caught up by snapshot').toBe(
        'gap_expired',
      )
      expect(held()).toEqual({ draft: 'third words', newDraft: undefined, mode: 'plan' })
      driver.dispose()
    },
  )
})
