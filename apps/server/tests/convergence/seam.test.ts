/**
 * The crash-window seam itself (docs/sync-foundations.md §4.7.6): a kill
 * armed at an event-log commit lands inside that commit. Before COMMIT,
 * neither the rows nor the events exist after the restart; after COMMIT,
 * both do, and a client that never heard the event converges anyway.
 * The W tests build on this; here it is checked on the commit every
 * session starts with.
 */
import { describe, expect } from 'vitest'
import { expectConverges, recordEvidence } from './evidence.ts'
import { until, type Rig } from './harness.ts'
import { scenario } from './scenario.ts'
import { createSession, startTurn, thread, type Target } from './steps.ts'

async function sessionIds(rig: Rig) {
  const sessions = (await rig.server.readSessions()) as Array<{ sessionId: string }>
  return new Set(sessions.map((session) => session.sessionId))
}

async function loggedCreations(rig: Rig) {
  const audit = await rig.server.readAudit()
  return audit.filter((row) => row.kind === 'event' && row.name === 'session.created').length
}

describe('the crash-window seam', () => {
  for (const phase of ['before', 'after'] as const) {
    scenario(`seam: a kill ${phase} the commit that creates a session`, {}, async (rig) => {
      const a = await rig.connect('A')
      const sessionsBefore = await sessionIds(rig)
      const createdBefore = await loggedCreations(rig)
      const reconnects = a.connects
      await rig.killAtCommit({ phase, name: 'session.created' }, () =>
        a.client.commands.createSession({
          environmentId: rig.environmentId,
          workspaceId: rig.workspaceId,
          providerId: 'opencode',
          title: 'Across the kill',
        }),
      )
      await until(() => a.connects > reconnects, 'A to reconnect after the kill', 20_000)
      await until(() => !a.busy(), 'A to finish its reconnect')
      const sessionsAfter = await sessionIds(rig)
      const added = [...sessionsAfter].filter((id) => !sessionsBefore.has(id))
      const createdAfter = await loggedCreations(rig)
      if (phase === 'before') {
        expect(added, 'no session row').toEqual([])
        expect(createdAfter, 'no session.created in the log').toBe(createdBefore)
      } else {
        expect(added, 'the session row').toHaveLength(1)
        expect(createdAfter, 'its session.created in the log').toBe(createdBefore + 1)
      }
      await expectConverges(`seam ${phase}`, rig, a)
      recordEvidence({
        scenario: `seam ${phase}`,
        bucket: 'regression-guard',
        cause: 'the kill lands inside the armed commit',
        observed: { added: added.length, logged: createdAfter - createdBefore },
      })
    })
  }

  /**
   * §4.1 (e), a crash during recovery: the turns already ended stay ended,
   * and the next boot recovers the rest. Two turns are left open by a crash;
   * the next boot dies inside its first recovery transaction, just after
   * COMMIT (one turn ended) or just before it (none); the boot after that
   * ends what is left. Each turn is ended exactly once, and a client that
   * held its cursors from before the first crash converges.
   */
  for (const phase of ['after', 'before'] as const) {
    scenario(`seam: a kill ${phase} a boot recovery commit`, {}, async (rig) => {
      const a = await rig.connect('A')
      const targets: Target[] = []
      const turns: string[] = []
      for (const index of [0, 1]) {
        const target = await createSession(rig, a, { quiet: true, title: `Open ${index}` })
        targets.push(target)
        turns.push(await startTurn(a, target))
      }
      await rig.waitQuiet()
      const reconnects = a.connects
      await rig.restartKilledAtBoot({ phase, name: 'turn.interrupted' }, { crash: true })
      await until(() => a.connects > reconnects, 'A to reconnect after the boots', 20_000)
      await until(() => !a.busy(), 'A to finish its reconnect')

      // Which boot wrote each turn's end: the audit marks every boot's start.
      const audit = await rig.server.readAudit()
      const starts = audit.filter((row) => row.kind === 'start').map((row) => row.seq)
      expect(starts.length, 'the killed boot and the one after it').toBeGreaterThanOrEqual(2)
      const killedBoot = starts.at(-2)!
      const lastBoot = starts.at(-1)!
      const ends = turns.map((turnId) =>
        audit.filter((row) => row.kind === 'event' && row.eventId === `recover:${turnId}`),
      )
      for (const [index, rows] of ends.entries()) {
        expect(rows, `turn ${index} ended exactly once`).toHaveLength(1)
      }
      const inKilledBoot = ends.filter(([row]) => row!.seq > killedBoot && row!.seq < lastBoot)
      const inLastBoot = ends.filter(([row]) => row!.seq > lastBoot)
      expect(
        [inKilledBoot.length, inLastBoot.length],
        phase === 'after'
          ? 'the killed boot committed one turn; the next boot ended the other'
          : 'the killed boot committed nothing; the next boot ended both',
      ).toEqual(phase === 'after' ? [1, 1] : [0, 2])

      const views = await Promise.all(
        targets.map((target) => rig.server.readThread(target.sessionId, target.threadId)),
      )
      for (const [index, view] of views.entries()) {
        expect(view.turns, `turn ${index}`).toContainEqual(
          expect.objectContaining({ turnId: turns[index], state: 'interrupted' }),
        )
      }
      // A held the open chat's cursor from before the first crash.
      const active = targets.at(-1)!
      expect(thread(a, active)?.turns.find((turn) => turn.turnId === turns.at(-1))?.state).toBe(
        'interrupted',
      )
      await expectConverges(`seam recovery ${phase}`, rig, a)
      recordEvidence({
        scenario: `seam recovery ${phase}`,
        bucket: 'regression-guard',
        cause: 'a crash during recovery leaves done turns done; the next boot ends the rest',
        observed: { inKilledBoot: inKilledBoot.length, inLastBoot: inLastBoot.length },
      })
    })
  }
})
