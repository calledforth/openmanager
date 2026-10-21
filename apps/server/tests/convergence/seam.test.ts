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
})
