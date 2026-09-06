import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { clientFixtures, serverFixtures } from './fixtures.js'
import { proofCommands, proofResponses, proofEvents } from './proof-fixtures.js'
import { replayResponse, snapshotResponse, subscriptionEvent } from './replay-fixtures.js'

it('bundles the public entry for a browser and validates without Node globals', async () => {
  const result = await build({
    stdin: {
      contents: `
        import { EnvelopeSchema, ClientMessageSchema, ServerMessageSchema } from '@openmanager/protocol'
        import { clientFixtures, serverFixtures } from './tests/fixtures.ts'
        import { ProofCommandSchema, ProofEventSchema, parseProofResult } from '@openmanager/protocol'
        import { proofCommands, proofResponses, proofEvents } from './tests/proof-fixtures.ts'
        globalThis.proofCommands = proofCommands.map(f => ProofCommandSchema.parse(JSON.parse(JSON.stringify(f))))
        globalThis.proofResponses = proofCommands.map(c => parseProofResult(c, JSON.parse(JSON.stringify(proofResponses[c.name]))))
        globalThis.proofEvents = proofEvents.map(f => ProofEventSchema.parse(JSON.parse(JSON.stringify(f))))
        import { parseReplayResult, SubscriptionEventSchema } from '@openmanager/protocol'
        import { replayCommand, replayResponse, snapshotResponse, subscriptionEvent } from './tests/replay-fixtures.ts'
        globalThis.replayResults = [replayResponse, snapshotResponse].map(f => parseReplayResult(replayCommand, JSON.parse(JSON.stringify(f))))
        globalThis.subscriptionEvent = SubscriptionEventSchema.parse(JSON.parse(JSON.stringify(subscriptionEvent)))
        globalThis.clientRoundTrips = clientFixtures.map(f => ClientMessageSchema.parse(JSON.parse(JSON.stringify(f))))
        globalThis.serverRoundTrips = serverFixtures.map(f => ServerMessageSchema.parse(JSON.parse(JSON.stringify(f))))
        globalThis.valid = EnvelopeSchema.safeParse({
          type: 'response', requestId: 'req-1', payload: null,
        }).success
        globalThis.invalid = EnvelopeSchema.safeParse({ type: 'response' }).success
      `,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    metafile: true,
  })

  // No externals or polyfills: a Node builtin import must fail the browser build.
  expect(Object.values(result.metafile!.outputs).flatMap((output) => output.imports)).toEqual([])
  const browserGlobals: Record<string, unknown> = {}
  runInNewContext(result.outputFiles[0].text, browserGlobals)
  expect(browserGlobals.valid).toBe(true)
  expect(browserGlobals.invalid).toBe(false)
  expect(browserGlobals.clientRoundTrips).toEqual(clientFixtures)
  expect(browserGlobals.serverRoundTrips).toEqual(serverFixtures)
  expect(browserGlobals.proofCommands).toEqual(proofCommands)
  expect(browserGlobals.proofResponses).toEqual(proofCommands.map((c) => proofResponses[c.name]))
  expect(browserGlobals.proofEvents).toEqual(proofEvents)
  expect(browserGlobals.replayResults).toEqual([replayResponse, snapshotResponse])
  expect(browserGlobals.subscriptionEvent).toEqual(subscriptionEvent)
})
