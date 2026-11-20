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
  3: 'aacc3c1f5b28c3841fa17ad267ac201198a6f90c27e0d5c6ab67167d590b6f1b',
  4: '0fb7c5196f015ddbd89fe0f77c9fbd745c82d9f590f14ddfaaf089ff2fdaba50',
  5: '77248c02e83232f830b7a1109488cd10d8e729144cc55896fb627d58fcb45050',
  6: '4ff6cd9a0f30930bcfc013a9457072663b582045aa1f699261dc3959398cc800',
  7: 'effc80fe5ebfaf4ca8ee14e4037126a6bfe30e83311b1c73f4bcbf5deffdaa05',
  8: '250f3a09c364077257a568826307fbf1b0a6238b1bf5f2745a2c07f1792da41b',
  9: 'a4881b10f40f36e1f4d604a1513bb36f872aff0e113ca7759b0ea9ae216deea5',
  10: '9df4a23c5b3078b3ef38923e60f7ec1eed00cde1a3a5bfb5626935dffe3b87e2',
  11: '509658b191e4f8cced143329cb6cf05cc97983fc1c0672bd0bfa9b7c29af79db',
  12: '6efc51599496585287b76287a211f1548cdf4cbb4e912b689d4c6b477fce390f',
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
