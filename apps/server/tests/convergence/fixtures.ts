import {
  newestSessionUpdate,
  runtimeStamp,
  sessionCreatedPartial,
  stampMovesRecency,
  workspaceRecencyMirror,
} from './causes.ts'
import type { CauseInstance } from './expectation.ts'
import type { Rig, TestClient } from './harness.ts'
import { mirroredRecency } from './mirror.ts'

/**
 * Expectation factories shared by the scenarios and by checker.test.ts, so
 * the adversarial checks run through exactly the construction a scenario
 * judges with. Every input is captured independently of the result being
 * judged: from frames the server sent (the proxy's recording), the server's
 * own reads, and the fake provider's stamp times.
 */

export interface StampCaptured {
  workspaceId: string
  providerId: string
  /** The `session.created` time the watching client was sent. */
  createdAt: string
  /** When the provider session resolved (the fake provider's clock). */
  stampedAt: number
  /** The workspace recency the client should hold, mirrored from what it was sent. */
  heldRecency: string | null
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
      stampedAt: captured.stampedAt,
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
        stampedAt: captured.stampedAt,
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
        stampedAt: captured.stampedAt,
      }),
      stampMovesRecency({
        workspaceId: captured.workspaceId,
        held: captured.heldRecency,
        stampedAt: captured.stampedAt,
      }),
    ],
  }
}

/**
 * X1 for one client, built after the check: what the client should hold
 * comes from the frames the server sent it, the newest session time from a
 * server read made here, not from the result.
 */
export function recencyMirror(rig: Rig, client: TestClient) {
  return async (): Promise<CauseInstance> => {
    const newest = newestSessionUpdate(await rig.server.readSessions(), rig.workspaceId)
    if (!newest) throw new Error('The workspace has no sessions to take its recency from.')
    return workspaceRecencyMirror({
      workspaceId: rig.workspaceId,
      held: mirroredRecency(rig.framesOf(client), rig.workspaceId),
      newest,
    })
  }
}
