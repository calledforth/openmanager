import { expect, it } from 'vitest'
import { EnvelopeSchema, type Envelope } from '@openmanager/protocol'

it('consumes the shared protocol through its workspace package export', () => {
  const envelope: Envelope = { type: 'response', requestId: 'req-1', payload: null }
  expect(EnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope)
})
