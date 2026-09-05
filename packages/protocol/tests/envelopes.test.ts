import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  CommandEnvelopeSchema,
  ResponseEnvelopeSchema,
  EventEnvelopeSchema,
  ErrorEnvelopeSchema,
  EnvelopeSchema,
  type CommandEnvelope,
  type ResponseEnvelope,
  type EventEnvelope,
  type ErrorEnvelope,
  type Envelope,
} from '@openmanager/protocol'

describe('public envelope schemas', () => {
  const fixtures = [
    { type: 'command', requestId: 'req-1', name: 'example.command', payload: { text: 'hello' } },
    { type: 'response', requestId: 'req-1', payload: null },
    { type: 'event', name: 'example.event', payload: [1, true, null, { text: 'hello' }] },
    { type: 'error', requestId: 'req-1', error: { code: 'example_error', message: 'Example' } },
  ] satisfies Envelope[]

  it.each(fixtures)('validates a JSON-serialized $type envelope', (fixture) => {
    const received: unknown = JSON.parse(JSON.stringify(fixture))
    expect(EnvelopeSchema.parse(received)).toEqual(fixture)
  })

  it.each([
    null,
    [],
    {},
    { type: 'unknown', payload: null },
    { type: 'command', requestId: 123, name: 'example.command', payload: null },
    { type: 'command', requestId: 'req-1', payload: null },
    { type: 'response', payload: null },
    { type: 'event', name: 'example.event' },
    { type: 'event', name: 'example.event', payload: { nested: undefined } },
    { type: 'error', requestId: 'req-1', error: { code: 123, message: 'Example' } },
  ])('rejects malformed envelope %j', (input) => {
    expect(EnvelopeSchema.safeParse(input).success).toBe(false)
  })

  it('exports inferred types for each schema and a discriminated union', () => {
    expectTypeOf(CommandEnvelopeSchema.parse(fixtures[0])).toEqualTypeOf<CommandEnvelope>()
    expectTypeOf(ResponseEnvelopeSchema.parse(fixtures[1])).toEqualTypeOf<ResponseEnvelope>()
    expectTypeOf(EventEnvelopeSchema.parse(fixtures[2])).toEqualTypeOf<EventEnvelope>()
    expectTypeOf(ErrorEnvelopeSchema.parse(fixtures[3])).toEqualTypeOf<ErrorEnvelope>()
    const envelope = EnvelopeSchema.parse(fixtures[0])
    expectTypeOf(envelope).toEqualTypeOf<Envelope>()
    if (envelope.type === 'command') {
      expectTypeOf(envelope).toEqualTypeOf<CommandEnvelope>()
    }
  })
})
