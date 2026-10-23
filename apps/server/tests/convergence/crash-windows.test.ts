/**
 * W1-W7, the crash windows (docs/sync-foundations.md §4.4, §4.7.6). Before
 * F3 each of these writes changed a row a client can see, then announced it
 * in a second step, so a crash in between left the row and the event apart.
 * F3 makes each one event whose projection writes the row, in one
 * transaction. Here the server child dies inside that transaction, just
 * before COMMIT or just after it; then:
 *
 *   - the killed process committed the event exactly when it got past COMMIT
 *     (counted in the audit, whose triggers commit with the rows);
 *   - the row says the same: changed after COMMIT, untouched before it;
 *   - a client that held its bookmark across the kill replays to the rows'
 *     state: it converges with a fresh load.
 *
 * W7's root half has no event for the stamp (the identity is host-private):
 * killed just after `session.created` commits, the session is listed with no
 * identity, and the next open creates its provider session and stamps it
 * (§4.7.4). Its child half: a child's identity commits with its row.
 */
import { rm } from 'node:fs/promises'
import { describe, expect } from 'vitest'
import { isDerivedRecord } from '../../src/db/event-repository.ts'
import type { KillAt } from './child-protocol.ts'
import { expectConverges, recordEvidence } from './evidence.ts'
import { until, type ConvergenceResult, type Rig, type TestClient } from './harness.ts'
import { scenario } from './scenario.ts'
import { createSession, startTurn, type Target } from './steps.ts'

type Workspace = { workspaceId: string; name: string; path: string; lastUsedAt: string | null }
type Session = { sessionId: string; parentSessionId?: string; title?: string | null }

const workspaces = (result: ConvergenceResult) =>
  Object.values(result.fresh.workspaces) as Workspace[]
const sessions = (result: ConvergenceResult) => result.fresh.sessions as Session[]

interface Window<C> {
  id: string
  /** The two writes it was before F3. */
  was: string
  /** The commit to die in: its event's name; derived recency records never count. */
  at: Omit<KillAt, 'phase' | 'producer'>
  /** Whatever the trigger needs, done before the kill is armed. */
  prepare: (rig: Rig, a: TestClient) => Promise<C>
  trigger: (rig: Rig, a: TestClient, context: C) => Promise<unknown>
  /**
   * Whether the trigger's write is in the rows after the restart, from the
   * fresh load or the server's own reads. Absent where the restarted server
   * makes the same write again by design (an observation of the folder).
   */
  landed?: (rig: Rig, result: ConvergenceResult, context: C) => Promise<boolean> | boolean
}

const window = <C>(spec: Window<C>) => spec as Window<unknown>

/** A second folder, registered, so the rig's own workspace stays untouched. */
async function second(rig: Rig, a: TestClient) {
  const path = await rig.folder('second')
  const workspace = await a.client.commands.addWorkspace({ path, name: 'Second' })
  await rig.waitQuiet()
  return { path, workspaceId: workspace.workspaceId }
}

