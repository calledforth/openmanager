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
import { selectDraftListing } from '@openmanager/environment-client'
import { expectConverges, recordEvidence } from './evidence.ts'
import {
  Driver,
  sleep,
  until,
  type EnvironmentState,
  type Rig,
  type TestClient,
} from './harness.ts'
import type { FrameFields, FrameRecord } from './link-proxy.ts'
import { serverSessionsView, serverThreadView, type ThreadView } from './normalize.ts'
import { witnessOf } from './fixtures.ts'
import { createdAt } from './mirror.ts'
import { scenario } from './scenario.ts'
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

/** The server's own read of a thread, normalized. */
async function serverThread(rig: Rig, target: Target): Promise<ThreadView> {
  return serverThreadView(await rig.server.readThread(target.sessionId, target.threadId))
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
 * A slow but healthy download (S7, S14): a client on a slow link opens a
 * thread right after its handshake and must get it on its first socket, with
 * no close on either side. Before F5a the ping queued behind the answer
 * missed its deadline and the server closed the socket as dead.
 */
async function completesOverSlowLink(
  name: string,
  rig: Rig,
  target: Target,
  link: { bytesPerSecond: number; bufferBytes: number },
  timeoutMs: number,
) {
  rig.proxy.throttle('down', link.bytesPerSecond, link.bufferBytes)
  const client = await rig.connect('C')
  const started = rig.now()
  await client.client.commands.openSession(target.sessionId)
  await untilThread(client, target, (state) => state.hydration === 'ready', 'the answer', timeoutMs)
  expect(client.dials, 'the first socket carried it').toBe(1)
  expect(proxiedCloses(rig, 'heartbeat_timeout'), 'no server heartbeat close').toEqual([])
  expect(client.closes, 'no client close').toEqual([])
  await expectConverges(name, rig, client, { link, downloadMs: rig.now() - started })
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

/** A copy with nothing to resume from, as a cache written before kept cursors. */
function withoutCursors(state: EnvironmentState): EnvironmentState {
  return {
    ...state,
    cursors: { environment: null, sessions: {} },
    threads: Object.fromEntries(
      Object.entries(state.threads).map(([id, held]) => [id, { ...held, cursor: undefined }]),
    ),
  }
}

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
    // A valid baseline: before the crash A agrees with the server, the
    // workspace recency the question moved included (announced since F3).
    await expectConverges('S1 baseline', rig, a)
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
    // Closed by the text, while the turn is still running: the turn's end
    // would close it too, so checking only after it would prove nothing.
    await untilThread(
      a,
      target,
      (state) => state.reasoning[0]?.phase === 'stop',
      'A to hold the thought closed while the turn runs',
    )
    expect(turnState(a, target, turnId)).toBe('running')
    await rig.waitQuiet()
    const running = await serverThread(rig, target)
    expect(
      (running.turns as Array<{ turnId: string; state: string }>).find(
        (turn) => turn.turnId === turnId,
      )?.state,
    ).toBe('running')
    expect(
      Object.values(running.reasoning).map((thought) => (thought as { phase?: string }).phase),
    ).toEqual(['stop'])
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

  /**
   * Guard since F5b (§6): a thread longer than the old 100-message page, with
   * thoughts and tools in its earliest turns, and a gap far past the old
   * 500-event / 256 KiB replay cap. The catch-up is a replay of the gap or
   * the whole thread, whichever is smaller, and either way the client ends
   * up with the whole thread. On main the cap turned the gap into a snapshot
   * of the newest 100 messages, and the merge dropped the older turns'
   * thoughts and tools for good (W2).
   */
  scenario(
    'S4 a long thread, a gap past the old replay cap, then a reconnect (guard)',
    { timeoutMs: 180_000 },
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a, QUIET)
      const early = await buildLongThread(rig, a, target, { turns: 52, activityTurns: 2 })
      // The whole thread arrived with the open: no page to walk.
      expect(thread(a, target)?.messages.length).toBe(104)
      const held = thread(a, target)!
      for (const turnId of early) {
        expect(held.reasoning.some((item) => item.turnId === turnId)).toBe(true)
        expect(held.tools.some((item) => item.turnId === turnId)).toBe(true)
      }
      await expectConverges('S4 baseline', rig, a)
      rig.proxy.down()
      rig.proxy.cut()
      await until(() => a.client.getState().connection.phase !== 'connected', 'A to notice the cut')
      // 300 KB in one turn: past the old 256 KiB replay budget.
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
        30_000,
      )
      const answer = downFrames(rig.proxy.frames.slice(mark)).find(
        (frame) => info(frame).type === 'response' && info(frame).threadId === target.threadId,
      )
      recordEvidence({
        scenario: 'S4',
        bucket: 'regression-guard',
        cause: 'whole catch-up',
        observed: { mode: info(answer).mode, reason: info(answer).reason ?? null },
      })
      await expectConverges('S4', rig, a)
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
    // transient `turn.notice`.
    await rig.provider({
      op: 'emitTextThenUnstorableImage',
      sessionId: target.sessionId,
      text: 'first words',
    })
    await rig.provider({ op: 'emitText', sessionId: target.sessionId, text: ' then more' })
    await finish(rig, a, target, turnId)
    await rig.waitQuiet()
    const frames = downFrames(rig.proxy.frames.slice(mark))
    const notice = frames.findIndex(
      (frame) =>
        field(frame.json, 'name') === 'subscription.transient' &&
        field(frame.json, 'payload', 'event', 'name') === 'turn.notice',
    )
    const firstText = frames.findIndex(
      (frame) =>
        field(frame.json, 'name') === 'subscription.event' &&
        field(frame.json, 'payload', 'record', 'event', 'name') === 'message.delta' &&
        field(frame.json, 'payload', 'record', 'event', 'payload', 'role') === 'assistant',
    )
    expect(notice, 'the server published the notice to the thread').toBeGreaterThanOrEqual(0)
    expect(firstText, 'the first text reached the client').toBeGreaterThanOrEqual(0)
    // F4: publishing the notice flushes the batcher, so the text it came
    // after is committed and queued first, and the notice is placed after it.
    expect(notice, 'the notice follows the text it came after').toBeGreaterThan(firstText)
    expect(
      field(frames[notice]?.json, 'payload', 'after', 'sequence'),
      'placed after the text record',
    ).toBe(field(frames[firstText]?.json, 'payload', 'record', 'cursor', 'sequence'))
    expect(
      thread(a, target)?.notices.map((item) => item.message),
      'A applied the notice',
    ).toEqual(['A generated image could not be stored.'])
    // The comparison leaves notices out; the state itself converges.
    await expectConverges('S5 (state, notices excluded)', rig, a)
  })

  /**
   * Guard since F5a (§7.2): a message over 1 MiB goes out in fragments, and
   * nothing closes a socket for the size of what it carries. On main the
   * snapshot frame passed the 1 MiB buffer limit and the server closed with
   * `slow_consumer`, on every retry (W4).
   */
  scenario(
    'S6(a) a 1.2 MB message, then a fresh client opens the thread (guard)',
    {},
    async (rig) => {
      const target = await threadWithAnswer(rig, 1_200_000)
      const fresh = await rig.connect('F', { link: 'direct' })
      await fresh.client.commands.openSession(target.sessionId)
      await untilThread(fresh, target, (state) => state.hydration === 'ready', 'the thread')
      expect(fresh.closes, 'no close').toEqual([])
      expect(fresh.dials).toBe(1)
      await expectConverges('S6(a)', rig, fresh)
    },
  )

  /**
   * Guard since F5b (§7.1): thoughts over the old 384 KiB budget. A fresh
   * load gets the whole text; on main it got a "not loaded" note while the
   * live client held the full thought.
   */
  scenario('S6(b) thoughts over 384 KiB (guard)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    await startTurn(a, target)
    // The turn stays open, as on main's demonstration.
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
    const server = await serverThread(rig, target)
    const [messageId] = Object.keys(server.reasoning)
    expect(JSON.stringify(server.reasoning[messageId!])).not.toContain('not loaded')
    await expectConverges('S6(b)', rig, a)
  })

  scenario(
    'S7 a 600 KB answer over a 10 KB/s link completes on the first socket (guard)',
    { nightly: true, timeoutMs: 180_000 },
    async (rig) => {
      const target = await threadWithAnswer(rig, 600_000)
      await completesOverSlowLink(
        'S7',
        rig,
        target,
        { bytesPerSecond: 10_000, bufferBytes: 256 * KiB },
        150_000,
      )
    },
  )

  /**
   * Guard since F3 (§4.4): the runtime stamp writes the provider identity
   * alone, a host-private column, so a session's time is the `session.created`
   * time every client heard. On main the stamp moved `updated_at` with no
   * event, and a watching client sorted the sidebar by a time the server no
   * longer had (RUNTIME_STAMP). The rename of the older session lands inside
   * the 500 ms before the new session's stamp, as on main.
   */
  scenario(
    'S8 a session created while another client watches (§4.4, guard)',
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
      await expectConverges('S8 baseline', rig, b)
      const created = await createSession(rig, a, { title: 'New', open: false, quiet: false })
      // Inside the 500 ms before the new session's stamp: the older one moves above it.
      await a.client.commands.renameSession(older.sessionId, 'Older, renamed')
      await until(
        () => b.client.getState().sessions[created.sessionId],
        'B to list the new session',
      )
      // The stamp has landed: the session has its provider identity.
      await until(
        async () => !(await rig.server.readUnidentified()).includes(created.sessionId),
        'the new session to be stamped',
      )
      await rig.waitQuiet()
      await expectConverges('S8', rig, b)
      // Equal is not enough: the server's time for the new session is still the one announced.
      const server = serverSessionsView(await rig.server.readSessions()) as Array<{
        sessionId: string
        updatedAt: string
      }>
      expect(server.find((row) => row.sessionId === created.sessionId)?.updatedAt).toBe(
        createdAt(rig.framesOf(b), created.sessionId),
      )
    },
  )

  /**
   * Guard since F3 (§4.7.4 (e)): a child's provider identity is stored by the
   * write that creates its row, so there is no second write for a time to
   * move in. On main the stamp followed the insert as its own write and
   * moved `updatedAt` whenever the clock crossed a millisecond in between.
   */
  scenario(
    'S8 (child) a child session registered through subtask_update (guard)',
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
      expect(
        await rig.server.readUnidentified(),
        'the child is durable with its identity',
      ).not.toContain(child.sessionId)
      await finish(rig, a, parent, turnId)
      // The recency the turn moved is announced too (X1, §4.7.1).
      await expectConverges('S8 (child)', rig, b)
      // One write to the child's row: its insert, identity included.
      const { provenance } = await witnessOf(rig, b)
      const writes = provenance.audit.filter(
        (row) => row.kind === 'session' && row.sessionId === child.sessionId,
      )
      expect(writes).toMatchObject([{ op: 'insert', newProvider: 'fake-child-1' }])
    },
  )

  /**
   * The S9 setup: a parent with a child, 110 other sessions (more than one
   * catalog page, and enough to move a whole page between any two reads), B
   * holding the whole catalog and an environment cursor, then B cut while
   * the parent is deleted and 501 renames push the environment stream past
   * the replay cap. Since F3 a rename moves no session (§4.7.1), so the
   * renames still make the gap but no longer move the catalog; turns do.
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
    const targets: Target[] = []
    for (let index = 0; index < 110; index++) {
      const client = await driver.client()
      targets.push(
        await createSession(rig, client, { title: `S${index}`, open: false, quiet: false }),
      )
    }
    const others = targets.map((target) => target.sessionId)
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
    // A valid baseline: B agrees with the server before the cut.
    await expectConverges('S9 baseline', rig, b)
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
    return { driver, b, parent, child: child.sessionId, others, targets, total, rows }
  }

  /**
   * Guard since F5b (§6.2): B is away while a parent and its child are
   * deleted and 501 renames push the environment far past the old replay
   * cap, and turns keep moving sessions while it reconnects. B catches the
   * environment up by a replay or the whole environment, whichever is
   * smaller, and drops both sessions either way. On main the environment
   * snapshot only upserted the newest 100 sessions and the catalog walk
   * never settled, so B kept the deleted sessions.
   */
  scenario(
    'S9 a deleted parent and child, a gap past the old replay cap, a moving catalog (guard)',
    { timeoutMs: 180_000 },
    async (rig) => {
      const { driver, b, parent, child, targets, total } = await s9Setup(rig, 'fake-child-s9')
      // Each turn ends by itself, so a session is free again long before its next one.
      await rig.provider({ op: 'setAutoScript', steps: [{ op: 'complete' }] })
      let turns = 0
      // A whole page of sessions moves while B reconnects: a turn is activity.
      const moving = (async () => {
        for (let index = 0; index < 101; index++) {
          const target = targets[turns++ % targets.length]!
          await (
            await driver.client()
          ).client.commands.sendTurn({ ...target, text: `Move ${turns}` })
        }
      })()
      // Recording is always on; what follows is judged from here.
      const mark = rig.proxy.frames.length
      rig.proxy.up()
      await moving
      await until(
        () =>
          !b.client.getState().sessions[parent.sessionId] && !b.client.getState().sessions[child],
        'B to drop the deleted parent and child',
        60_000,
        50,
      )
      await rig.waitQuiet()
      const environmentAnswer = downFrames(rig.proxy.frames.slice(mark)).find(
        (frame) => info(frame).type === 'response' && info(frame).scopeType === 'environment',
      )
      recordEvidence({
        scenario: 'S9',
        bucket: 'regression-guard',
        cause: 'whole environment',
        observed: {
          sessions: total,
          renames: 501,
          movingTurns: turns,
          mode: info(environmentAnswer).mode,
          reason: info(environmentAnswer).reason ?? null,
        },
      })
      await expectConverges('S9', rig, b)
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

  /**
   * Guard since F3 (§4.4, §3.6 row 12): a deletion inside the replay window.
   * B holds an environment cursor and is cut while a parent with a child is
   * deleted; its replay brings one `session.deleted` per session, the child's
   * first, and B drops each on its own event: the client mirrors no cascade.
   */
  scenario('S9r a cascade inside the replay window (guard)', {}, async (rig) => {
    const a = await rig.connect('A', { link: 'direct' })
    const parent = await createSession(rig, a, { title: 'Parent', quiet: true })
    const turnId = await startTurn(a, parent)
    await rig.provider({
      op: 'emitSubtask',
      sessionId: parent.sessionId,
      toolCallId: 'task-1',
      childProviderSessionId: 'fake-child-s9r',
    })
    await finish(rig, a, parent, turnId)
    const child = await until(
      () =>
        Object.values(a.client.getState().sessions).find(
          (session) => session.parentSessionId === parent.sessionId,
        ),
      'the child session',
    )
    const other = await createSession(rig, a, { title: 'Other', open: false, quiet: true })
    // Enough other sessions that the whole environment is larger than the
    // two deletions, so the catch-up is a replay of them (§6.1).
    for (let index = 0; index < 12; index++) {
      await createSession(rig, a, { title: `Filler ${index}`, open: false, quiet: true })
    }
    const b = await rig.connect('B')
    await until(
      () => b.client.getState().sessions[child.sessionId],
      'B to list the parent and its child',
    )
    // B holds an environment cursor once a live environment event reached it.
    await a.client.commands.renameSession(other.sessionId, 'Seen by B')
    await until(
      () => b.client.getState().sessions[other.sessionId]?.title === 'Seen by B',
      'B to apply a live environment event',
    )
    await expectConverges('S9r baseline', rig, b)
    rig.proxy.down()
    rig.proxy.cut()
    await until(() => b.client.getState().connection.phase !== 'connected', 'B to notice the cut')
    await a.client.commands.deleteSession(parent.sessionId)
    // Recording is always on; what follows is judged from here.
    const mark = rig.proxy.frames.length
    rig.proxy.up()
    await until(
      () => !b.client.getState().sessions[parent.sessionId],
      'B to drop the deleted parent',
      20_000,
    )
    await rig.waitQuiet()
    const frames = downFrames(rig.proxy.frames.slice(mark))
    const environmentReplay = frames.find(
      (frame) => info(frame).type === 'response' && info(frame).scopeType === 'environment',
    )
    expect(info(environmentReplay).mode, 'B caught up by replay, not a snapshot').toBe('replay')
    const deleted = frames.flatMap((frame) => {
      const json = frame.json as { payload?: { events?: unknown[] } } | undefined
      const records = (json?.payload?.events ?? []) as Array<{
        event?: { name?: string; payload?: { sessionId?: string } }
      }>
      return records
        .filter((record) => record.event?.name === 'session.deleted')
        .map((record) => record.event!.payload!.sessionId)
    })
    expect(deleted, 'one session.deleted per session, the child first').toEqual([
      child.sessionId,
      parent.sessionId,
    ])
    await expectConverges('S9r', rig, b)
    expect(b.client.getState().sessions[child.sessionId]).toBeUndefined()
  })

  /**
   * Guard since F5b (§6.2): a reload with the cache seeded and no cursors
   * asks for the thread whole, which replaces the cached copy. On main the
   * newest-100 snapshot was merged over the cache and the older turns'
   * thoughts and tools were dropped. Kept cursors are taken out here, so this
   * stays the no-cursor path; the KC scenarios cover resuming from them.
   */
  scenario('S10 a long thread, then a reload (guard)', { timeoutMs: 180_000 }, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    await buildLongThread(rig, a, target, { turns: 52, activityTurns: 2 })
    expect(thread(a, target)?.messages.length).toBe(104)
    await expectConverges('S10 baseline', rig, a)
    // Recording is always on; what follows is judged from here.
    const mark = rig.proxy.frames.length
    const reloaded = await rig.reload(a, 'proxy', true, withoutCursors)
    // The cache already says "ready"; wait for the reload's own initial snapshot.
    await until(
      () =>
        downFrames(rig.proxy.frames.slice(mark)).some(
          (frame) => info(frame).reason === 'initial' && info(frame).threadId === target.threadId,
        ),
      'the reload to receive its initial thread snapshot',
    )
    await expectConverges('S10', rig, reloaded)
  })

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

  scenario('S12 a short cut while streaming, replayed (guard)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    const turnId = await startTurn(a, target)
    // Text before the cut, so the whole thread is larger than the short gap
    // and the catch-up is the replay this guard checks (§6.1).
    await emitLargeText(rig, target, 64 * KiB, 'text')
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

  scenario('S13 a lost durable record, then a notice for the same scope', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, QUIET)
    const turnId = await startTurn(a, target)
    await rig.waitQuiet()
    const mark = rig.proxy.frames.length
    // The seam (§5.5): the text record leaves the queue and reaches no
    // socket. A is the only connection on this thread, so only A loses it.
    await rig.server.call({ op: 'dropNextRecord', threadId: target.threadId })
    // The text, then the notice for the refused image: the notice is placed
    // after the text, which A never received.
    await rig.provider({
      op: 'emitTextThenUnstorableImage',
      sessionId: target.sessionId,
      text: 'lost words',
    })
    await untilThread(
      a,
      target,
      (state) => state.notices.length > 0,
      'A to catch up and apply the notice',
      20_000,
    )
    const dropped = await rig.server.call<Array<{ threadId: string; sequence: number }>>({
      op: 'readDropped',
    })
    expect(dropped, 'the seam dropped exactly the text record').toEqual([
      expect.objectContaining({ threadId: target.threadId, event: 'message.delta' }),
    ])
    const frames = rig.proxy.frames.slice(mark)
    expect(
      downFrames(frames).some(
        (frame) =>
          field(frame.json, 'name') === 'subscription.event' &&
          field(frame.json, 'payload', 'record', 'cursor', 'sequence') === dropped[0]!.sequence,
      ),
      'the lost record never arrived live',
    ).toBe(false)
    // The notice was ahead of A's cursor, so A caught up from it.
    const replay = threadReplays(frames, target.threadId)[0]
    expect(replay, 'A recovered from its cursor').toBeDefined()
    expect(field(replay?.json, 'payload', 'cursor', 'sequence')).toBe(dropped[0]!.sequence - 1)
    expect(thread(a, target)?.notices.map((item) => item.message)).toEqual([
      'A generated image could not be stored.',
    ])
    expect(
      thread(a, target)
        ?.messages.filter((message) => message.role === 'assistant')
        .map((message) =>
          message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
        ),
      'the replay brought the lost text',
    ).toEqual(['lost words'])
    await finish(rig, a, target, turnId)
    await rig.waitQuiet()
    await expectConverges('S13', rig, a)
  })

  scenario(
    'S14 a 30 KB answer over a 300 B/s link completes on the first socket (guard)',
    { nightly: true, timeoutMs: 300_000 },
    async (rig) => {
      const target = await threadWithAnswer(rig, 30_000)
      await completesOverSlowLink(
        'S14',
        rig,
        target,
        { bytesPerSecond: 300, bufferBytes: 64 * KiB },
        240_000,
      )
    },
  )

  /**
   * Guard since F5a (§7.2 point 2): a provider writes about 100 KiB/s into a
   * thread whose reader's link takes 10 KiB/s. The server holds at most the
   * window, the backlog bound and one catch-up answer for that socket; the
   * scope is told it is lagging and then caught up, nothing closes, and once
   * the producer stops and the link recovers the reader converges. On main
   * the server closed the socket with `slow_consumer` (or, with a large
   * proxy buffer, buffered without bound).
   *
   * Delivering all ~6 MB at 10 KiB/s would take ten minutes whatever the
   * protocol does, so the link is healed once the producer stops.
   */
  scenario(
    'S15 a fast producer and a slow consumer stay bounded, lag and catch up (guard)',
    { nightly: true, timeoutMs: 240_000 },
    async (rig) => {
      // FLOW_POLICY: 4 MiB maximum window, 1 MiB backlog bound.
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
      const samples: Array<{ atMs: number; held: number; lagging: number; produced: number }> = []
      const started = rig.now()
      let done = false
      void streaming.finally(() => {
        done = true
      })
      while (!done) {
        const sockets = (await rig.server.sampleSockets()).filter(
          (socket) =>
            socket.remotePort !== undefined && rig.proxy.serverSidePorts.has(socket.remotePort),
        )
        const held = sockets.reduce((total, socket) => total + socket.queued + socket.inFlight, 0)
        const produced = await rig.server.call<{ bytes: number }>({ op: 'readStreamed' })
        samples.push({
          atMs: rig.now() - started,
          held,
          lagging: sockets.reduce((total, socket) => total + socket.lagging, 0),
          produced: produced.bytes,
        })
        await sleep(1_000)
      }
      await streaming
      const largest = Math.max(...samples.map((sample) => sample.held))
      const produced = samples.at(-1)?.produced ?? 0
      // One materialized catch-up answer may come on top: at most the thread.
      expect(largest, 'server holds window + backlog + one answer at most').toBeLessThanOrEqual(
        bound + produced + 64 * KiB,
      )
      expect(proxiedCloses(rig, 'slow_consumer'), 'never closed').toEqual([])
      expect(a.closes, 'the reader kept its socket').toEqual([])
      rig.proxy.heal()
      await rig.provider({ op: 'completeTurn', sessionId: target.sessionId })
      await rig.waitQuiet()
      const names = downFrames(rig.proxy.frames.slice(mark)).map((frame) => info(frame).name)
      const lagging = names.indexOf('subscription.lagging')
      expect(lagging, 'A was told the scope is lagging').toBeGreaterThanOrEqual(0)
      expect(names.indexOf('subscription.catchup', lagging), 'then caught up').toBeGreaterThan(
        lagging,
      )
      recordEvidence({
        scenario: 'S15',
        bucket: 'regression-guard',
        cause: 'bounded',
        observed: { largest, produced, bound, samples },
      })
      await expectConverges('S15', rig, a)
    },
  )

  /**
   * Guard since F5a (§7.2 point 1, the 8 KiB fragment cap): a large answer is
   * downloading fast when the link drops to 1 KiB/s. Every frame already in
   * flight is at most 8 KiB, so each still arrives within about 8 s, the
   * browser's 45 s watchdog never fires, and the answer completes on its
   * first socket. The nightly shape drops with about 1 MB left (some 17
   * minutes at 1 KiB/s); the fast one with about 64 KiB left.
   */
  for (const shape of [
    {
      name: 'S16 a sudden rate drop mid-answer (guard)',
      answer: 400_000,
      left: 64 * KiB,
      nightly: false,
    },
    {
      name: 'S16 a sudden rate drop mid-answer, 1 MB left (guard)',
      answer: 2_000_000,
      left: 1_000_000,
      nightly: true,
    },
  ]) {
    scenario(
      shape.name,
      { nightly: shape.nightly, timeoutMs: shape.nightly ? 1_800_000 : 300_000 },
      async (rig) => {
        const target = await threadWithAnswer(rig, shape.answer)
        rig.proxy.throttle('down', 5_000_000, 256 * KiB)
        const client = await rig.connect('C')
        const before = rig.proxy.delivered().down
        void client.client.commands.openSession(target.sessionId).catch(() => undefined)
        await until(
          () => rig.proxy.delivered().down - before >= shape.answer - shape.left,
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
          shape.nightly ? 1_500_000 : 240_000,
        )
        expect(client.dials, 'no reconnect').toBe(1)
        expect(client.closes, 'the watchdog never fired').toEqual([])
        rig.proxy.heal()
        await expectConverges(shape.name, rig, client)
      },
    )
  }

  // W1-W7, the crash windows: crash-windows.test.ts.
})

