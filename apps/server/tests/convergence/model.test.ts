/**
 * Seeded model-based runs (§8.3): a PRNG picks 20–40 operations from a
 * weighted alphabet, with preconditions checked against a tiny model of what
 * should be true. The property is checked after every `check` and at the end.
 *
 * On main the property fails for documented reasons (causes.ts) in most
 * runs. A check passes when the client converged, or when every entry of its
 * diff is explained by a known cause; anything else is a divergence nobody
 * documented, and the run fails with its seed and operation list so it can
 * be replayed as a scripted test. Each phase that fixes a cause removes it
 * from the catalog, and the same seeds then hold it to the property.
 *
 * Seeds: CONVERGENCE_SEEDS=1,2,3 picks them; otherwise the fixed CI set, or
 * the larger nightly set in `--mode nightly`.
 */
import { describe, it } from 'vitest'
import { classify, type RunContext } from './causes.ts'
import { describeDiff } from './normalize.ts'
import {
  prng,
  report,
  Rig,
  sleep,
  until,
  type ConvergenceResult,
  type TestClient,
} from './harness.ts'
import { NIGHTLY } from './scenario.ts'
import { recordEvidence } from './evidence.ts'
import { createSession, startTurn, type Target } from './steps.ts'

const CI_SEEDS = [1, 2, 3]
const NIGHTLY_SEEDS = Array.from({ length: 20 }, (_, index) => index + 1)
const SEEDS = process.env.CONVERGENCE_SEEDS
  ? process.env.CONVERGENCE_SEEDS.split(',').map(Number)
  : NIGHTLY
    ? NIGHTLY_SEEDS
    : CI_SEEDS

interface TurnModel {
  turnId: string
  openTools: string[]
  permission: boolean
}

interface SessionModel extends Target {
  turn: TurnModel | null
  /**
   * The server restarted since this client last opened the session. A
   * WORKAROUND, not a fix: a restarted server serves `turn.send` only for
   * threads `session.open` restored, and a reconnecting client does not open
   * its session again (websocket.ts:1073-1083), so the send fails "Thread not
   * found" until the user reopens it. That is a known divergence of its own,
   * demonstrated by S17 (scenarios.test.ts), which F3 fixes; until then the
   * model reopens first, as the user has to. Note what this hides: the runs
   * do not exercise sending into a chat that was open across a restart.
   */
  stale: boolean
  /**
   * The server went down before this session's provider answered
   * `session/new` (the delayed provider), so no provider session was ever
   * stamped on its row. After the restart the server refuses to send or open
   * it ("The provider session identity is unavailable"): a finding outside
   * the sync property, recorded in the summary. The model leaves it alone.
   */
  orphaned: boolean
}

interface Model {
  sessions: SessionModel[]
  active: SessionModel | null
  /**
   * A provider process that crashed marks the provider unhealthy, and the
   * server then refuses `session.create`, `session.open` and `turn.send` for
   * it ("Provider is unhealthy") until a probe says otherwise. Probes are off
   * here, so only a new server process (restart, crash) makes it usable
   * again. Out of F2's scope (a provider-availability issue, raised
   * separately): the model stops creating, opening, sending and checking
   * while it lasts, because a fresh load cannot open the chat then.
   */
  providerHealthy: boolean
}

type Op =
  | 'createSession'
  | 'openSession'
  | 'sendTurn'
  | 'emitText'
  | 'emitThought'
  | 'openTool'
  | 'finishTool'
  | 'askPermission'
  | 'answerPermission'
  | 'completeTurn'
  | 'interruptTurn'
  | 'crashProvider'
  | 'renameSession'
  | 'deleteSession'
  | 'cut'
  | 'outage'
  | 'hiccup'
  | 'slowLink'
  | 'slowProvider'
  | 'reload'
  | 'restart'
  | 'crashServer'
  | 'check'

const running = (model: Model) => model.active?.turn ?? null

