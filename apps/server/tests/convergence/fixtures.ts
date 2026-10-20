import {
  runtimeStamp,
  sessionCreatedPartial,
  stampMovesRecency,
  workspaceRecencyMirror,
  type Witness,
} from './causes.ts'
import type { CauseInstance } from './expectation.ts'
import type { Rig, TestClient } from './harness.ts'
import { mirroredRecency } from './mirror.ts'

/**
 * Expectation factories shared by the scenarios and by checker.test.ts, so
 * the adversarial checks run through exactly the construction a scenario
 * judges with. Every input is captured independently of the result being
 * judged: from frames the server sent (the proxy's recording), and from the
 * server's write and event provenance (provenance.ts), read after the check.
 */

export interface StampCaptured {
  workspaceId: string
  providerId: string
  /** The `session.created` time the watching client was sent. */
  createdAt: string
  /** The workspace recency the client should hold, mirrored from what it was sent. */
  heldRecency: string | null
  witness: Witness
}

/** S8: the stamp moves the new session's time and the sidebar order. */
export function s8Causes(captured: StampCaptured & { olderId: string; newId: string }): {
  primary: CauseInstance
  residuals: CauseInstance[]
} {
  return {
    primary: runtimeStamp({
      sessionId: captured.newId,
      heldUpdatedAt: captured.createdAt,
      witness: captured.witness,
      order: {
        held: [captured.olderId, captured.newId],
        stamped: [captured.newId, captured.olderId],
      },
    }),
    residuals: [
      // B heard of both sessions only through session.created (X2).
      sessionCreatedPartial({
        sessionIds: [captured.olderId, captured.newId],
        providerId: captured.providerId,
      }),
      // The stamp moves the workspace's recency too, if it lands in a later
      // millisecond than the last value the client was sent.
      stampMovesRecency({
        workspaceId: captured.workspaceId,
        held: captured.heldRecency,
        witness: captured.witness,
      }),
    ],
  }
}

/** X2: a client that only heard session.created lacks the provider; nothing follows, so the stamp shows. */
export function x2Causes(captured: StampCaptured & { sessionId: string }): {
  primary: CauseInstance
  residuals: CauseInstance[]
} {
  return {
    primary: sessionCreatedPartial({
      sessionIds: [captured.sessionId],
      providerId: captured.providerId,
    }),
    residuals: [
      runtimeStamp({
        sessionId: captured.sessionId,
        heldUpdatedAt: captured.createdAt,
        witness: captured.witness,
      }),
      stampMovesRecency({
        workspaceId: captured.workspaceId,
        held: captured.heldRecency,
        witness: captured.witness,
      }),
    ],
  }
}

/** The provenance and one client's wire, read now (after the check they judge). */
export async function witnessOf(rig: Rig, client: TestClient): Promise<Witness> {
  return { provenance: await rig.provenance(), wire: rig.wireOf(client) }
}

/**
 * X1 for one client, built after the check: what the client should hold
 * comes from the frames the server sent it, and the cause from provenance.
 */
export function recencyMirror(rig: Rig, client: TestClient) {
  return async (): Promise<CauseInstance> =>
    workspaceRecencyMirror({
      workspaceId: rig.workspaceId,
      held: mirroredRecency(rig.framesOf(client), rig.workspaceId),
      witness: await witnessOf(rig, client),
    })
}