const WINDOWS: Window<unknown>[] = [
  window({
    id: 'W1',
    was: 'workspace register: upsert the row, then emit',
    at: { name: 'workspace.updated' },
    prepare: async (rig) => ({ path: await rig.folder('second') }),
    trigger: (_rig, a, { path }) => a.client.commands.addWorkspace({ path }),
    landed: (_rig, result, { path }) => workspaces(result).some((item) => item.path === path),
  }),
  window({
    id: 'W2',
    was: 'workspace rename: write the name, then emit',
    at: { name: 'workspace.updated' },
    prepare: second,
    trigger: (_rig, a, { path }) => a.client.commands.addWorkspace({ path, name: 'Renamed' }),
    landed: (_rig, result, { workspaceId }) =>
      workspaces(result).find((item) => item.workspaceId === workspaceId)?.name === 'Renamed',
  }),
  window({
    id: 'W3',
    was: 'workspace availability: a listing wrote it, then emitted',
    at: { name: 'workspace.updated' },
    prepare: async (rig, a) => {
      const registered = await second(rig, a)
      await rm(registered.path, { recursive: true })
      return registered
    },
    // The workspace.list command observes the folder (§4.7.10); the
    // restarted server's next listing observes it again, so only the killed
    // commit is counted here.
    trigger: (_rig, a) => a.client.commands.listWorkspaces(),
  }),
  window({
    id: 'W4',
    was: 'workspace recency: markUsed wrote last_used_at, then emitted',
    at: { name: 'workspace.updated' },
    prepare: async () => undefined,
    // markUsed runs once the provider session has started, after the
    // session.created commit (whose derived recency does not count).
    trigger: (rig, a) =>
      a.client.commands.createSession({
        environmentId: rig.environmentId,
        workspaceId: rig.workspaceId,
        providerId: 'opencode',
        title: 'Used',
      }),
    landed: (rig, result) =>
      workspaces(result).find((item) => item.workspaceId === rig.workspaceId)?.lastUsedAt !== null,
  }),
  window({
    id: 'W5',
    was: 'workspace removal: DELETE cascaded its sessions, then workspace.removed',
    at: { name: 'workspace.removed' },
    prepare: async (rig, a) => {
      const registered = await second(rig, a)
      const created = await a.client.commands.createSession({
        environmentId: rig.environmentId,
        workspaceId: registered.workspaceId,
        providerId: 'opencode',
        title: 'Goes with it',
      })
      await rig.waitQuiet()
      return { ...registered, sessionId: created.session.sessionId }
    },
    trigger: (_rig, a, { workspaceId }) => a.client.commands.removeWorkspace(workspaceId),
    landed: (_rig, result, { workspaceId, sessionId }) => {
      const gone = !workspaces(result).some((item) => item.workspaceId === workspaceId)
      const sessionGone = !sessions(result).some((item) => item.sessionId === sessionId)
      // Both or neither: the cascade is in the same transaction.
      expect(sessionGone, 'the session goes with its workspace, or neither goes').toBe(gone)
      return gone
    },
  }),
  window({
    id: 'W6',
    was: 'composer preference: the store wrote it on its own connection, then published',
    at: { name: 'composer.preferences.updated' },
    prepare: async () => undefined,
    trigger: (rig, a) =>
      a.client.commands.setComposerPreference({
        workspaceId: rig.workspaceId,
        providerId: 'opencode',
        preference: { modeId: 'plan' },
      }),
    landed: async (rig) => {
      const probe = await rig.connect('probe', { link: 'direct' })
      try {
        const preference = await probe.client.commands.getComposerPreference({
          workspaceId: rig.workspaceId,
          providerId: 'opencode',
        })
        return preference.modeId === 'plan'
      } finally {
        probe.dispose()
      }
    },
  }),
  window({
    id: 'W6 (profile)',
    was: 'provider profile: the store wrote it on its own connection, then published',
    at: { name: 'provider.catalog.updated' },
    prepare: async () => undefined,
    // The first session starts the provider; its handshake writes the profile.
    trigger: (rig, a) =>
      a.client.commands.createSession({
        environmentId: rig.environmentId,
        workspaceId: rig.workspaceId,
        providerId: 'opencode',
        title: 'Starts the provider',
      }),
  }),
  window({
    id: 'W7 (root)',
    was: 'the runtime stamp: a session row, then its identity in a second write',
    at: { name: 'session.created' },
    prepare: async () => undefined,
    trigger: (rig, a) =>
      a.client.commands.createSession({
        environmentId: rig.environmentId,
        workspaceId: rig.workspaceId,
        providerId: 'opencode',
        title: 'Stamped later',
      }),
    landed: async (rig, result) => {
      const session = sessions(result).find((item) => item.title === 'Stamped later')
      if (!session) return false
      // Listed with no identity: the next open starts it and stamps it.
      expect(await rig.server.readUnidentified()).toContain(session.sessionId)
      const probe = await rig.connect('probe', { link: 'direct' })
      try {
        await probe.client.commands.openSession(session.sessionId)
        await until(
          async () => !(await rig.server.readUnidentified()).includes(session.sessionId),
          'the opened session to be stamped',
        )
      } finally {
        probe.dispose()
      }
      return true
    },
  }),
  window({
    id: 'W7 (child)',
    was: 'the runtime stamp: a child row, then its identity in a second write',
    at: { name: 'session.created' },
    prepare: async (rig, a): Promise<Target> => {
      const parent = await createSession(rig, a, { quiet: true })
      await startTurn(a, parent)
      await rig.waitQuiet()
      return parent
    },
    trigger: (rig, _a, parent) =>
      rig.provider({
        op: 'emitSubtask',
        sessionId: parent.sessionId,
        toolCallId: 'task-w7',
        childProviderSessionId: 'fake-child-w7',
      }),
    landed: async (rig, result, parent) => {
      const child = sessions(result).find((item) => item.parentSessionId === parent.sessionId)
      // A child is never durable without the identity it resumes by.
      if (child) expect(await rig.server.readUnidentified()).not.toContain(child.sessionId)
      return child !== undefined
    },
  }),
]

/** Producer events named `name` the audit holds after `from` and before `to`. */
async function committed(rig: Rig, name: string, from: number, to = Infinity) {
  const audit = await rig.server.readAudit()
  return audit.filter(
    (row) =>
      row.kind === 'event' &&
      row.name === name &&
      !isDerivedRecord(row) &&
      row.seq > from &&
      row.seq < to,
  ).length
}

describe('the crash windows (W1-W7)', () => {
  for (const spec of WINDOWS) {
    for (const phase of ['before', 'after'] as const) {
      scenario(`${spec.id} a kill ${phase} the commit (${spec.was})`, {}, async (rig) => {
        const a = await rig.connect('A')
        const context = await spec.prepare(rig, a)
        await rig.waitQuiet()
        const audit = await rig.server.readAudit()
        const mark = audit.at(-1)?.seq ?? 0
        const reconnects = a.connects
        await rig.killAtCommit({ phase, ...spec.at, producer: true }, () =>
          spec.trigger(rig, a, context),
        )
        await until(() => a.connects > reconnects, 'A to reconnect after the kill', 20_000)
        await until(() => !a.busy(), 'A to finish its reconnect')
        await rig.waitQuiet()
        // What the killed process committed: everything before the next boot's marker.
        const restartedAt = (await rig.server.readAudit()).find(
          (row) => row.kind === 'start' && row.seq > mark,
        )?.seq
        expect(restartedAt, 'the restarted boot marks the audit').toBeDefined()
        const logged = await committed(rig, spec.at.name, mark, restartedAt)
        expect(logged, `its ${spec.at.name} in the log`).toBe(phase === 'after' ? 1 : 0)
        const result = await expectConverges(`${spec.id} ${phase}`, rig, a)
        const landed = spec.landed ? await spec.landed(rig, result, context) : undefined
        if (landed !== undefined) expect(landed, 'its row').toBe(phase === 'after')
        recordEvidence({
          scenario: `${spec.id} ${phase}`,
          bucket: 'regression-guard',
          cause: 'the row and its event commit together',
          observed: {
            logged,
            landed: landed ?? 'not checked: the restarted server writes it again',
          },
        })
      })
    }
  }
})