/** What may run now, with its weight. */
function alphabet(model: Model): Array<[Op, number]> {
  const turn = running(model)
  const ops: Array<[Op, number]> = []
  // An unhealthy provider refuses creates, opens and sends alike.
  if (model.providerHealthy) {
    if (model.sessions.length < 5) ops.push(['createSession', model.sessions.length === 0 ? 10 : 2])
    if (model.sessions.filter((session) => !session.orphaned).length >= 2)
      ops.push(['openSession', 1])
  }
  if (model.active && !model.active.orphaned && !turn && model.providerHealthy) {
    ops.push(['sendTurn', 4])
  }
  if (turn) {
    ops.push(['emitText', 3], ['emitThought', 2], ['openTool', 1], ['completeTurn', 2])
    ops.push(['interruptTurn', 0.5], ['crashProvider', 0.3])
    if (turn.openTools.length) ops.push(['finishTool', 1])
    if (!turn.permission) ops.push(['askPermission', 0.7])
    else ops.push(['answerPermission', 1])
  }
  if (model.active) ops.push(['renameSession', 0.7])
  if (model.sessions.some((session) => session !== model.active && !session.turn)) {
    ops.push(['deleteSession', 0.4])
  }
  ops.push(['cut', 0.7], ['outage', 0.7], ['hiccup', 0.4], ['slowLink', 0.4], ['reload', 0.6])
  ops.push(['slowProvider', 0.6])
  ops.push(['restart', 0.3], ['crashServer', 0.3], ['check', 1.5])
  return ops
}

function pick(random: () => number, ops: Array<[Op, number]>): Op {
  const total = ops.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = random() * total
  for (const [op, weight] of ops) {
    roll -= weight
    if (roll <= 0) return op
  }
  return ops.at(-1)![0]
}

class ModelRun {
  readonly log: string[] = []
  readonly known = new Set<string>()
  checks = 0
  /** The fake provider's current `session/new` delay; a restart resets it to 0. */
  delayMs = 0
  /** When each restart came back. */
  private readonly restarts: number[] = []
  /** Stamp times from every server generation (orphan bookkeeping only). */
  private readonly stamps: Record<string, number> = {}
  skippedChecks = 0
  private a!: TestClient
  private readonly model: Model = { sessions: [], active: null, providerHealthy: true }
  private renames = 0

  constructor(
    private readonly rig: Rig,
    private readonly seed: number,
  ) {}

  async start() {
    this.a = await this.rig.connect('A')
  }

  private async connected() {
    await until(
      () => this.a.client.getState().connection.phase === 'connected',
      'A to be connected',
      30_000,
    )
  }

  private provider(op: Parameters<Rig['provider']>[0]) {
    return this.rig.provider(op)
  }

  /** After a restart or crash, no turn is running anywhere and the provider is new. */
  /** Keep the stamp times of this server generation; a crash would lose them. */
  private async collectStamps() {
    Object.assign(this.stamps, await this.rig.server.readStamps())
  }

  private forgetTurns() {
    this.model.providerHealthy = true
    // A new process starts from the rig's configured delay (none).
    this.delayMs = 0
    for (const session of this.model.sessions) {
      if (this.stamps[session.sessionId] === undefined) session.orphaned = true
      session.turn = null
      session.stale = true
    }
  }

  /** Run `change`, then wait until A has noticed and connected again. */
  private async reconnectAfter(change: () => void | Promise<void>) {
    const before = this.a.connects
    await change()
    await until(() => this.a.connects > before, 'A to reconnect', 30_000)
  }