describe('divergences on main that §8.4 does not list', () => {
  /**
   * Guard since F3 (§4.7.1): a title is not activity. A rename moves neither
   * the session's time nor its workspace's recency, on the server or on any
   * client. On main the rename stamped `updated_at`, which moved the
   * workspace's recency with no event (WORKSPACE_RECENCY_MIRROR).
   */
  scenario('X1 a rename moves nothing in the sidebar (§4.7.1, guard)', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, { quiet: true })
    const turnId = await startTurn(a, target)
    await finish(rig, a, target, turnId)
    await rig.waitQuiet()
    // A valid baseline: A agrees with the server before the rename.
    const before = await expectConverges('X1 baseline', rig, a)
    await a.client.commands.renameSession(target.sessionId, 'Renamed later')
    const after = await expectConverges('X1', rig, a)
    // Equal is not enough: the rename moved nothing, on the server either.
    const time = (view: typeof before.fresh) =>
      (view.sessions as Array<{ sessionId: string; updatedAt: string }>).find(
        (row) => row.sessionId === target.sessionId,
      )?.updatedAt
    expect(time(after.fresh)).toBe(time(before.fresh))
    expect(after.fresh.workspaces[rig.workspaceId]).toMatchObject({
      lastActivityAt: (before.fresh.workspaces[rig.workspaceId] as { lastActivityAt: unknown })
        .lastActivityAt,
    })
  })

  /**
   * Guard since F3 (§4.7.2): `session.created` carries the whole row, so a
   * client that only heard the event holds what a fresh load would: the
   * provider (no OpenCode fallback in the sidebar), the status and the time.
   * On main it carried a bare Session (SESSION_CREATED_PARTIAL). Created on
   * Cursor, so a guessed default would show.
   */
  scenario(
    'X2 a second client hears of a session only through session.created (§4.7.2, guard)',
    {},
    async (rig) => {
      // A direct, so the proxy carries only B.
      const a = await rig.connect('A', { link: 'direct' })
      const b = await rig.connect('B')
      // A valid baseline before anything is created.
      await expectConverges('X2 baseline', rig, b)
      const target = await createSession(rig, a, {
        providerId: 'cursor',
        open: false,
        quiet: false,
      })
      await until(() => b.client.getState().sessions[target.sessionId], 'B to list the new session')
      await rig.waitQuiet()
      await expectConverges('X2', rig, b)
      // Equal is not enough: B holds what it was told, from the event alone.
      expect(b.client.getState().sessions[target.sessionId]).toMatchObject({
        providerId: 'cursor',
        status: 'idle',
        updatedAt: createdAt(rig.framesOf(b), target.sessionId),
      })
      const listed = rig
        .framesOf(b)
        .filter(
          (frame) =>
            frame.direction === 'up' &&
            (frame.json as { name?: string } | undefined)?.name === 'session.list',
        ).length
      recordEvidence({
        scenario: 'X2',
        bucket: 'regression-guard',
        cause: 'session.created carries a SessionSummary',
        observed: { sessionListReads: listed },
      })
    },
  )

  /**
   * Guard since F3 (§4.7.3): after a restart the open chat accepts a send.
   * The restarted server holds no records, and the reconnecting client still
   * subscribes to the chat's scopes, so on main nothing reopened it and the
   * send was refused as a missing thread. Now the server loads the chat for
   * any command that needs it. The client also reopens its active chat when
   * the server instance changed, as a backup, once its catalog reads are
   * answered; the send goes out before that, and the server's request log
   * shows it was served before any reopen, so it proves the server's path.
   */
  scenario(
    'S17 a send in the open chat after a server restart (§4.7.3, guard)',
    {},
    async (rig) => {
      const a = await rig.connect('A')
      const target = await createSession(rig, a, QUIET)
      const turnId = await startTurn(a, target)
      await finish(rig, a, target, turnId)
      a.dispose()
      await rig.restart()
      // A client with the chat open holds a send until it has caught up, and
      // its own reopening loads the chat. One with nothing open sends at once.
      const b = await rig.connect('B')
      const mark = rig.proxy.frames.length
      const after = await startTurn(b, target, 'And now?')
      await b.client.commands.openSession(target.sessionId)
      await finish(rig, b, target, after)
      await until(() => !b.busy(), 'B to finish its open')
      await expectConverges('S17', rig, b)
      // Served by the server's own load: on the new process, the send came
      // before any session.open (the proxy records B's frames in order).
      const requests = rig.proxy.frames
        .slice(mark)
        .filter((frame) => frame.direction === 'up')
        .map((frame) => (frame.json as { name?: string } | undefined)?.name)
        .filter((name) => name === 'turn.send' || name === 'session.open')
      expect(requests[0], 'the send reached the restarted server first').toBe('turn.send')
      recordEvidence({
        scenario: 'S17',
        bucket: 'regression-guard',
        cause: 'the server loads an unloaded chat for any command that needs it',
        observed: { requests },
      })
    },
  )

  /**
   * Guard since F3 (§4.7.5): an open overtaken by a newer open of the same
   * session resolves only once that one has loaded and subscribed the chat.
   * After a reload, the client's own resync reopens its active session once
   * its catalog reads are answered, overtaking the open the user started
   * meanwhile. On main the user's open returned as soon as its own answer
   * landed, before the chat was hydrated or subscribed, so a turn sent then
   * was not owed to the client live (15 times in 15). The gate fixes the
   * order: the user's open goes out before the resync's reads are answered,
   * and is answered after the resync's open began; the resync's open is held
   * until the user's open has had its answer and has been seen not to return.
   */
  scenario(
    'S19 an open overtaken by the client’s own resync open waits for the chat (§4.7.5, guard)',
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
        if (message.name === 'provider.catalog.get' && !holds.has('reads')) return hold('reads')
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
        return undefined
      })
      // A reload: the new client holds the session as its active one, so its
      // resync opens it; the user opens it too, as soon as it is connected.
      const b = await rig.reload(a, 'proxy', 'connected')
      const mark = rig.proxy.frames.length
      let resolvedWith: string | undefined
      const opening = b.client.commands.openSession(target.sessionId).then(() => {
        resolvedWith = b.client.getState().threads[target.threadId]?.hydration ?? 'none'
      })
      await until(() => opens >= 2, 'the resync to open the chat behind the user')
      // The user's open has had its own answer, and still waits.
      const userOpen = rig.proxy.frames
        .slice(mark)
        .find(
          (frame) =>
            frame.direction === 'up' &&
            (frame.json as { name?: string } | undefined)?.name === 'session.open',
        )
      const userRequestId = (userOpen?.json as { requestId?: string } | undefined)?.requestId
      await until(
        () =>
          rig.proxy.frames.some(
            (frame) =>
              frame.direction === 'down' &&
              (frame.json as { requestId?: string } | undefined)?.requestId === userRequestId,
          ),
        "the user's open to be answered",
      )
      await sleep(200)
      expect(resolvedWith, 'the overtaken open waits for the newest one').toBeUndefined()
      release('resync')
      rig.proxy.gate(undefined)
      await opening
      expect(resolvedWith, 'resolved with the chat loaded').toBe('ready')
      // A turn sent now is owed to the client live.
      const turnId = await startTurn(b, target)
      await finish(rig, b, target, turnId)
      await rig.settle()
      await expectConverges('S19', rig, b)
      const liveStarts = rig.framesOf(b).filter((frame) => {
        const event = (
          frame.json as { payload?: { record?: { event?: { name?: string } } } } | undefined
        )?.payload?.record?.event
        return frame.direction === 'down' && event?.name === 'turn.started'
      })
      expect(liveStarts.length, 'turn.started reached B live').toBeGreaterThan(0)
      recordEvidence({
        scenario: 'S19',
        bucket: 'regression-guard',
        cause: 'an overtaken open follows the newest open of its session',
        observed: { sessionOpens: opens, resolvedWith },
      })
    },
  )

  /**
   * Guard since F3 (§4.7.4): a hard crash while the provider creates a session
   * leaves a listed session with no provider identity. Its provider never
   * received anything (no prompt is sent before the identity is durable), so
   * the next open creates the provider session, stamps it before any
   * prompt, and the chat works. On main every open was refused ("The
   * provider session identity is unavailable."), through any number of
   * restarts. A graceful restart never showed it: shutdown waits for starts.
   */
  async function s18Crash(rig: Rig, firstMessage?: string) {
    const a = await rig.connect('A')
    // Announced and durable at once; its provider answers 3 s later.
    const created = await a.client.commands.createSession({
      environmentId: rig.environmentId,
      workspaceId: rig.workspaceId,
      providerId: 'opencode',
      title: 'Interrupted start',
      ...(firstMessage ? { firstMessage } : {}),
    })
    const target = { sessionId: created.session.sessionId, threadId: created.thread.threadId }
    expect(await rig.server.readUnidentified(), 'durable without a provider identity').toContain(
      target.sessionId,
    )
    const before = a.connects
    await rig.crash()
    await until(() => a.connects > before, 'A to reconnect after the crash', 20_000)
    await until(() => !a.busy(), 'A to finish its reconnect')
    await rig.provider({ op: 'setNewSessionDelay', ms: 0 })
    return { a, target }
  }

  scenario(
    'S18 a hard crash while the provider creates the session; the next open starts it (§4.7.4, guard)',
    { newSessionDelayMs: 3_000 },
    async (rig) => {
      const { a, target } = await s18Crash(rig)
      await a.client.commands.openSession(target.sessionId)
      const turnId = await startTurn(a, target, 'Now it starts')
      await finish(rig, a, target, turnId)
      expect(await rig.server.readUnidentified(), 'stamped by the open').not.toContain(
        target.sessionId,
      )
      await expectConverges('S18', rig, a)
    },
  )

  scenario(
    'S18 (first message) the crash takes the first turn; the user sends it again (§4.7.4, guard)',
    { newSessionDelayMs: 3_000 },
    async (rig) => {
      const { a, target } = await s18Crash(rig, 'The first message')
      await a.client.commands.openSession(target.sessionId)
      // Recovery ended the first turn at boot; nothing was replayed to the provider.
      await untilThread(
        a,
        target,
        (state) => state.turns.length === 1 && state.turns[0]!.state === 'interrupted',
        'A to hold the first turn as interrupted',
      )
      const again = await startTurn(a, target, 'The first message')
      await finish(rig, a, target, again)
      expect(await rig.server.readUnidentified()).not.toContain(target.sessionId)
      await expectConverges('S18 (first message)', rig, a)
    },
  )

  /**
   * #219's `waitingOn`: a question outranks a permission, and answering it
   * hands the session back to the permission. Each change rides a
   * `session.updated` whose status does not change (event-repository.ts,
   * `activityChanged`). A sidebar-only client must follow every step.
   */
  /**
   * What a provider lists goes to the browser with the chat open and nowhere
   * else as a chat's: the sidebar's stream names only what a new chat borrows,
   * and a second browser in the sidebar, or a fresh load, ends up the same.
   * A settings change names the settings alone, so a browser that missed one
   * replays it onto the commands it holds and still matches a fresh load.
   */
  scenario('G3 a listing reaches the open chat, not the sidebar (guard)', {}, async (rig) => {
    const a = await rig.connect('A')
    const b = await rig.connect('B')
    const target = await createSession(rig, a, QUIET)
    await until(() => b.client.getState().sessions[target.sessionId], 'B to list the session')
    await startTurn(a, target)
    await rig.provider({ op: 'emitCommands', sessionId: target.sessionId, names: ['review'] })
    await untilThread(
      a,
      target,
      (state) => state.listing.availableCommands?.[0]?.name === 'review',
      'A to hold the listing with the chat',
    )
    const { workspaceId, providerId } = b.client.getState().sessions[target.sessionId]!
    await until(
      () =>
        selectDraftListing(b.client.getState(), 'availableCommands', workspaceId, providerId!)
          ?.length || undefined,
      'B to hold what a new chat here would offer',
    )
    // B has no chat open, so the list reached it only as the workspace's.
    expect(b.client.getState().threads[target.threadId]?.listing ?? {}).toEqual({})
    expect(b.client.getState().sessions[target.sessionId]?.composer ?? {}).not.toHaveProperty(
      'availableCommands',
    )
    // Past a replay: a settings change is the only thing A missed. A long
    // list of commands makes the chat larger than the replay.
    const many = Array.from({ length: 200 }, (_, index) => `command-${index}`)
    await rig.provider({ op: 'emitCommands', sessionId: target.sessionId, names: many })
    await untilThread(a, target, (state) => state.listing.availableCommands?.length === 200, 'A')
    await rig.waitQuiet()
    rig.proxy.down()
    rig.proxy.cut()
    await until(() => a.client.getState().connection.phase !== 'connected', 'A to notice the cut')
    await rig.provider({
      op: 'emitSetting',
      sessionId: target.sessionId,
      settingId: 'effort',
      currentValue: 'high',
    })
    await rig.waitQuiet()
    const mark = rig.proxy.frames.length
    rig.proxy.up()
    await untilThread(
      a,
      target,
      (state) => state.listing.configOptions?.[0]?.id === 'effort',
      'A to replay the settings',
      20_000,
    )
    const replay = threadReplays(rig.proxy.frames.slice(mark), target.threadId)[0]
    const requestId = field(replay?.json, 'requestId')
    const answer = downFrames(rig.proxy.frames.slice(mark)).find(
      (frame) => info(frame).requestId === requestId,
    )
    expect(info(answer).mode, 'a replay of the one change').toBe('replay')
    const records = field(answer?.json, 'payload', 'events') as Array<{
      event: { name: string; payload: Record<string, unknown> }
    }>
    const listing = records.filter((record) => record.event.name === 'thread.listing.updated')
    expect(Object.keys(listing[0]?.event.payload ?? {})).toEqual(['configOptions'])
    expect(a.client.getState().threads[target.threadId]?.listing.availableCommands).toHaveLength(
      200,
    )
    await expectConverges('G3 after a replayed settings change', rig, a)
    // None now: the next chat here offers none, and A's chat shows none.
    await rig.provider({ op: 'emitCommands', sessionId: target.sessionId, names: [] })
    await untilThread(
      a,
      target,
      (state) => state.listing.availableCommands?.length === 0,
      'A to hold the empty listing',
    )
    await expectConverges('G3 chat', rig, a)
    await expectConverges('G3 sidebar', rig, b)
  })

  /**
   * Two chats on one workspace and provider, one with a command the other
   * lacks. The more recently active one holds what a new chat borrows, and
   * the sidebar's stream hears of it once, however often both report.
   */
  scenario('G4 two chats do not trade the workspace listing (guard)', {}, async (rig) => {
    const a = await rig.connect('A')
    const quieter = await createSession(rig, a, QUIET)
    await startTurn(a, quieter)
    const active = await createSession(rig, a, QUIET)
    await startTurn(a, active)
    const { workspaceId, providerId } = a.client.getState().sessions[active.sessionId]!
    const offered = () =>
      selectDraftListing(a.client.getState(), 'availableCommands', workspaceId, providerId!)?.map(
        (command) => command.name,
      )
    const announced = () =>
      rig.proxy.frames.filter(
        (frame) =>
          frame.direction === 'down' &&
          field(frame.json, 'payload', 'record', 'event', 'name') === 'composer.listing.updated',
      ).length

    await rig.waitQuiet()
    const before = announced()
    await rig.provider({
      op: 'emitCommands',
      sessionId: active.sessionId,
      names: ['review', 'extra-mcp'],
    })
    await until(() => offered()?.length === 2 || undefined, 'the active chat to hold the list')
    for (let round = 0; round < 3; round++) {
      await rig.provider({ op: 'emitCommands', sessionId: quieter.sessionId, names: ['review'] })
      await rig.provider({
        op: 'emitCommands',
        sessionId: active.sessionId,
        names: ['review', 'extra-mcp'],
      })
      await rig.waitQuiet()
    }
    expect(offered()).toEqual(['review', 'extra-mcp'])
    expect(announced() - before, 'one announcement, however often both report').toBe(1)
    await expectConverges('G4 sidebar', rig, a)

    // Activity moves the listing, once.
    await rig.provider({ op: 'completeTurn', sessionId: quieter.sessionId })
    await until(
      () => a.client.getState().sessions[quieter.sessionId]?.status === 'idle' || undefined,
      'the quieter chat to finish',
    )
    await startTurn(a, quieter)
    await rig.provider({ op: 'emitCommands', sessionId: quieter.sessionId, names: ['newer'] })
    await until(() => offered()?.[0] === 'newer' || undefined, 'the list to follow the activity')
    await rig.provider({
      op: 'emitCommands',
      sessionId: active.sessionId,
      names: ['review', 'extra-mcp'],
    })
    await rig.waitQuiet()
    expect(offered()).toEqual(['newer'])
    expect(announced() - before, 'and once more').toBe(2)
    await expectConverges('G4 after activity', rig, a)
  })

  scenario('G1 waitingOn follows a question over a permission (#219, guard)', {}, async (rig) => {
    const a = await rig.connect('A')
    const b = await rig.connect('B')
    // Cursor is the provider whose agent asks questions (cursor/ask_question).
    const target = await createSession(rig, a, { providerId: 'cursor', quiet: true })
    // B holds the session, so it knows its provider (not X2's subject here).
    await until(() => b.client.getState().sessions[target.sessionId], 'B to list the session')
    await startTurn(a, target)
    const waitingOn = () => b.client.getState().sessions[target.sessionId]?.waitingOn
    const steps: Array<{ step: string; waitingOn: unknown }> = []
    const settle = async (step: string, expected: string | undefined) => {
      await until(() => waitingOn() === expected || undefined, `B to show waitingOn ${expected}`)
      // Interaction events move sessions.updated_at, and with it the
      // workspace's recency, both announced since F3 (§4.7.1).
      await expectConverges(`G1 ${step} (sidebar)`, rig, b)
      await expectConverges(`G1 ${step} (chat)`, rig, a)
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
      await until(() => b.client.getState().sessions[target.sessionId], 'B to list the session')
      const row = () => b.client.getState().sessions[target.sessionId]
      const steps: Array<{ step: string; status: unknown; inBackground: unknown }> = []
      const settle = async (step: string, status: string, inBackground: true | undefined) => {
        await until(
          () => (row()?.status === status && row()?.inBackground === inBackground) || undefined,
          `B to show ${status}${inBackground ? ', in the background' : ''}`,
        )
        await expectConverges(`G3 ${step} (sidebar)`, rig, b)
        await expectConverges(`G3 ${step} (chat)`, rig, a)
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
   * Persisted drafts and composer preferences (normalize compares both): B
   * follows them live, across a short gap that replays, and across a long one
   * whose catch-up is the whole environment, preferences included, after
   * which drafts are listed again.
   */
  scenario(
    'G2 drafts and composer preferences across both kinds of gap (guard)',
    {},
    async (rig) => {
      const a = await rig.connect('A', { link: 'direct' })
      const b = await rig.connect('B')
      const target = await createSession(rig, a, { title: 'With a draft', quiet: true })
      // Enough sessions that the whole environment is larger than the short
      // gap below, so that gap is replayed (§6.1).
      for (let index = 0; index < 12; index++) {
        await createSession(rig, a, { title: `Filler ${index}`, open: false, quiet: true })
      }
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

      // A long gap: the whole environment is smaller than its replay. It
      // carries the preferences; drafts are listed again.
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
        'snapshot_smaller',
      )
      expect(held()).toEqual({ draft: 'third words', newDraft: undefined, mode: 'plan' })
      driver.dispose()
    },
  )
})
