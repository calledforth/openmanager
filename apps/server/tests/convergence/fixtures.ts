import type { Witness } from './causes.ts'
import type { Rig, TestClient } from './harness.ts'

/**
 * What scenarios read of the server beside the views they judge, captured
 * independently of the result: the server's write and event provenance
 * (provenance.ts), read after the check, and one client's wire.
 *
 * Until F3 this also built the S8, X2 and X1 expectations (the runtime
 * stamp, the partial `session.created` and the workspace recency mirror);
 * those causes are fixed, and their scenarios are guards.
 */

/** The provenance and one client's wire, read now (after the check they judge). */
export async function witnessOf(rig: Rig, client: TestClient): Promise<Witness> {
  return { provenance: await rig.provenance(), wire: rig.wireOf(client) }
}