  async apply(op: Op, random: () => number): Promise<void> {
    const model = this.model
    const active = model.active
    const turn = running(model)
    switch (op) {
      case 'createSession': {
        await this.connected()
        // Not quiet: the session is announced at once and its provider
        // resolves (and stamps the row) later, racing what comes next.
        const target = await createSession(this.rig, this.a, {
          title: `Model ${model.sessions.length}`,
          quiet: false,
        })
        const session = { ...target, turn: null, stale: false, orphaned: false }
        model.sessions.push(session)
        model.active = session
        await this.collectStamps()
        return
      }
      case 'openSession': {
        await this.connected()
        const others = model.sessions.filter((session) => session !== active && !session.orphaned)
        const next = others[Math.floor(random() * others.length)]!
        await this.a.client.commands.openSession(next.sessionId)
        next.stale = false
        model.active = next
        return
      }
      case 'sendTurn': {
        await this.connected()
        if (active!.stale) {
          await this.a.client.commands.openSession(active!.sessionId)
          active!.stale = false
        }
        const turnId = await startTurn(this.a, active!, `Prompt ${this.log.length}`)
        active!.turn = { turnId, openTools: [], permission: false }
        return
      }
      case 'emitText':
        await this.provider({
          op: 'emitText',
          sessionId: active!.sessionId,
          text: `Text ${this.log.length}. `,
        })
        return
      case 'emitThought':
        await this.provider({
          op: 'emitThought',
          sessionId: active!.sessionId,
          text: `Thought ${this.log.length}`,
        })
        return
      case 'openTool': {
        const toolCallId = `tool-${this.seed}-${this.log.length}`
        await this.provider({ op: 'openTool', sessionId: active!.sessionId, toolCallId })
        turn!.openTools.push(toolCallId)
        return
      }
      case 'finishTool': {
        const toolCallId = turn!.openTools.shift()!
        await this.provider({
          op: 'updateTool',
          sessionId: active!.sessionId,
          toolCallId,
          status: 'completed',
        })
        return
      }
      case 'askPermission':
        await this.provider({
          op: 'askPermission',
          sessionId: active!.sessionId,
          toolCallId: `edit-${this.seed}-${this.log.length}`,
        })
        turn!.permission = true
        return
      case 'answerPermission': {
        await this.connected()
        const pending = await until(
          () => this.a.client.getState().threads[active!.threadId]?.interactions[0],
          'A to show the pending question',
        )
        await this.a.client.commands
          .respondToInteraction({
            ...active!,
            response: {
              kind: 'permission',
              interactionId: pending.interaction.interactionId,
              outcome: { outcome: 'selected', optionId: 'allow' },
            },
          })
          .catch(() => undefined)
        turn!.permission = false
        return
      }
      case 'completeTurn':
        await this.provider({ op: 'completeTurn', sessionId: active!.sessionId })
        active!.turn = null
        return
      case 'interruptTurn':
        await this.connected()
        await this.a.client.commands
          .interruptTurn({ ...active!, turnId: turn!.turnId })
          .catch(() => undefined)
        active!.turn = null
        return
      case 'crashProvider':
        await this.provider({ op: 'crashProvider', sessionId: active!.sessionId })
        active!.turn = null
        model.providerHealthy = false
        return
      case 'renameSession':
        await this.connected()
        await this.a.client.commands.renameSession(active!.sessionId, `Renamed ${++this.renames}`)
        return
      case 'deleteSession': {
        await this.connected()
        const idle = model.sessions.filter((session) => session !== active && !session.turn)
        const gone = idle[Math.floor(random() * idle.length)]!
        await this.a.client.commands.deleteSession(gone.sessionId)
        model.sessions = model.sessions.filter((session) => session !== gone)
        return
      }
      case 'cut':
        await this.reconnectAfter(() => this.rig.proxy.cut())
        return
      case 'outage': {
        // The link is down while the server keeps working.
        const before = this.a.connects
        this.rig.proxy.down()
        this.rig.proxy.cut()
        if (turn) {
          for (let index = 0; index < 3; index++) {
            await this.provider({
              op: 'emitText',
              sessionId: active!.sessionId,
              text: `Missed ${index}. `,
            })
          }
        }
        await this.rig.waitQuiet()
        this.rig.proxy.up()
        await until(() => this.a.connects > before, 'A to reconnect', 30_000)
        return
      }
      case 'hiccup':
        this.rig.proxy.blackhole()
        await sleep(1_500)
        this.rig.proxy.unblackhole()
        return
      case 'slowProvider': {
        // A controlled delayed provider: later creations announce the
        // session at once and resolve (and stamp) this much later, so the
        // stamp races whatever comes next: turns, reconnects, restarts.
        const delays = [0, 150, 600]
        const ms = delays[Math.floor(random() * delays.length)]!
        await this.rig.provider({ op: 'setNewSessionDelay', ms })
        this.delayMs = ms
        this.log[this.log.length - 1] = `slowProvider ${ms}`
        return
      }
      case 'slowLink':
        this.rig.proxy.throttle('down', 20_000, 64 * 1024)
        if (turn) {
          await this.provider({
            op: 'emitText',
            sessionId: active!.sessionId,
            text: 'y'.repeat(30_000),
          })
        }
        await this.rig.waitQuiet()
        this.rig.proxy.heal()
        return
      case 'reload':
        // Not waiting for its resync: a reload's own open of the active
        // session races what comes next, as it does for a user (S19).
        this.a = await this.rig.reload(this.a, 'proxy', 'connected')
        // A reload opens its active session again; the others stay as they were.
        if (active) active.stale = false
        return
      case 'restart':
        await this.collectStamps()
        await this.reconnectAfter(async () => {
          await this.rig.restart()
          this.restarts.push(Date.now())
        })
        this.forgetTurns()
        return
      case 'crashServer':
        await this.reconnectAfter(async () => {
          await this.rig.crash()
          this.restarts.push(Date.now())
        })
        this.forgetTurns()
        return
      case 'check':
        await this.check()
        return
    }
  }

