import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { EVENT_FORMAT_VERSION, ProofEventSchema } from '../src/index.js'

/**
 * The digest of every event schema, per stored-event format version. Change
 * an event schema and this fails: bump `EVENT_FORMAT_VERSION` and add the new
 * digest, so a server whose log holds the old shape raises its replay floors
 * (docs/sync-foundations.md §4.7.7). While a release is unmerged, its pull
 * requests update the digest of the version that release introduces.
 * Refinements are not part of a JSON schema, so a change to a refinement
 * alone needs the bump by hand.
 */
const DIGESTS: Record<number, string> = {
  2: 'e78efd375337c4e2b90f6bcffce9b1f4618173def70e6804f7ef0c96c004a909',
}

function digest(): string {
  const schema = z.toJSONSchema(ProofEventSchema, { unrepresentable: 'any' })
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex')
}

describe('stored event format', () => {
  it('pins the event schemas to EVENT_FORMAT_VERSION', () => {
    expect(digest()).toBe(DIGESTS[EVENT_FORMAT_VERSION])
  })
})