  /**
   * One round first: if it converged, or only known causes explain the diff,
   * the run goes on (a known cause is permanent by definition). Otherwise the
   * whole eventual window is given before calling it a new divergence.
   */
  async check(): Promise<void> {
    // With the provider unhealthy, `session.open` is refused, so a fresh load
    // cannot open the chat at all and there is nothing to compare with.
    if (!this.model.providerHealthy || this.model.active?.orphaned) {
      // An orphaned session cannot be opened at all, by a fresh load either.
      this.skippedChecks += 1
      return
    }
    this.checks += 1
    await this.connected()
    // The context is read after each convergence read, never before: settling
    // can finish a provider creation (and its stamp) after any earlier read.
    const judge = async (checked: ConvergenceResult) => {
      const context: RunContext = {
        witness: { provenance: await this.rig.provenance(), wire: this.rig.wireOf(this.a) },
        restarts: this.restarts,
      }
      return classify(checked, context)
    }
    const unknown = (classified: Awaited<ReturnType<typeof judge>>) =>
      classified.filter(({ cause }) => cause === undefined).map(({ entry }) => entry)
    let result = await this.rig.checkConvergence(this.a, { timeoutMs: 1 })
    let classified = await judge(result)
    if (!result.converged && unknown(classified).length > 0) {
      result = await this.rig.checkConvergence(this.a)
      classified = await judge(result)
    }
    if (result.converged) return
    const unexplained = unknown(classified)
    if (unexplained.length > 0) {
      throw new Error(
        `Seed ${this.seed} diverged for a reason no known cause explains, after:\n` +
          `${JSON.stringify(this.log)}\n` +
          `Unexplained:\n${describeDiff(unexplained)}\n${report(result)}`,
      )
    }
    for (const { cause } of classified) if (cause) this.known.add(cause)
  }

  async run(): Promise<void> {
    const random = prng(this.seed)
    const length = 20 + Math.floor(random() * 21)
    for (let step = 0; step < length; step++) {
      const op = pick(random, alphabet(this.model))
      this.log.push(op)
      try {
        await this.apply(op, random)
        // Every generation's stamp times, before a crash can lose them.
        await this.collectStamps().catch(() => undefined)
      } catch (error) {
        if (error instanceof Error) {
          error.message = `Seed ${this.seed}, step ${step} (${op}) after ${JSON.stringify(this.log)}: ${error.message}`
        }
        throw error
      }
    }
    if (!this.model.providerHealthy) {
      // A new server process forgets the crash; then the final check can run.
      this.log.push('restart')
      await this.apply('restart', random)
    }
    this.log.push('check')
    await this.check()
  }
}

describe('seeded model-based runs', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, { timeout: 600_000 }, async () => {
      const started = performance.now()
      const rig = await Rig.create()
      try {
        const run = new ModelRun(rig, seed)
        await run.start()
        await run.run()
        recordEvidence({
          scenario: `model seed ${seed}`,
          bucket: 'regression-guard',
          cause: 'model run',
          observed: {
            operations: run.log,
            checks: run.checks,
            skippedChecks: run.skippedChecks,
            knownCauses: [...run.known],
            durationMs: Math.round(performance.now() - started),
          },
        })
      } catch (error) {
        if (error instanceof Error) {
          error.message += `\n--- server child output (tail) ---\n${rig.server.diagnostics()}`
        }
        throw error
      } finally {
        await rig.dispose()
      }
    })
  }
})
